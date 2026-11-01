/**
 * Offline checks for the shared sync engine (Pulsar-Sync/drive-sync.js) on
 * Android and on the desktop adapter (Pulsar-Sync/desktop-cloud-sync.js).
 *
 *   node Pulsar-Sync/tools/test_drive_sync.js
 *
 * No device, no Google account and no network are involved: the script loads
 * drive-sync.js in a VM with a fake Capacitor plugin (in-memory Drive), a fake
 * library runtime and a fake IndexedDB. It checks the parts that would be
 * expensive to discover on a phone: that only metadata leaves the device, how
 * two devices merge, and that deletions never delete audio without asking.
 */
const fsSource = require('fs');
const path = require('path');
const vm = require('vm');

const { makeSettingsDom, makeDocument } = require('./fake_dom.js');

const SOURCE = path.join(__dirname, '..', 'drive-sync.js');
const HOOKS = path.join(__dirname, '..', 'cloud_sync_hooks.js');
const DESKTOP_ADAPTER = path.join(__dirname, '..', 'desktop-cloud-sync.js');

// ------------------------------------------------------------------ fake IDB

function makeIndexedDb() {
  const stores = new Map();
  function area(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }
  // Requests resolve on a timer, exactly like the real IndexedDB: the engine
  // attaches onsuccess/onerror after the call returns.
  function deliver(request) {
    setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
    return request;
  }
  function makeStore(storeName) {
    return {
      get(key) { return deliver({ result: area(storeName).get(key) }); },
      put(value) { area(storeName).set(value.id, value); return deliver({ result: true }); },
      getAll() { return deliver({ result: Array.from(area(storeName).values()) }); },
      clear() { area(storeName).clear(); return deliver({ result: true }); },
    };
  }
  let upgradeDone = false;
  return {
    open() {
      const request = { result: null };
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: (name) => stores.has(name) },
          createObjectStore: (name) => { stores.set(name, new Map()); },
          transaction: (_name, _mode) => ({ objectStore: (store) => makeStore(store) }),
        };
        if (request.onupgradeneeded && !upgradeDone) { upgradeDone = true; request.onupgradeneeded(); }
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
}

// ------------------------------------------------------- fake biblioteka runtime

function makeLibrary(tracks, albums) {
  const state = { tracks: tracks, albums: albums };
  return {
    state,
    snapshot() {
      return {
        tracks: state.tracks.map((track) => ({
          key: track.netId || ('fp:' + track.size + ':' + track.hash),
          title: track.title,
          artist: track.artist,
          album: track.album || '',
          year: track.year || '',
          provider: track.netId ? track.netId.split(':')[0] : '',
          ytId: track.netId && track.netId.startsWith('youtube:') ? track.netId.slice(8) : '',
          durMs: track.durMs || 0,
          fav: !!track.fav,
          plays: track.plays || 0,
          lastPlay: track.lastPlay || 0,
        })),
        albums: state.albums.map((album) => ({
          key: album.key,
          name: album.name,
          cover: '',
          createdAt: album.createdAt || 0,
          trackKeys: album.trackKeys || [],
        })),
      };
    },
    apply(plan) {
      const applied = { tracks: 0, albums: 0 };
      plan.trackUpdates.forEach((update) => {
        const key = update.key;
        const target = state.tracks.find((track) => (track.netId || ('fp:' + track.size + ':' + track.hash)) === key);
        if (!target) return;
        Object.assign(target, update.fields);
        applied.tracks++;
      });
      plan.newAlbums.forEach((album) => {
        state.albums.push({ key: album.key, name: album.name, trackKeys: album.trackKeys });
        applied.albums++;
      });
      plan.albumUpdates.forEach((update) => {
        const album = state.albums.find((entry) => entry.key === update.key);
        if (!album) return;
        album.trackKeys = update.trackKeys;
        applied.albums++;
      });
      return applied;
    },
  };
}

// ------------------------------------------------------------- fake Drive

function makeDrive() {
  return { files: new Map(), pushes: 0 };
}

/**
 * Atrapa `window.__player.__net` — tego samego API, którego panel używa do
 * pobrania utworu z YouTube. `onImport` udaje runtime: dopisuje utwór do
 * biblioteki, tak jakby pobieranie się udało.
 */
function makeNet(options) {
  const settings = options || {};
  const calls = [];
  const results = settings.results || [];
  return {
    calls, results,
    enabled: () => settings.enabled !== false,
    search(term) { calls.push(['search', term]); return Promise.resolve(results); },
    results: () => results,
    importIdx(index) {
      calls.push(['import', index]);
      if (settings.onImport) return Promise.resolve(settings.onImport(index));
      return Promise.resolve();
    },
  };
}

/**
 * Fałszywy Neutralino z prawdziwym systemem plików w pamięci. Ten sam `fs`
 * przekazany do dwóch środowisk oznacza „ten sam folder na dwóch komputerach".
 */
function makeNeutralino(fs, state) {
  const neutralino = {
    filesystem: {
      async getStats(target) {
        if (fs.files.has(target)) return { isFile: true, isDirectory: false, modifiedAt: Date.now() };
        if (fs.dirs.has(target)) return { isFile: false, isDirectory: true, modifiedAt: Date.now() };
        throw new Error('Nie ma takiej ścieżki: ' + target);
      },
      async readFile(target) {
        if (!fs.files.has(target)) throw new Error('Nie ma takiego pliku: ' + target);
        return fs.files.get(target);
      },
      async writeFile(target, data) {
        if (state.denied) throw new Error('Brak uprawnień do zapisu');
        if (state.writeNoop) return;   // zapis, który nigdzie nie trafia (test)
        fs.files.set(target, String(data));
      },
      async readDirectory(target) {
        const prefix = String(target).replace(/[\\/]+$/, '') + '/';
        const out = [];
        for (const file of fs.files.keys()) {
          if (file.indexOf(prefix) === 0 && file.slice(prefix.length).indexOf('/') < 0) {
            out.push({ entry: file.slice(prefix.length), type: 'FILE', path: file });
          }
        }
        for (const dir of fs.dirs) {
          if (dir.indexOf(prefix) === 0 && dir.slice(prefix.length).indexOf('/') < 0) {
            out.push({ entry: dir.slice(prefix.length), type: 'DIRECTORY', path: dir });
          }
        }
        return out;
      },
      async createDirectory(target) {
        if (state.denied) throw new Error('Brak uprawnień');
        fs.dirs.add(target);
      },
    },
    os: {
      async showFolderDialog() {
        if (state.cancelled) return null;
        fs.dirs.add(state.pickedDir);
        return state.pickedDir;
      },
    },
  };
  return neutralino;
}

/**
 * Fałszywy folder na Dysku: to samo miejsce widziane przez oba urządzenia.
 * Odpowiada natywnemu PulsarFolderPlugin (systemowe okno Dokumentów).
 */
function makeFolder(drive) {
  const api = {
    _picked: false,
    _label: '',
    _files: drive.files,
    status() {
      return Promise.resolve({
        picked: api._picked,
        label: api._label,
        file: 'pulsar-library.json',
        fileReady: api._files.has('folder'),
        lastError: '',
      });
    },
    pickFolder() {
      api._picked = true;
      api._label = 'Pulsar (Dysk Google)';
      return api.status();
    },
    forget() {
      api._picked = false;
      api._label = '';
      return Promise.resolve({ picked: false, label: '', lastError: '' });
    },
    read() {
      return Promise.resolve({ manifest: api._files.get('folder') || null, modifiedTime: Date.now() });
    },
    write(payload) {
      if (!api._picked) return Promise.reject(new Error('Nie wskazano folderu.'));
      api._files.set('folder', payload.manifest);
      return Promise.resolve({ modifiedTime: Date.now() });
    },
  };
  return api;
}

function makePlugin(drive) {
  return {
    _configured: { clientId: '', clientSecret: '' },
    _signedIn: false,
    _status: null,
    configure(config) {
      this._configured = config;
      return Promise.resolve(this.statusNow());
    },
    statusNow() {
      return {
        configured: !!(this._configured.clientId && this._configured.clientSecret),
        signedIn: this._signedIn,
        email: this._signedIn ? 'user@gmail.com' : '',
        lastSyncAt: 0,
        lastError: '',
        mirror: true,
      };
    },
    status() { return Promise.resolve(this.statusNow()); },
    signIn() { this._signedIn = true; return Promise.resolve(this.statusNow()); },
    signOut() { this._signedIn = false; return Promise.resolve(this.statusNow()); },
    setMirror() { return Promise.resolve(this.statusNow()); },
    addListener() { return Promise.resolve({}); },
    pull() {
      const value = drive.files.get('appdata') || null;
      return Promise.resolve(value ? { manifest: value, modifiedTime: 't', version: '1' } : { manifest: null });
    },
    push(payload) {
      drive.pushes++;
      drive.files.set('appdata', payload.manifest);
      if (payload.mirror) drive.files.set('mirror', payload.manifest);
      return Promise.resolve({ modifiedTime: 't', version: '2', mirrored: !!payload.mirror });
    },
  };
}

// ------------------------------------------------------------------ środowisko

function makeEnv(options) {
  const drive = options.drive || makeDrive();
  const plugin = makePlugin(drive);
  plugin._configured = options.config || { clientId: 'id', clientSecret: 'secret' };
  plugin._signedIn = !!options.signedIn;
  if (options.seed) drive.files.set('appdata', JSON.stringify(options.seed));
  const folder = makeFolder(drive);
  folder._picked = !!options.folderPicked;
  if (options.seed) drive.files.set('folder', JSON.stringify(options.seed));

  const library = makeLibrary(options.tracks || [], options.albums || []);

  // Bez `withPanel` testy działają bez DOM-u (logika scalania); z `withPanel`
  // podstawiamy strukturę ustawień runtime'u, żeby sprawdzić sam panel.
  const settingsDom = options.withPanel ? makeSettingsDom() : null;
  const document = settingsDom ? Object.assign(makeDocument(settingsDom), { hidden: false }) : {
    readyState: 'complete',
    hidden: false,
    body: { contains: () => false },
    documentElement: { classList: { contains: () => false, add() {} } },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {},
    createElement: () => ({ style: {}, addEventListener() {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }),
  };
  document.documentElement = { classList: { contains: () => false, add() {} } };
  document.hidden = false;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Number,
    String,
    Object,
    Array,
    isFinite,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit/537.36' },
    Event: class Event { constructor(type) { this.type = type; } },
    localStorage: {
      _data: Object.assign({}, options.storage || {}),
      getItem(key) { return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null; },
      setItem(key, value) { this._data[key] = String(value); },
    },
    indexedDB: makeIndexedDb(),
    location: { href: 'https://localhost/' },
    File: class File {},
  };
  const docListeners = {};
  if (settingsDom) {
    document.addEventListener = (type, handler) => {
      (docListeners[type] = docListeners[type] || []).push(handler);
    };
    document.dispatchEvent = (event) => {
      (docListeners[event.type] || []).forEach((handler) => handler(event));
      return true;
    };
  }
  const pluginTable = {};
  if (options.desktop) {
    // Desktop nie ma wtyczek Capacitora — zamiast nich działa adapter Neutralino.
  } else {
    if (options.withDrive !== false) pluginTable.PulsarDrive = plugin;
    if (options.withFolder !== false) pluginTable.PulsarFolder = folder;
  }

  const fs = options.fs || { files: new Map(), dirs: new Set() };
  const desktopState = {
    pickedDir: options.pickedDir || '/home/user/Dysk Google/Pulsar',
    cancelled: !!options.cancelPick,
    denied: !!options.denyWrite,
    writeNoop: !!options.writeNoop,
  };

  const toasts = [];
  if (options.desktop) sandbox.Neutralino = makeNeutralino(fs, desktopState);
  sandbox.window = {
    Capacitor: { Plugins: pluginTable },
    __pulsarHost: { toast: (text) => toasts.push(String(text)) },
    __pulsarSyncSnapshot: library.snapshot,
    __pulsarSyncApply: library.apply,
    addEventListener() {},
  };
  sandbox.document = document;
  sandbox.window.document = document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.indexedDB = sandbox.indexedDB;
  sandbox.window.setTimeout = setTimeout;
  sandbox.window.clearTimeout = clearTimeout;

  vm.createContext(sandbox);
  if (options.desktop) {
    // Ładujemy prawdziwy adapter desktopowy, a nie atrapę.
    vm.runInContext(fsSource.readFileSync(DESKTOP_ADAPTER, 'utf8'), sandbox, { filename: 'desktop-cloud-sync.js' });
  }
  vm.runInContext(fsSource.readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'drive-sync.js' });
  return {
    api: sandbox.window.__pulsarDrive, drive, plugin, folder, library, plugins: pluginTable,
    storage: sandbox.localStorage, dom: settingsDom, document, toasts, sandbox,
    desktopFs: fs, desktopState,
    fireDocumentEvent(type) { (docListeners[type] || []).forEach((handler) => handler({ type })); },
  };
}

/** Pliki biblioteki w fałszywym folderze — każde urządzenie pisze swój. */
function cloudFiles(shared) {
  return [...shared.files.entries()]
    .filter(([path]) => /pulsar-library.*\.json$/.test(path))
    .map(([path, text]) => ({ path, name: path.split('/').pop(), text }));
}

/** Suma plików: to, co widzi chmura po odjęciu znaczników kasowania. */
function cloudUnion(shared) {
  const tracks = new Map(); const albums = new Map(); const devices = new Map(); const removed = new Map();
  cloudFiles(shared).forEach(({ text }) => {
    const manifest = JSON.parse(text);
    (manifest.tracks || []).forEach((entry) => { if (entry && entry.key) tracks.set(entry.key, entry); });
    (manifest.albums || []).forEach((entry) => { if (entry && entry.key) albums.set(entry.key, entry); });
    (manifest.devices || []).forEach((entry) => { if (entry && entry.id) devices.set(entry.id, entry); });
    (manifest.removed || []).forEach((entry) => {
      if (entry && entry.key) removed.set(entry.key, Math.max(removed.get(entry.key) || 0, Number(entry.deletedAt || 0)));
    });
  });
  const live = (map) => [...map.values()].filter((entry) => {
    if (!removed.has(entry.key)) return true;
    return Number(removed.get(entry.key) || 0) < Number(entry.updatedAt || 0);
  });
  return {
    tracks: live(tracks),
    albums: live(albums),
    devices: [...devices.values()],
    removed: [...removed.keys()].map((key) => ({ key })),
    files: cloudFiles(shared).map((file) => file.name),
  };
}

// -------------------------------------------------------------------- testy

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, extra) {
  results.push((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   [' + extra + ']' : ''));
}

function containsAudioLike(value, depth) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 400 || /^data:audio/.test(value) || /\.mp3$/i.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsAudioLike(entry, depth + 1));
  if (typeof value === 'object') return Object.keys(value).some((key) => containsAudioLike(value[key], depth + 1));
  return false;
}

(async () => {
  const track = (over) => Object.assign({
    netId: 'youtube:dQw4w9WgXcQ', title: 'Giants', artist: 'Imagine Dragons',
    durMs: 200000, fav: false, plays: 3,
  }, over);

  { // 1. manifest zawiera tylko metadane — bez audio, bez ścieżek
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const manifest = JSON.parse(env.drive.files.get('appdata'));
    check('manifest holds no audio payload', !containsAudioLike(manifest, 0), 'bytes=' + JSON.stringify(manifest).length);
    check('manifest keeps the cross-device key', manifest.tracks[0].key === 'youtube:dQw4w9WgXcQ', manifest.tracks[0].key);
    check('local file paths are never uploaded', !/(srcPath|folder|blob)/.test(env.drive.files.get('appdata')));
    check('readable mirror is written too', !!env.drive.files.get('mirror'));
  }

  { // 2. drugie urządzenie dostaje pozycję z chmury i scalone polubienie
    const first = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({ fav: true, plays: 9 })] });
    first.api.setMode('google');
    first.api.setEnabled(true);
    await first.api.sync();

    const second = makeEnv({
      config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true,
      tracks: [track({ fav: false, plays: 1 })],
      drive: first.drive,
    });
    second.api.setMode('google');
    second.api.setEnabled(true);
    const outcome = await second.api.sync();
    check('second device pulls the newer favourite', second.library.state.tracks[0].fav === true, JSON.stringify(outcome.counters || outcome));
    check('play counts merge upwards', second.library.state.tracks[0].plays === 9, String(second.library.state.tracks[0].plays));
  }

  { // 3. pozycja istniejąca tylko w chmurze trafia na listę, ale nie tworzy pustego utworu
    const remote = {
      schema: 1, app: 'pulsar', updatedAt: Date.now(), device: { id: 'other' },
      devices: [{ id: 'other' }],
      tracks: [{ key: 'youtube:aaaaaaaaaaa', title: 'Only remote', artist: 'X', updatedAt: Date.now(), fingerprint: 'f' }],
      albums: [], removed: [],
    };
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [], seed: remote });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const counters = env.api.counters();
    check('cloud-only track is counted, not materialised', counters.cloud === 1 && env.library.state.tracks.length === 0,
      'cloud=' + counters.cloud + ' local=' + env.library.state.tracks.length);
  }

  { // 4. kasowanie na innym urządzeniu nie kasuje pliku, ale jest raportowane
    const local = track({});
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [local] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const manifest = JSON.parse(env.drive.files.get('appdata'));
    manifest.removed = [{ key: 'youtube:dQw4w9WgXcQ', deletedAt: Date.now() + 1000, device: 'other-device' }];
    env.drive.files.set('appdata', JSON.stringify(manifest));
    const outcome = await env.api.sync();
    check('remote deletion never removes the local file', env.library.state.tracks.length === 1);
    check('remote deletion is reported in the panel', outcome.counters && outcome.counters.removed === 1,
      'removed=' + (outcome.counters ? outcome.counters.removed : 'n/a'));
  }

  { // 5. albumy: nowy album z chmury powstaje lokalnie po dopasowaniu kluczy
    const remote = {
      schema: 1, app: 'pulsar', updatedAt: Date.now(), device: { id: 'other' }, devices: [{ id: 'other' }],
      tracks: [{ key: 'youtube:dQw4w9WgXcQ', title: 'Giants', artist: 'Imagine Dragons', updatedAt: Date.now(), fingerprint: 'x' }],
      albums: [{ key: 'al:abc', name: 'Evolve', trackKeys: ['youtube:dQw4w9WgXcQ', 'youtube:missingaaaa'], updatedAt: Date.now(), fingerprint: 'a' }],
      removed: [],
    };
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})], seed: remote });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const album = env.library.state.albums[0];
    check('album from the cloud lands locally', !!album && album.name === 'Evolve', JSON.stringify(env.library.state.albums));
  }

  { // 6. usunięcie lokalne wysyła znacznik kasowania i nie wraca z chmury
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    env.library.state.tracks.length = 0; // użytkownik usuwa utwór na tym urządzeniu
    await env.api.sync();
    const afterRemoval = JSON.parse(env.drive.files.get('appdata'));
    check('local deletion becomes a tombstone', (afterRemoval.removed || []).some((entry) => entry.key === 'youtube:dQw4w9WgXcQ'),
      JSON.stringify(afterRemoval.removed));
    check('tombstoned track is no longer uploaded', (afterRemoval.tracks || []).length === 0, String((afterRemoval.tracks || []).length));
  }

  { // 7. brak logowania: nic nie leci do Drive, tylko komunikat
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: false, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    const outcome = await env.api.sync();
    check('signed-out sync uploads nothing', env.drive.pushes === 0 && /zalogow|sign in/i.test(outcome.error || ''),
      'pushes=' + env.drive.pushes + ' error=' + (outcome.error || ''));
  }

  { // 8. wyłączona synchronizacja nie robi nic
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})] });
    const outcome = await env.api.sync();
    check('disabled sync stays offline', env.drive.pushes === 0 && outcome.skipped === 'disabled', JSON.stringify(outcome));
  }

  { // 9. błąd sieci nie gubi zmian: następny cykl wysyła ten sam stan
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const first = JSON.parse(env.drive.files.get('appdata'));
    const realPush = env.plugin.push.bind(env.plugin);
    env.plugin.push = () => Promise.reject(new Error('brak sieci'));
    env.library.state.tracks[0].fav = true;
    const failed = await env.api.sync();
    check('failed push is reported', !!failed.error, String(failed.error));
    env.plugin.push = realPush;
    await env.api.sync();
    const second = JSON.parse(env.drive.files.get('appdata'));
    check('retry still carries the local change', second.tracks[0].fav === true && first.tracks[0].fav === false,
      'before=' + first.tracks[0].fav + ' after=' + second.tracks[0].fav);
  }

  { // 10. scalanie czystych funkcji: ostatnia zmiana wygrywa, remis rozstrzyga urządzenie
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true });
    const pure = env.api._pure;
    const local = {
      schema: 1, device: { id: 'aaa' }, devices: [{ id: 'aaa' }],
      tracks: [{ key: 'k', title: 'stary', updatedAt: 1000, fingerprint: 'A', device: 'aaa' }], albums: [], removed: [],
    };
    const remoteManifest = {
      schema: 1, device: { id: 'bbb' }, devices: [{ id: 'bbb' }],
      tracks: [{ key: 'k', title: 'nowy', updatedAt: 2000, fingerprint: 'B', device: 'bbb' }], albums: [], removed: [],
    };
    const merged = pure.mergeManifests(local, remoteManifest);
    check('newer change wins', merged.merged.tracks[0].title === 'nowy', merged.merged.tracks[0].title);
    check('incoming list only carries real changes', merged.incoming.tracks.length === 1, String(merged.incoming.tracks.length));

    const tie = pure.mergeManifests(local, {
      schema: 1, device: { id: 'bbb' }, devices: [{ id: 'bbb' }],
      tracks: [{ key: 'k', title: 'ten sam czas', updatedAt: 1000, fingerprint: 'C', device: 'bbb' }], albums: [], removed: [],
    });
    check('ties are deterministic', tie.merged.tracks[0].title === 'ten sam czas', tie.merged.tracks[0].title);

    const buried = pure.mergeManifests(local, {
      schema: 1, device: { id: 'bbb' }, devices: [{ id: 'bbb' }],
      tracks: [{ key: 'k', title: 'wskrzeszony', updatedAt: 1000, fingerprint: 'A', device: 'bbb' }],
      albums: [], removed: [{ key: 'k', deletedAt: 5000, device: 'bbb' }],
    });
    check('a newer deletion outranks the entry', buried.merged.tracks.length === 0, JSON.stringify(buried.merged.tracks));
  }

  { // 11. klucz utworu nie zależy od lokalnego UUID ani ścieżki
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true });
    const pure = env.api._pure;
    const a = pure.trackKey({ netId: 'youtube:abcdefghijk' });
    const b = pure.trackKey({ file: { name: 'Giants.mp3', size: 4096 } });
    const c = pure.trackKey({ file: { name: 'giants.mp3', size: 4096 } });
    check('network tracks key off the video id', a === 'youtube:abcdefghijk', a);
    check('local files key off name+size, case-insensitive', b === c && b.indexOf('fp:4096:') === 0, b + ' / ' + c);
  }

// ------------------------------------------- prawdziwe hooki runtime (snapshot/apply)

function makeHooksEnv(libraryState) {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Number,
    String,
    Object,
    Array,
    Promise,
    CustomEvent: class CustomEvent { constructor(type, detail) { this.type = type; this.detail = detail; } },
    document: { dispatchEvent() {} },
    tracks: libraryState.tracks,
    albums: libraryState.albums,
    persistTrack(track) { track.__persisted = (track.__persisted || 0) + 1; return Promise.resolve(); },
    persistAlbum(album) { album.__persisted = (album.__persisted || 0) + 1; return Promise.resolve(); },
    makeId: () => 'local-' + Math.random().toString(16).slice(2),
    renderLibrary() {},
    renderAlbumDetail() {},
    buildAlbumCover: async () => null,
    activeAlbumId: null,
    rebuildQueue() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fsSource.readFileSync(HOOKS, 'utf8'), sandbox, { filename: 'cloud_sync_hooks.js' });
  return sandbox;
}

async function checkRuntimeHooks() {
  const file = { name: 'Giants.mp3', size: 4096, type: 'audio/mpeg' };
  const cover = { size: 999, type: 'image/png' };
  const libraryState = {
    tracks: [
      { id: 't1', file, coverBlob: cover, folder: 'Muzyka', srcPath: '/storage/emulated/0/Muzyka/Giants.mp3',
        netId: 'youtube:dQw4w9WgXcQ', title: 'Giants', artist: 'Imagine Dragons', album: 'Evolve', year: '2017',
        fav: true, plays: 7, durMs: 200000 },
      { id: 't2', file: { name: 'Local.mp3', size: 8192 }, folder: 'Muzyka', title: 'Local', artist: 'X', fav: false, plays: 1 },
      // Rekord zapisany, zanim runtime zachowywał netId: zostaje po nim link.
      { id: 't3', file: { name: 'Stara piosenka.mp3', size: 1024 }, folder: 'Sieć/youtube', title: 'Stara', artist: 'Y',
        netLink: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
      // Źródło spoza YouTube i bez pliku nie ma po czym się skojarzyć między urządzeniami.
      { id: 't4', title: 'Obca', artist: 'Z', netLink: 'https://soundcloud.com/ktoś/obca' },
    ],
    albums: [
      { id: 'a1', name: 'Evolve', trackIds: ['t1'], coverBlob: cover, customCover: true, createdAt: 111 },
      { id: 'a2', name: 'Pusty', trackIds: [], createdAt: 222 },
    ],
  };
  const hooks = makeHooksEnv(libraryState);

  const snapshot = hooks.window.__pulsarSyncSnapshot();
  check('snapshot exposes no blobs or paths', !/(blob|file|srcPath|folder)/i.test(JSON.stringify(snapshot)),
    JSON.stringify(snapshot).slice(0, 120));
  check('snapshot keys YouTube tracks by video id', snapshot.tracks[0].key === 'youtube:dQw4w9WgXcQ', snapshot.tracks[0].key);
  check('snapshot keys local files by fingerprint', /^fp:8192:/.test(snapshot.tracks[1].key), snapshot.tracks[1].key);
  check('a legacy track without netId still syncs through its YouTube link',
    !!snapshot.tracks[2] && snapshot.tracks[2].key === 'youtube:aaaaaaaaaaa' &&
      snapshot.tracks[2].ytId === 'aaaaaaaaaaa' && snapshot.tracks[2].provider === 'youtube',
    JSON.stringify(snapshot.tracks[2]));
  check('a source that is not YouTube and has no file stays out of the manifest',
    snapshot.tracks.length === 3 && !snapshot.tracks.some((entry) => /obca|soundcloud/i.test(entry.title)),
    String(snapshot.tracks.length));
  check('album membership is expressed as track keys',
    JSON.stringify(snapshot.albums[0].trackKeys) === JSON.stringify(['youtube:dQw4w9WgXcQ']),
    JSON.stringify(snapshot.albums.map((album) => album.trackKeys)));

  const plan = {
    trackUpdates: [{ key: 'youtube:dQw4w9WgXcQ', fields: { fav: false, plays: 12, album: '' } }],
    albumUpdates: [{ key: snapshot.albums[0].key, trackKeys: ['youtube:dQw4w9WgXcQ', 'fp:8192:' + snapshot.tracks[1].key.split(':')[2]] }],
    newAlbums: [
      { key: 'al:nowy', name: 'Z chmury', trackKeys: ['fp:8192:' + snapshot.tracks[1].key.split(':')[2], 'youtube:nieistnieje'], createdAt: 999 },
      { key: 'al:pusty', name: 'Same obce', trackKeys: ['youtube:nieistnieje'] },
    ],
  };
  const applied = await hooks.window.__pulsarSyncApply(plan);
  const track1 = libraryState.tracks[0];
  check('metadata updates are applied', track1.fav === false && track1.plays === 12, JSON.stringify({ fav: track1.fav, plays: track1.plays }));
  check('audio file object is untouched', track1.file === file && track1.coverBlob === cover);
  check('local paths are never rewritten', track1.srcPath === '/storage/emulated/0/Muzyka/Giants.mp3');
  check('album membership maps keys to local ids', JSON.stringify(libraryState.albums[0].trackIds) === JSON.stringify(['t1', 't2']),
    JSON.stringify(libraryState.albums[0].trackIds));
  check('album membership drops keys unknown here', libraryState.albums[0].trackIds.indexOf('youtube:missingaaaa') === -1);
  const created = libraryState.albums.find((album) => album.name === 'Z chmury');
  check('new album keeps only tracks that exist here', !!created && created.trackIds.length === 1 && created.trackIds[0] === 't2',
    JSON.stringify(created && created.trackIds));
  check('album made only of foreign tracks is skipped', !libraryState.albums.some((album) => album.name === 'Same obce'));
  check('applied counter reflects the work', applied.tracks === 1 && applied.albums === 2,
    JSON.stringify(applied) + ' (membership from the cloud + one new album)');
}

  { // 12. pierwsza synchronizacja obu urządzeń nie może zależeć od szczęścia zegara
    const environment = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true });
    const pure = environment.api._pure;
    const deviceA = { id: 'device-a', name: 'Telefon', platform: 'android' };
    const deviceB = { id: 'device-b', name: 'Tablet', platform: 'android' };
    const phone = pure.buildManifest({ tracks: [{ key: 'youtube:x', title: 'Giants', artist: '', fav: true, plays: 9 }], albums: [] }, null, deviceA);
    const tablet = pure.buildManifest({ tracks: [{ key: 'youtube:x', title: 'Giants', artist: 'Imagine Dragons', fav: false, plays: 1 }], albums: [] }, null, deviceB);
    const tabletMerged = pure.mergeManifests(tablet, phone).merged.tracks[0];
    const phoneMerged = pure.mergeManifests(phone, tablet).merged.tracks[0];
    check('first sync keeps the favourite from either side', tabletMerged.fav === true && phoneMerged.fav === true,
      JSON.stringify({ tablet: tabletMerged.fav, phone: phoneMerged.fav }));
    check('first sync fills in missing text on both sides',
      tabletMerged.artist === 'Imagine Dragons' && phoneMerged.artist === 'Imagine Dragons',
      JSON.stringify({ tablet: tabletMerged.artist, phone: phoneMerged.artist }));
    check('first sync takes the higher play count', tabletMerged.plays === 9 && phoneMerged.plays === 9,
      JSON.stringify({ tablet: tabletMerged.plays, phone: phoneMerged.plays }));

    const manifestOf = (device, record) => ({
      schema: 1, app: 'pulsar', device: device, devices: [device], tracks: [record], albums: [], removed: [],
    });

    // Scalanie musi być idempotentne: powtórka nie może wiecznie wyglądać jak zmiana.
    const twice = pure.mergeManifests(manifestOf(deviceB, tabletMerged), manifestOf(deviceA, phoneMerged)).merged.tracks[0];
    check('merging again is a no-op', twice.fingerprint === phoneMerged.fingerprint && twice.plays === 9,
      JSON.stringify({ sameFingerprint: twice.fingerprint === phoneMerged.fingerprint, plays: twice.plays }));

    // Odznaczenie polubienia na urządzeniu z nowszą zmianą ma się propagować.
    const older = Object.assign({}, phoneMerged, { fav: true, updatedAt: 1000 });
    const newerUnfav = Object.assign({}, phoneMerged, { fav: false, updatedAt: 2000 });
    const unFav = pure.mergeManifests(manifestOf(deviceA, older), manifestOf(deviceB, newerUnfav));
    const reverseUnFav = pure.mergeManifests(manifestOf(deviceB, newerUnfav), manifestOf(deviceA, older));
    check('un-favouriting wins when it is the newer change',
      unFav.merged.tracks[0].fav === false && reverseUnFav.merged.tracks[0].fav === false,
      JSON.stringify({ a: unFav.merged.tracks[0].fav, b: reverseUnFav.merged.tracks[0].fav }));
  }

  { // 13. domyślnie tryb folderu: działa bez Client ID, bez logowania i bez pluginu Drive
    const env = makeEnv({ withDrive: false, folderPicked: true, tracks: [track({})] });
    check('folder mode is the default', env.api.mode() === 'folder', env.api.mode());
    env.api.setEnabled(true);
    const outcome = await env.api.sync();
    const written = env.drive.files.get('folder');
    check('folder sync works with no Google setup', !!written && !outcome.error, outcome.error || 'ok');
    check('folder sync uploads no audio', written && !containsAudioLike(JSON.parse(written), 0));
    check('folder sync keeps the cross-device key', written && JSON.parse(written).tracks[0].key === 'youtube:dQw4w9WgXcQ');
    check('panel sees the folder as ready after a sync', env.api.state().folderReady === true);
  }

  { // 14. drugie urządzenie wskazuje ten sam folder i dostaje scaloną bibliotekę
    const first = makeEnv({ withDrive: false, folderPicked: true, tracks: [track({ fav: true, plays: 9 })] });
    first.api.setEnabled(true);
    await first.api.sync();

    const second = makeEnv({
      withDrive: false, folderPicked: true, drive: first.drive,
      tracks: [track({ fav: false, plays: 1 })],
    });
    second.api.setEnabled(true);
    const outcome = await second.api.sync();
    check('second device syncs through the same folder',
      second.library.state.tracks[0].fav === true && second.library.state.tracks[0].plays === 9,
      JSON.stringify(outcome.counters || outcome));
  }

  { // 15. bez wskazanego folderu nic nie leci na Dysk, tylko komunikat
    const env = makeEnv({ withDrive: false, tracks: [track({})] });
    env.api.setEnabled(true);
    const outcome = await env.api.sync();
    check('folder mode without a folder refuses to write',
      !env.drive.files.has('folder') && /folder/i.test(outcome.error || ''),
      'error=' + (outcome.error || 'brak') + ' plik=' + env.drive.files.has('folder'));
    check('folder status is surfaced to the panel', env.api.state().folderReady === false);
  }

  { // 16. wybór folderu jest zapamiętywany i widoczny w stanie
    const env = makeEnv({ withDrive: false, tracks: [track({})] });
    await env.folder.pickFolder();
    await env.api.status();
    check('chosen folder is visible in the panel state',
      env.api.state().folderReady === true && /Pulsar/.test(env.api.state().folderLabel || ''),
      env.api.state().folderLabel);
  }

  { // 17. tryb jest zapamiętywany między uruchomieniami
    const env = makeEnv({ withDrive: true, folderPicked: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    const saved = JSON.parse(env.storage.getItem('pulsarCloudSync'));
    check('mode switch is stored', saved.mode === 'google' && saved.enabled === true, JSON.stringify(saved));
    const second = makeEnv({ withDrive: true, tracks: [track({})], storage: { pulsarCloudSync: env.storage.getItem('pulsarCloudSync') } });
    check('mode is read back from storage', second.api.mode() === 'google', second.api.mode());
  }

  { // 18. brak pluginu Google przy trybie google nie wywala synchronizacji w powietrze
    const env = makeEnv({ withDrive: false, folderPicked: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    const outcome = await env.api.sync();
    check('missing Google plugin falls back to the folder transport',
      !!env.drive.files.get('folder') && !outcome.error, JSON.stringify(outcome));
  }

  { // 19. panel ląduje tam, gdzie runtime trzyma ustawienia (to była przyczyna „nic nie robi")
    const env = makeEnv({ withDrive: true, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    check('pane is created inside #smBody, not loose in the menu',
      !!pane && pane.parentNode === env.dom.smBody, pane && pane.parentNode && (pane.parentNode.getAttribute('id') || '?'));
    const tab = env.dom.nav.querySelector('.sm-tab[data-pane="cloud"]');
    check('tab is added to the runtime nav', !!tab && tab.parentNode === env.dom.nav);
    check('tab is a real button with the runtime class',
      !!tab && tab.getAttribute('type') === 'button' && tab.classList.contains('sm-tab'),
      tab && tab.getAttribute('type'));
    check('pane uses only the runtime pane class', !!pane && pane.classList.contains('sm-pane'));
  }

  { // 20. klik na zakładkę pokazuje panel (wcześniej nie robił nic)
    const env = makeEnv({ withDrive: true, withPanel: true, tracks: [track({})] });
    env.api.openPanel();
    const tab = env.dom.nav.querySelector('.sm-tab[data-pane="cloud"]');
    const pane = env.dom.smBody.querySelector('.sm-pane[data-pane="cloud"]');
    const play = env.dom.smBody.querySelector('.sm-pane[data-pane="play"]');
    check('cloud pane starts hidden', !pane.classList.contains('active'));
    check('another pane starts active', play.classList.contains('active'));
    tab.click();
    check('clicking the tab activates the cloud pane', pane.classList.contains('active'));
    check('clicking the tab deactivates the previous pane', !play.classList.contains('active'));
    check('tab marks itself active and aria-current',
      tab.classList.contains('active') && tab.getAttribute('aria-current') === 'page');
    check('chosen tab is remembered for the next open',
      env.storage.getItem('pulsarSettingsTab') === 'cloud', String(env.storage.getItem('pulsarSettingsTab')));
    check('other tabs are deactivated', env.dom.nav.querySelector('.sm-tab[data-pane="play"]').classList.contains('active') === false);
  }

  { // 21. tryb wybiera się w panelu i wybór obowiązuje od razu
    const env = makeEnv({ withDrive: true, withPanel: true, folderPicked: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    const select = pane.querySelector('[data-cloud="mode"]');
    const folderSection = pane.querySelector('[data-cloud-section="folder"]');
    const googleSection = pane.querySelector('[data-cloud-section="google"]');
    check('panel offers both transports', !!select && select.querySelectorAll('option').length === 2);
    check('folder section is shown in the default mode',
      !folderSection.classList.contains('sm-hide') && googleSection.classList.contains('sm-hide'));
    select.change('google');
    check('switching to Google mode is applied', env.api.mode() === 'google', env.api.mode());
    check('sections swap with the mode',
      folderSection.classList.contains('sm-hide') && !googleSection.classList.contains('sm-hide'));
    check('mode survives a restart', JSON.parse(env.storage.getItem('pulsarCloudSync')).mode === 'google');
  }

  { // 22. żaden tekst panelu nie jest pusty, a zmiana języka go przetłumaczy
    const env = makeEnv({ withDrive: true, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    const empty = pane.querySelectorAll('[data-cloud-text]').filter((el) => !el.textContent.trim());
    check('every label in the panel is filled', empty.length === 0,
      empty.map((el) => el.getAttribute('data-cloud-text')).join(',') || 'brak pustych');
    check('input placeholders are set',
      ['clientId', 'clientSecret', 'redirectUri'].every((name) => {
        const input = pane.querySelector('[data-cloud="' + name + '"]');
        return input && input.getAttribute('placeholder');
      }));
    const tab = env.dom.nav.querySelector('.sm-tab[data-pane="cloud"]');
    const polishTab = tab.textContent.trim();
    env.storage.setItem('playerLang', 'en');
    env.fireDocumentEvent('pulsar:lang');
    check('language switch relabels the tab', tab.textContent.trim() !== polishTab && /cloud/i.test(tab.textContent),
      polishTab + ' → ' + tab.textContent.trim());
    check('language switch relabels the pane',
      /Drive folder|Google sign-in|How to sync/i.test(pane.textContent));
  }

  { // 23. klasy CSS panelu muszą istnieć w runtime (inaczej panel wygląda jak goły HTML)
    const htmlPath = path.join(__dirname, '..', '..', 'Pulsar-Android', 'www', 'index.html');
    if (!fsSource.existsSync(htmlPath)) {
      check('panel CSS classes exist in the runtime', true, 'pominięte: brak www/index.html');
    } else {
      const html = fsSource.readFileSync(htmlPath, 'utf8');
      const css = html.slice(0, html.indexOf('</style>'));
      const known = new Set((css.match(/\.sm-[a-z-]+/g) || []).map((entry) => entry.slice(1)).concat(['sm-pane']));
      const env = makeEnv({ withDrive: true, withPanel: true, tracks: [track({})] });
      const pane = env.api.openPanel();
      const tab = env.dom.nav.querySelector('.sm-tab[data-pane="cloud"]');
      const used = new Set();
      pane.querySelectorAll('*').concat([pane, tab]).forEach((element) => {
        element.classList.set.forEach((name) => { if (name.startsWith('sm-')) used.add(name); });
      });
      const unknown = Array.from(used).filter((name) => !known.has(name));
      check('panel CSS classes exist in the runtime', unknown.length === 0,
        unknown.length ? 'nieznane: ' + unknown.join(', ') : Array.from(used).length + ' klas OK');
    }
  }

  { // 24. „Zaloguj się kontem Google" nigdy nie jest cichym klikiem
    const env = makeEnv({ withDrive: true, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    const signin = pane.querySelector('[data-cloud="signin"]');
    check('sign-in button exists in the panel', !!signin);
    signin.click();
    const message = env.api.state().lastError || '';
    check('sign-in click explains itself in the status', /wycofa|retired/i.test(message), message.slice(0, 90));
    check('sign-in click also raises a toast', env.toasts.some((text) => /wycofa|retired/i.test(text)),
      JSON.stringify(env.toasts.map((text) => text.slice(0, 40))));
    check('sign-in click does not throw', true);
  }

  { // 25. brakująca warstwa natywna jest nazwana, a nie przemilczana
    const env = makeEnv({ withDrive: false, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="signin"]').click();
    check('missing Google layer is reported with its name',
      /PulsarDrive|wycofa|retired/i.test(env.api.state().lastError || ''), String(env.api.state().lastError).slice(0, 80));

    const folder = makeEnv({ withFolder: false, withDrive: true, withPanel: true, tracks: [track({})] });
    const folderPane = folder.api.openPanel();
    folderPane.querySelector('[data-cloud="choose"]').click();
    await wait(30);
    check('missing folder layer is reported with its name',
      /PulsarFolder/.test(folder.api.state().lastError || ''), String(folder.api.state().lastError).slice(0, 90));
    check('the error names the fix (rebuild)', /zbuduj|rebuild/i.test(folder.api.state().lastError || ''));
    const folderStatus = folderPane.querySelector('[data-cloud="status"]').textContent;
    check('the layers line names the missing plugin', /PulsarFolder/.test(folderStatus),
      folderStatus.replace(/\n/g, ' | ').slice(0, 110));
  }

  { // 26. „Synchronizuj teraz" działa przy wyłączonym automacie i zdaje relację
    const env = makeEnv({ withFolder: true, withPanel: true, folderPicked: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="sync"]').click();
    await wait(80);
    check('manual sync writes without the auto toggle', env.drive.files.has('folder'));
    check('manual sync reports the result', env.toasts.some((text) => /zsynchronizowano|synced/i.test(text)),
      JSON.stringify(env.toasts.map((text) => text.slice(0, 50))));
  }

  { // 27. włączenie automatu bez folderu mówi, czego brakuje
    const env = makeEnv({ withFolder: true, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="enabled"]').change(true);
    await wait(30);
    check('turning sync on without a folder explains what is missing',
      /folder/i.test(env.api.state().lastError || ''), String(env.api.state().lastError).slice(0, 80));
    check('the explanation is a toast too', env.toasts.some((text) => /folder/i.test(text)));
  }

  { // 28. panel pokazuje, które warstwy ma ta kompilacja
    const env = makeEnv({ withDrive: true, withFolder: true, withPanel: true, tracks: [track({})] });
    const pane = env.api.openPanel();
    env.api.status();
    await wait(20);
    const status = pane.querySelector('[data-cloud="status"]').textContent;
    check('status lists the sync layers of this build',
      /folder ✔/.test(status) && /google ✔/.test(status), status.replace(/\n/g, ' | ').slice(0, 110));
    const firstCard = pane.querySelector('.sm-card');
    check('status sits in the first card, visible without scrolling',
      !!firstCard && firstCard.contains(pane.querySelector('[data-cloud="status"]')) &&
      firstCard.contains(pane.querySelector('[data-cloud="sync"]')));
    check('status comes before the folder and Google cards in the pane',
      pane.children.indexOf(firstCard) === 1, 'index=' + pane.children.indexOf(firstCard));
  }

  /** Komputer z wybranym folderem, po pierwszej synchronizacji. */
  async function folderEnv(options) {
    const env = makeEnv(Object.assign({ desktop: true, withPanel: true }, options));
    env.api.openPanel().querySelector('[data-cloud="choose"]').click();
    await wait(40);
    env.api.setEnabled(true);
    await env.api.sync();
    return env;
  }

  /** Telefon wysyła bibliotekę, komputer widzi jej utwór jako „tylko w chmurze". */
  async function cloudOnlySetup(net) {
    const shared = { files: new Map(), dirs: new Set() };
    const phone = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: 'youtube:OTHERVIDEO1', title: 'Inna piosenka', artist: 'Ktoś inny' })],
    });
    const phonePane = phone.api.openPanel();
    phonePane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    phone.api.setEnabled(true);
    await phone.api.sync();

    const pc = makeEnv({ desktop: true, fs: shared, tracks: [track({})], withPanel: true });
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    if (net) pc.sandbox.window.__player = { __net: net };
    pc.api.setEnabled(true);
    await pc.api.sync();
    return { pc, pane, phone, shared, button: pane.querySelector('[data-cloud-download]') };
  }

  { // 29. desktop: adapter rejestruje się i pokazuje się w panelu jako folder
    const env = makeEnv({ desktop: true, tracks: [track({})], withPanel: true });
    const adapter = env.sandbox ? null : null;
    check('desktop adapter is registered', !!env.api && env.api.mode() === 'folder', env.api.mode());
    const pane = env.api.openPanel();
    env.api.status();
    await wait(20);
    const status = pane.querySelector('[data-cloud="status"]').textContent;
    check('desktop status names the desktop transport', /folder \(desktop\)/.test(status), status.replace(/\n/g, ' | ').slice(0, 110));
    check('desktop panel hides the Google mode row',
      pane.querySelector('[data-cloud-row="mode"]').classList.contains('sm-hide'));
    check('desktop panel hides the Google card',
      pane.querySelector('[data-cloud-section="google"]').classList.contains('sm-hide'));
    check('desktop panel keeps the folder card visible',
      !pane.querySelector('[data-cloud-section="folder"]').classList.contains('sm-hide'));
    check('desktop hint talks about a Drive-synced folder',
      /Dysk Google|Drive/i.test(pane.querySelector('[data-cloud-text="folderHint"]').textContent));
    const label = pane.querySelector('[data-cloud-text="folderLab"]').textContent;
    check('folder label mentions Google Drive on desktop', /Dysk Google|Google Drive/.test(label), label);
  }

  { // 30. desktop: wybór folderu, zapis i odczyt przez prawdziwy adapter
    const shared = { files: new Map(), dirs: new Set() };
    const env = makeEnv({ desktop: true, fs: shared, tracks: [track({ fav: true, plays: 4 })], withPanel: true });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    check('picking a folder marks it ready', env.api.state().folderReady === true, JSON.stringify(env.api.state().folderLabel));

    env.api.setEnabled(true);
    const outcome = await env.api.sync();
    const files = cloudFiles(shared);
    check('desktop sync writes its own manifest file',
      files.length === 1 && files[0].name === 'pulsar-library-linux.json' && !outcome.error,
      JSON.stringify({ files: files.map((file) => file.name), error: outcome.error }));
    const own = JSON.parse(files[0].text);
    check('written manifest keeps the cross-device key',
      own.tracks[0].key === 'youtube:dQw4w9WgXcQ', JSON.stringify(own.tracks.map((entry) => entry.key)));
    check('desktop sync uploads no audio', !containsAudioLike(own, 0));

    // Drugi komputer: wskazuje ten sam folder, ma inną bibliotekę — scala się.
    const second = makeEnv({ desktop: true, fs: shared, tracks: [track({ fav: false, plays: 1 })], withPanel: true });
    second.api.openPanel().querySelector('[data-cloud="choose"]').click();
    await wait(40);
    second.api.setEnabled(true);
    const secondOutcome = await second.api.sync();
    check('second desktop reads the same folder and merges',
      second.library.state.tracks[0].fav === true && second.library.state.tracks[0].plays === 4,
      JSON.stringify(secondOutcome.counters || secondOutcome));
    check('the second computer does not overwrite the first one\u2019s file',
      cloudFiles(shared).length === 2 && second.api.ownFile() !== 'pulsar-library-linux.json',
      JSON.stringify({ files: cloudUnion(shared).files, own: second.api.ownFile() }));
    check('the folder still holds one library, not two',
      cloudUnion(shared).tracks.length === 1 && cloudUnion(shared).devices.length === 2,
      JSON.stringify({ tracks: cloudUnion(shared).tracks.length, devices: cloudUnion(shared).devices.length }));
  }

  { // 31. desktop: anulowanie okna i brak pliku nie są błędami
    const shared = { files: new Map(), dirs: new Set() };
    const env = makeEnv({ desktop: true, fs: shared, cancelPick: true, tracks: [track({})], withPanel: true });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(30);
    check('cancelled folder pick leaves sync unconfigured',
      env.api.state().folderReady === false && !env.api.state().lastError,
      'ready=' + env.api.state().folderReady + ' error=' + (env.api.state().lastError || 'brak'));

    const missing = makeEnv({ desktop: true, fs: shared, tracks: [track({})] });
    const readResult = await missing.api.status();
    check('missing manifest file is not an error', !!readResult, 'status ok');
  }

  { // 32. desktop: błąd zapisu trafia do panelu
    const shared = { files: new Map(), dirs: new Set() };
    const env = makeEnv({ desktop: true, fs: shared, denyWrite: true, tracks: [track({})], withPanel: true });
    const pane = env.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(30);
    pane.querySelector('[data-cloud="sync"]').click();
    await wait(80);
    const failure = env.api.state().lastError || '';
    check('write failure is reported in the status', /uprawnie|permission/i.test(failure), failure.slice(0, 80));
    check('write failure reaches the toast when the user asks for a sync',
      env.toasts.some((text) => /uprawnie/i.test(text)),
      JSON.stringify(env.toasts.map((text) => text.slice(0, 40))));
    check('no manifest was left behind after the failure',
      ![...env.desktopFs.files.keys()].some((path) => /pulsar-library.*\.json$/.test(path)));
  }

  { // 33. desktop: zapamiętany tryb Google wraca do folderu
    const env = makeEnv({ desktop: true, tracks: [track({})], storage: { pulsarCloudSync: JSON.stringify({ enabled: true, mode: 'google' }) } });
    check('stored google mode is not honoured on desktop', env.api.mode() === 'folder', env.api.mode());
    check('storage is corrected too',
      JSON.parse(env.storage.getItem('pulsarCloudSync')).mode === 'folder',
      env.storage.getItem('pulsarCloudSync'));
  }

  { // 34. utwory tylko w chmurze są wypisane z nazwy, nie tylko policzone
    const setup = await cloudOnlySetup(null);
    const { pc, pane } = setup;
    const card = pane.querySelector('[data-cloud-section="cloudOnly"]');
    check('cloud-only card appears after a sync', !card.classList.contains('sm-hide'));
    const text = card.textContent.replace(/\s+/g, ' ');
    check('cloud-only card names the track', text.includes('Inna piosenka') && text.includes('Ktoś inny'), text.slice(0, 90));
    const button = setup.button;
    check('the YouTube track gets a download button',
      !!button && button.getAttribute('data-cloud-download') === 'youtube:OTHERVIDEO1',
      button ? button.getAttribute('data-cloud-download') : 'brak przycisku');
    check('the status line points at the list',
      /niżej|below/i.test(pane.querySelector('[data-cloud="status"]').textContent));
    check('the cloud-only list is kept in state',
      pc.api.cloudOnly().length === 1 && pc.api.cloudOnly()[0].key === 'youtube:OTHERVIDEO1',
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
  }

  { // 35. klik „Pobierz tutaj" pobiera przez runtime i synchronizuje ponownie
    const net = makeNet({
      results: [{ provider: 'youtube', id: 'OTHERVIDEO1', ytId: 'OTHERVIDEO1', title: 'Inna piosenka', artist: 'Ktoś inny', stream: 'https://example.invalid/audio' }],
      onImport: () => {
        // Runtime dopisuje utwór z netId — dokładnie ten klucz, co w chmurze.
        net.imported = true;
      },
    });
    const setup = await cloudOnlySetup(net);
    const { pc, button } = setup;
    net.onImportHook = () => pc.library.state.tracks.push(
      track({ netId: 'youtube:OTHERVIDEO1', title: 'Inna piosenka', artist: 'Ktoś inny' }));
    // Podmieniamy import na taki, który naprawdę dokłada utwór do biblioteki.
    net.importIdx = function (index) {
      net.calls.push(['import', index]);
      this.onImportHook();
      return Promise.resolve();
    };
    button.click();
    await wait(250);
    check('download searches for exactly this video',
      net.calls[0] && net.calls[0][0] === 'search' && net.calls[0][1] === 'https://www.youtube.com/watch?v=OTHERVIDEO1',
      JSON.stringify(net.calls[0]));
    check('download imports the matching result', net.calls[1] && net.calls[1][0] === 'import' && net.calls[1][1] === 0,
      JSON.stringify(net.calls[1]));
    check('after the download it is no longer cloud-only',
      !pc.api.cloudOnly().some((entry) => entry.key === 'youtube:OTHERVIDEO1'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
    check('the panel confirms the download', pc.toasts.some((text) => /Pobrano|Downloaded/i.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 40))));
  }

  { // 36. brak API sieciowego to komunikat, nie cisza
    const setup = await cloudOnlySetup(null);
    const { pc, button } = setup;
    pc.sandbox.window.__player = undefined;
    button.click();
    await wait(80);
    check('missing network API is explained',
      /__player\.__net/.test(pc.api.state().lastError || '') || pc.toasts.some((text) => /__player\.__net/.test(text)),
      pc.api.state().lastError || JSON.stringify(pc.toasts));
    check('nothing was pushed as if it worked', !pc.toasts.some((text) => /Pobrano|Downloaded/i.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 30))));
  }

  { // 37. brak wyniku w YouTube / wyłączona sieć / niepotwierdzony import
    const empty = await cloudOnlySetup(makeNet({ results: [] }));
    empty.button.click();
    await wait(120);
    check('empty search result is reported', /pobrano|downloaded/i.test(empty.pc.api.state().lastError || ''),
      empty.pc.api.state().lastError);

    const off = await cloudOnlySetup(makeNet({ enabled: false, results: [] }));
    off.button.click();
    await wait(120);
    check('network switched off is reported', /wyłączone|switched off/i.test(off.pc.api.state().lastError || ''),
      off.pc.api.state().lastError);

    const stub = makeNet({
      results: [{ provider: 'youtube', id: 'OTHERVIDEO1', ytId: 'OTHERVIDEO1', title: 'Inna piosenka', artist: 'Ktoś inny' }],
    });
    const unconfirmed = await cloudOnlySetup(stub);
    unconfirmed.pc.api.setImportWait(0);
    unconfirmed.button.click();
    await wait(150);
    check('an import that never lands is reported',
      /nie potwierdził|not confirmed/i.test(unconfirmed.pc.api.state().lastError || ''),
      unconfirmed.pc.api.state().lastError);
  }

  { // 38. utwór z dysku innego urządzenia pobiera się tutaj z YouTube po tytule i autorze
    const shared = { files: new Map(), dirs: new Set() };
    const phone = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: '', size: 4096, hash: 'abc123', title: 'Plik z telefonu', artist: 'Ktoś' })],
    });
    const phonePane = phone.api.openPanel();
    phonePane.querySelector('[data-cloud="auto"]').change(false);
    phonePane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    phone.api.setEnabled(true);
    await phone.api.sync();

    const net = makeNet({
      results: [
        // Inny serwis podaje ten sam tytuł — z niego nie ściągamy, tylko z YouTube.
        { provider: 'itunes', id: 'ITUNESONLY1', title: 'Plik z telefonu', artist: 'Ktoś', stream: 'https://example.invalid/a.m4a' },
        { provider: 'youtube', id: 'YTMATCH00001', ytId: 'YTMATCH00001', title: 'Plik z telefonu (Official Audio)', artist: 'Ktoś - Topic', ytStream: true },
      ],
    });
    const pc = makeEnv({ desktop: true, fs: shared, tracks: [track({})], withPanel: true });
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="auto"]').change(false);
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.api.setEnabled(true);
    pc.sandbox.window.__player = { __net: net };
    await pc.api.sync();

    const card = pane.querySelector('[data-cloud-section="cloudOnly"]');
    check('a file from another device is listed too', card.textContent.includes('Plik z telefonu'),
      card.textContent.replace(/\s+/g, ' ').slice(0, 90));
    const button = card.querySelector('[data-cloud-download]');
    check('a file from another device gets a download button', !!button && button.getAttribute('data-cloud-download') === 'fp:4096:abc123',
      button ? button.getAttribute('data-cloud-download') : 'brak przycisku');
    check('the button says it comes from YouTube', /z YouTube/i.test(button ? button.textContent : ''),
      button ? button.textContent : '');
    check('the row says it will be looked up by title and artist',
      /tytule i autorze/i.test(card.textContent), card.textContent.replace(/\s+/g, ' ').slice(0, 120));

    // Klik: szukanie po tytule i autorze, wybór wyniku z YouTube i zapis.
    net.importIdx = function (index) {
      net.calls.push(['import', index]);
      pc.library.state.tracks.push(track({ netId: 'youtube:YTMATCH00001', title: 'Plik z telefonu', artist: 'Ktoś' }));
      return Promise.resolve();
    };
    button.click();
    await wait(700);
    check('the download searches YouTube by title and artist',
      net.calls.some((call) => call[0] === 'search' && call[1] === 'Ktoś Plik z telefonu'), JSON.stringify(net.calls));
    check('only a YouTube result is imported',
      net.calls.some((call) => call[0] === 'import' && call[1] === 1), JSON.stringify(net.calls));
    check('the entry is remembered as downloaded here',
      !!pc.api.derived()['fp:4096:abc123'] && pc.api.derived()['fp:4096:abc123'].key === 'youtube:YTMATCH00001',
      JSON.stringify(pc.api.derived()));
    check('and it leaves the cloud-only list',
      !pc.api.cloudOnly().some((entry) => entry.key === 'fp:4096:abc123'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
    check('the panel confirms the download', pc.toasts.some((text) => /Pobrano|Downloaded/i.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 40))));
  }

  { // 39. panel mówi, co jest w pliku w chmurze i kto go ostatnio zapisał
    const shared = { files: new Map(), dirs: new Set() };
    await folderEnv({ fs: shared, tracks: [track({})] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });

    const pane = pc.api.openPanel();
    const status = pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ');
    check('panel names the size of the cloud library',
      /Pliki w chmurze: 1 utw\./.test(status) && /Twój plik: pulsar-library-linux/.test(status),
      status.slice(0, 180));
    check('panel says who wrote the cloud file, and that it was another device',
      /Ostatnia zmiana z innego urządzenia: Linux PC ·/.test(status), status.slice(0, 160));
    check('cloud details are kept in state',
      pc.api.cloudMeta().tracks === 1 && pc.api.cloudMeta().fromOther === true,
      JSON.stringify(pc.api.cloudMeta()));

    const own = cloudFiles(shared)
      .map((file) => JSON.parse(file.text))
      .find((manifest) => manifest.device && /PC$/.test(String(manifest.device.name || '')));
    check('a computer does not describe itself as android',
      !!own && own.device.platform === 'desktop', JSON.stringify(own && own.device));
  }

  { // 40. nowy utwór z drugiego urządzenia jest ogłaszany, a nie milczący
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    check('the first sync stays quiet', !pc.toasts.some((text) => /Nowe z innego/.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 30))));

    phone.library.state.tracks.push(track({ netId: 'youtube:NEWSONG001', title: 'Nowa piosenka', artist: 'Ktoś' }));
    await phone.api.sync();
    await pc.api.sync();

    check('a new track from the other device is announced',
      pc.toasts.some((text) => /Nowe z innego urządzenia: 1/.test(text) && /Nowa piosenka/.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 70))));
    const pane = pc.api.openPanel();
    const card = pane.querySelector('[data-cloud-section="cloudOnly"]');
    check('and it is listed with a way to get it here',
      card.textContent.includes('Nowa piosenka') && !!card.querySelector('[data-cloud-download]'));
  }

  { // 41. Android nadal nazywa się telefonem, a nie komputerem
    const env = makeEnv({ config: { clientId: 'id', clientSecret: 'secret' }, signedIn: true, tracks: [track({})] });
    env.api.setMode('google');
    env.api.setEnabled(true);
    await env.api.sync();
    const manifest = JSON.parse(env.drive.files.get('appdata'));
    check('an Android device names its model',
      manifest.device.name === 'Pixel 8' && manifest.device.platform === 'android',
      JSON.stringify(manifest.device));
  }

  { // 42. automatyczne pobieranie: utwór z telefonu ściąga się sam na komputerze
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const net = makeNet({
      results: [{ provider: 'youtube', id: 'AUTOTRACK01', ytId: 'AUTOTRACK01', title: 'Auto utwór', artist: 'Ktoś' }],
    });
    const pc = makeEnv({ desktop: true, fs: shared, withPanel: true, tracks: [track({})] });
    pc.api.openPanel().querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.sandbox.window.__player = { __net: net };
    net.importIdx = function (index) {
      net.calls.push(['import', index]);
      pc.library.state.tracks.push(track({ netId: 'youtube:AUTOTRACK01', title: 'Auto utwór', artist: 'Ktoś' }));
      return Promise.resolve();
    };
    check('desktop has automatic download on by default', pc.api.state().autoDownload === true);
    pc.api.setEnabled(true);

    // telefon dokłada utwór, komputer synchronizuje się sam
    phone.library.state.tracks.push(track({ netId: 'youtube:AUTOTRACK01', title: 'Auto utwór', artist: 'Ktoś' }));
    await phone.api.sync();
    await pc.api.sync();
    await wait(900);   // auto-pobieranie rusza po zakończeniu synchronizacji

    check('the new track was fetched without a click',
      net.calls.some((call) => call[0] === 'search' && call[1] === 'https://www.youtube.com/watch?v=AUTOTRACK01'),
      JSON.stringify(net.calls));
    check('the automatic download is announced, not silent',
      pc.toasts.some((text) => /Automatycznie pobieram/.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 45))));
    check('after the auto download the track is local and off the list',
      pc.library.state.tracks.length === 2 && !pc.api.cloudOnly().some((entry) => entry.key === 'youtube:AUTOTRACK01'),
      'tracks=' + pc.library.state.tracks.length + ' cloud=' + JSON.stringify(pc.api.cloudOnly().map((e) => e.key)));
  }

  { // 43. wyłączony przełącznik = nic się nie ściąga, ale przełącznik mówi co robi
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const net = makeNet({
      results: [{ provider: 'youtube', id: 'AUTOTRACK02', ytId: 'AUTOTRACK02', title: 'Inny auto', artist: 'Ktoś' }],
    });
    const pc = makeEnv({ desktop: true, fs: shared, withPanel: true, tracks: [track({})] });
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.sandbox.window.__player = { __net: net };
    const autoBox = pane.querySelector('[data-cloud="auto"]');
    check('the switch reflects the default', autoBox.checked === true);
    autoBox.change(false);
    await wait(20);
    check('switching it off answers visibly',
      pc.api.state().autoDownload === false && pc.toasts.some((text) => /Automatyczne pobieranie wyłączone/.test(text)),
      JSON.stringify(pc.toasts.map((text) => text.slice(0, 40))));

    phone.library.state.tracks.push(track({ netId: 'youtube:AUTOTRACK02', title: 'Inny auto', artist: 'Ktoś' }));
    await phone.api.sync();
    pc.api.setEnabled(true);
    await pc.api.sync();
    await wait(900);
    check('with the switch off nothing is downloaded', net.calls.length === 0, JSON.stringify(net.calls));
    check('and the track is still listed for a manual download',
      !!pc.api.openPanel().querySelector('[data-cloud-download]'));
  }

  { // 44. limit: automat ściąga po kilka utworów, nie całą bibliotekę na raz
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const net = makeNet({ results: [] });
    const pc = makeEnv({ desktop: true, fs: shared, withPanel: true, tracks: [track({})] });
    pc.api.openPanel().querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.sandbox.window.__player = { __net: net };
    let current = [];
    net.search = function (term) {
      net.calls.push(['search', term]);
      const id = String(term).split('=').pop();
      current = [{ provider: 'youtube', id, ytId: id, title: 'Auto ' + id, artist: 'Ktoś' }];
      return Promise.resolve(current);
    };
    net.results = () => current;
    net.importIdx = function (index) {
      net.calls.push(['import', index]);
      const id = String(current[index].ytId);
      pc.library.state.tracks.push(track({ netId: 'youtube:' + id, title: 'Auto ' + id, artist: 'Ktoś' }));
      return Promise.resolve();
    };
    pc.api.setEnabled(true);
    for (let i = 1; i <= 5; i++) {
      phone.library.state.tracks.push(track({ netId: 'youtube:BATCH00000' + i, title: 'Batch ' + i, artist: 'Ktoś' }));
    }
    await phone.api.sync();
    await pc.api.sync();
    await wait(1200);
    const imports = net.calls.filter((call) => call[0] === 'import').length;
    check('automatic download stops after a few tracks', imports === 3, 'importów=' + imports);
    check('the rest stays on the list for the next run',
      pc.api.cloudOnly().length === 2, JSON.stringify(pc.api.cloudOnly().map((e) => e.key)));
    check('a second batch does not start immediately',
      pc.toasts.filter((text) => /Automatycznie pobieram/.test(text)).length === 3,
      String(pc.toasts.filter((text) => /Automatycznie pobieram/.test(text)).length));
  }

  { // 45. gdy zapis nie trafia tam, skąd czytamy, panel to mówi
    const shared = { files: new Map(), dirs: new Set() };
    // W folderze leży cudzy manifest (inne urządzenie), a nasz zapis nigdzie nie trafia.
    shared.dirs.add('/home/user/Dysk Google/Pulsar');
    shared.files.set('/home/user/Dysk Google/Pulsar/pulsar-library.json', JSON.stringify({
      schema: 1, app: 'pulsar', updatedAt: Date.now(), device: { id: 'other-device', name: 'Pixel 8' },
      devices: [{ id: 'other-device', name: 'Pixel 8' }], tracks: [], albums: [], removed: [],
    }));
    const pc = makeEnv({ desktop: true, fs: shared, withPanel: true, writeNoop: true, tracks: [track({})] });
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.api.setEnabled(true);
    await pc.api.sync();   // force przez panel „Synchronizuj teraz"
    pane.querySelector('[data-cloud="sync"]').click();
    await wait(150);
    check('a write that never comes back is reported',
      /nie widzę swoich danych w pliku/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(0, 160));
    check('write-back state is exposed for diagnostics', pc.api.cloudMeta().writeBack === 'missing',
      JSON.stringify(pc.api.cloudMeta().writeBack));
  }

  { // 46. utwór z telefonu nie ginie przy kolejnych synchronizacjach komputera
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    // Wyłączamy automat, żeby nic nie pobrało wpisu, który ma przetrwać.
    pc.api.openPanel().querySelector('[data-cloud="auto"]').change(false);
    await wait(20);

    phone.library.state.tracks.push(track({ netId: 'youtube:KEEPME00001', title: 'Zostaje', artist: 'Ktoś' }));
    await phone.api.sync();
    await pc.api.sync();
    await pc.api.sync();   // tu wcześniej wpis był uznawany za skasowany
    await pc.api.sync();

    const manifest = cloudUnion(shared);
    check('the track from the phone is still in the cloud file',
      manifest.tracks.some((entry) => entry.key === 'youtube:KEEPME00001'),
      JSON.stringify(manifest.tracks.map((entry) => entry.key)));
    check('a cloud-only entry is not turned into a deletion',
      !(manifest.removed || []).some((entry) => entry.key === 'youtube:KEEPME00001'),
      JSON.stringify((manifest.removed || []).map((entry) => entry.key)));
    check('and the computer still lists it as cloud-only',
      pc.api.cloudOnly().some((entry) => entry.key === 'youtube:KEEPME00001'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));

    const phoneOutcome = await phone.api.sync();
    check('the phone is not told that its track was deleted',
      (phoneOutcome.counters || {}).removed === 0, JSON.stringify(phoneOutcome.counters));
  }

  { // 47. prawdziwe kasowanie nadal się rozchodzi (żeby nie cofnąć tej naprawy)
    const shared = { files: new Map(), dirs: new Set() };
    const both = () => [track({}), track({ netId: 'youtube:SECOND0001', title: 'Drugi', artist: 'X' })];
    const phone = await folderEnv({ fs: shared, tracks: both() });
    const pc = await folderEnv({ fs: shared, tracks: both() });

    pc.library.state.tracks = pc.library.state.tracks.filter((item) => item.netId !== 'youtube:SECOND0001');
    await pc.api.sync();

    const manifest = cloudUnion(shared);
    check('a real local deletion becomes a tombstone',
      (manifest.removed || []).some((entry) => entry.key === 'youtube:SECOND0001'),
      JSON.stringify((manifest.removed || []).map((entry) => entry.key)));

    const phoneOutcome = await phone.api.sync();
    check('the other device is told about it', (phoneOutcome.counters || {}).removed === 1,
      JSON.stringify(phoneOutcome.counters));
    check('but the audio file stays on that device', phone.library.state.tracks.length === 2,
      String(phone.library.state.tracks.length));

    await pc.api.sync();
    const later = cloudUnion(shared);
    check('the deletion does not quietly come back on the next sync',
      (later.removed || []).some((entry) => entry.key === 'youtube:SECOND0001') &&
      !later.tracks.some((entry) => entry.key === 'youtube:SECOND0001'),
      JSON.stringify({ removed: (later.removed || []).map((e) => e.key), tracks: later.tracks.map((e) => e.key) }));
  }

  { // 48. reguła kasowania: tylko to, co to urządzenie naprawdę miało
    const env = makeEnv({ tracks: [track({})] });
    const pure = env.api._pure;
    const device = { id: 'me', name: 'PC', platform: 'desktop' };
    const previous = {
      schema: 1, app: 'pulsar', updatedAt: Date.now(), device: { id: 'me' }, devices: [{ id: 'me' }],
      tracks: [
        { key: 'youtube:MINE0000001', title: 'Moje', artist: 'X', updatedAt: 0, fingerprint: 'f' },
        { key: 'youtube:THEIRS00001', title: 'Cudze', artist: 'Y', updatedAt: 0, fingerprint: 'g' },
      ],
      albums: [],
      removed: [{ key: 'youtube:THEIRS00001', deletedAt: Date.now(), device: 'me' }],
    };
    const snapshot = { tracks: [{ key: 'youtube:MINE0000001', title: 'Moje', artist: 'X', albums: [] }], albums: [] };

    const first = pure.buildManifest(snapshot, previous, device, null);
    check('without a local-key record nothing is deleted',
      (first.removed || []).length === 0, JSON.stringify((first.removed || []).map((e) => e.key)));

    const second = pure.buildManifest(snapshot, previous, device,
      { tracks: { 'youtube:MINE0000001': true }, albums: {} });
    check('a track that was never local is not deleted either',
      !(second.removed || []).some((entry) => entry.key === 'youtube:THEIRS00001'),
      JSON.stringify((second.removed || []).map((e) => e.key)));

    const third = pure.buildManifest({ tracks: [], albums: [] }, previous, device,
      { tracks: { 'youtube:MINE0000001': true }, albums: {} });
    check('a track that really was here is still deleted',
      (third.removed || []).some((entry) => entry.key === 'youtube:MINE0000001'),
      JSON.stringify((third.removed || []).map((e) => e.key)));
    check('and only that one',
      !(third.removed || []).some((entry) => entry.key === 'youtube:THEIRS00001'),
      JSON.stringify((third.removed || []).map((e) => e.key)));
  }

  { // 49. każde urządzenie pisze tylko swój plik — brak cudzego nic nie kasuje
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:PHONEONLY01', title: 'Z telefonu', artist: 'Y' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({}), track({ netId: 'youtube:PCLOCAL0001', title: 'Z komputera', artist: 'Z' })] });
    const pane = phone.api.openPanel();
    phone.api.setReadRetry(20);
    pane.querySelector('[data-cloud="auto"]').change(false);
    pc.api.openPanel().querySelector('[data-cloud="auto"]').change(false);
    await wait(20);
    await phone.api.sync();   // telefon widzi już oba pliki (i zapamiętuje całą bibliotekę)

    const before = new Map(cloudFiles(shared).map((file) => [file.name, file.text]));
    check('each device keeps its own file in the folder',
      before.size === 2 && !!phone.api.ownFile() && phone.api.ownFile() !== pc.api.ownFile(),
      JSON.stringify({ files: cloudUnion(shared).files, phone: phone.api.ownFile(), pc: pc.api.ownFile() }));
    check('together they are the whole library',
      cloudUnion(shared).tracks.length === 3, JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));

    // Drive nie pokazuje pliku komputera (świeżo wgrany bywa niewidoczny).
    const pcPath = '/home/user/Dysk Google/Pulsar/' + pc.api.ownFile();
    const stats = phone.sandbox.Neutralino.filesystem.getStats;
    phone.sandbox.Neutralino.filesystem.getStats = async (target) => {
      if (target === pcPath) throw new Error('Nie ma takiej ścieżki: ' + target);
      return stats(target);
    };
    const missed = await phone.api.sync();
    check('a device that cannot see another device\u2019s file still syncs', !missed.error, JSON.stringify(missed));
    check('and that file is left exactly as it was',
      shared.files.get(pcPath) === before.get(pc.api.ownFile()),
      JSON.stringify({ before: before.size, now: cloudFiles(shared).length }));
    check('the whole library is still there',
      cloudUnion(shared).tracks.length === 3, JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));

    phone.sandbox.Neutralino.filesystem.getStats = stats;
    await phone.api.sync();
    check('when the file is visible again nothing is missing',
      cloudUnion(shared).tracks.length === 3, JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));
  }

  { // 50. puste spojrzenie na folder nie kasuje biblioteki
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:PHONEONLY01', title: 'Z telefonu', artist: 'Y' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({}), track({ netId: 'youtube:PCLOCAL0001', title: 'Z komputera', artist: 'Z' })] });
    const pane = phone.api.openPanel();
    phone.api.setReadRetry(20);
    pane.querySelector('[data-cloud="auto"]').change(false);
    pc.api.openPanel().querySelector('[data-cloud="auto"]').change(false);
    await wait(20);
    await phone.api.sync();

    const memory = await phone.api.cloudMemory();
    check('a device remembers what it saw in the cloud',
      !!memory && memory.tracks === 3 && memory.devices === 2, JSON.stringify(memory));

    // Drive pokazuje folder jako pusty — dokładnie to, co kasowało bibliotekę.
    const saved = new Map(shared.files);
    shared.files.clear();
    const empty = await phone.api.sync();
    check('an empty view of the folder does not remove anything', !empty.error, JSON.stringify(empty));
    const written = cloudFiles(shared).map((file) => JSON.parse(file.text));
    check('this device writes back what it remembered',
      written.length === 1 && (written[0].tracks || []).length === 3,
      JSON.stringify(written.map((manifest) => (manifest.tracks || []).map((entry) => entry.key))));
    check('and the panel says where the entries came from',
      /Odtworzone z pami\u0119ci/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(0, 120));

    // Komputer wraca do folderu ze swoim plikiem: nic się nie rozjechało.
    shared.files.clear();
    saved.forEach((text, path) => shared.files.set(path, text));
    await pc.api.sync();
    check('the two devices are back in agreement',
      cloudUnion(shared).tracks.length === 3 && cloudUnion(shared).devices.length === 2,
      JSON.stringify({ tracks: cloudUnion(shared).tracks.map((entry) => entry.key), devices: cloudUnion(shared).devices.length }));
  }

  { // 51. pamięć chmury: co wolno odtworzyć, a czego nie
    const env = makeEnv({ tracks: [track({})] });
    const pure = env.api._pure;
    const now = Date.now();
    const memory = {
      schema: 1, app: 'pulsar', updatedAt: now - 1000, at: now,
      device: { id: 'me' },
      devices: [{ id: 'me', name: 'Windows PC' }, { id: 'other', name: 'Pixel 8' }],
      tracks: [
        { key: 'youtube:REMEMBER01', title: 'Pamiętany', updatedAt: now - 5000 },
        { key: 'youtube:DELETED001', title: 'Skasowany', updatedAt: now - 9000 },
      ],
      albums: [],
      removed: [],
    };
    const fresh = {
      schema: 1, app: 'pulsar', updatedAt: now - 100, device: { id: 'other' },
      devices: [{ id: 'other', name: 'Pixel 8' }],
      tracks: [{ key: 'youtube:OTHERONLY1', title: 'Inny', updatedAt: now - 200 }],
      albums: [],
      removed: [{ key: 'youtube:DELETED001', deletedAt: now - 50, device: 'other' }],
    };

    const warm = pure.mergeCloudMemory(fresh, memory);
    check('a remembered entry missing from the read is restored',
      warm.manifest.tracks.some((entry) => entry.key === 'youtube:REMEMBER01') &&
      warm.restored.tracks === 1, JSON.stringify(warm.restored));
    check('but a deletion mark keeps a remembered entry deleted',
      !warm.manifest.tracks.some((entry) => entry.key === 'youtube:DELETED001'),
      JSON.stringify(warm.manifest.tracks.map((entry) => entry.key)));
    check('both devices stay in the file', warm.manifest.devices.length === 2,
      JSON.stringify(warm.manifest.devices.map((entry) => entry.id)));
    const fromMemory = pure.mergeCloudMemory(null, memory);
    check('a missing read is reported as such',
      fromMemory.restored.missing === true && !!fromMemory.manifest &&
      (fromMemory.manifest.tracks || []).length === 2,
      JSON.stringify(fromMemory.restored));

    const desktop = makeEnv({ desktop: true, tracks: [track({})] });
    const helpers = desktop.api._fileHelpers;
    const me = { deviceId: 'dev-aaaaaaaa11112222', name: 'Linux PC' };
    check('the file name follows the system',
      helpers.ownFileName(me, []) === 'pulsar-library-linux.json', helpers.ownFileName(me, []));
    check('a name already taken by another device of the same system is not reused',
      helpers.ownFileName(me, [{ name: 'pulsar-library-linux.json', manifest: { device: { id: 'dev-other' } } }]) ===
      'pulsar-library-linux-11112222.json',
      helpers.ownFileName(me, [{ name: 'pulsar-library-linux.json', manifest: { device: { id: 'dev-other' } } }]));

    const stale = pure.mergeCloudMemory(fresh, Object.assign({}, memory, { at: now - 400 * 24 * 60 * 60 * 1000 }));
    check('a memory older than deletion marks restores nothing',
      stale.restored.stale === true && !stale.manifest.tracks.some((entry) => entry.key === 'youtube:REMEMBER01'),
      JSON.stringify(stale.restored));
  }

  { // 52. plik drugiego urządzenia znika z listy folderu — ponawiamy odczyt
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:PHONEONLY01', title: 'Z telefonu', artist: 'Y' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({}), track({ netId: 'youtube:PCLOCAL0001', title: 'Z komputera', artist: 'Z' })] });
    phone.api.setReadRetry(30);
    const phonePane = phone.api.openPanel();

    await phone.api.sync();   // telefon widzi w folderze oba pliki
    const memory = await phone.api.cloudMemory();
    check('the phone remembers the whole library it saw',
      !!memory && memory.tracks === 3, JSON.stringify(memory));

    // Drive przestaje pokazywać plik komputera — dokładnie to, co widział
    // „android nie widzi biblioteki windowsa”.
    const pcName = pc.api.ownFile();
    const realDirectory = phone.sandbox.Neutralino.filesystem.readDirectory;
    let reads = 0;
    phone.sandbox.Neutralino.filesystem.readDirectory = async (target) => {
      reads++;
      const list = await realDirectory(target);
      return list.filter((entry) => entry.entry !== pcName);
    };
    const outcome = await phone.api.sync();
    check('the folder is asked again when a known file disappears',
      reads >= 3, 'odczytów folderu: ' + reads);
    check('the sync still ends without an error', !outcome.error, JSON.stringify(outcome));
    check('and the library from that file stays in the cloud',
      cloudUnion(shared).tracks.length === 3,
      JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));
    phone.sandbox.Neutralino.filesystem.readDirectory = realDirectory;
    await phone.api.sync();
    check('when the file is visible again nothing is missing',
      cloudUnion(shared).tracks.length === 3,
      JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));
  }

  { // 52b. Drive podaje starszą wersję własnego pliku — pamięć go uzupełnia
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:PHONEONLY01', title: 'Z telefonu', artist: 'Y' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({}), track({ netId: 'youtube:PCLOCAL0001', title: 'Z komputera', artist: 'Z' })] });
    const phonePane = phone.api.openPanel();
    await phone.api.sync();
    check('the phone wrote the whole library to its own file',
      cloudUnion(shared).tracks.length === 3,
      JSON.stringify(cloudUnion(shared).tracks.map((entry) => entry.key)));

    phone.api.setReadRetry(30);
    // Kopia z chmury bez wpisu komputera i bez znacznika kasowania, a plik
    // komputera jest w tej chwili niewidoczny dla telefonu.
    const ownPath = '/home/user/Dysk Google/Pulsar/' + phone.api.ownFile();
    const stale = JSON.parse(shared.files.get(ownPath));
    stale.tracks = stale.tracks.filter((entry) => entry.key !== 'youtube:PCLOCAL0001');
    shared.files.set(ownPath, JSON.stringify(stale));
    const pcName = pc.api.ownFile();
    const realDirectory = phone.sandbox.Neutralino.filesystem.readDirectory;
    phone.sandbox.Neutralino.filesystem.readDirectory = async (target) => {
      const list = await realDirectory(target);
      return list.filter((entry) => entry.entry !== pcName);
    };

    await phone.api.sync();
    phone.sandbox.Neutralino.filesystem.readDirectory = realDirectory;
    check('an entry that vanished without a deletion mark comes back from memory',
      (JSON.parse(shared.files.get(ownPath)).tracks || []).some((entry) => entry.key === 'youtube:PCLOCAL0001'),
      JSON.stringify((JSON.parse(shared.files.get(ownPath)).tracks || []).map((entry) => entry.key)));
    check('and the panel says where it came from',
      /Odtworzone z pamięci/.test(phonePane.querySelector('[data-cloud="status"]').textContent),
      phonePane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(-170));
    check('the computer still finds its track in the cloud',
      (JSON.parse(shared.files.get(ownPath)).removed || []).length === 0 &&
      !(JSON.parse(shared.files.get(ownPath)).removed || []).some((entry) => entry.key === 'youtube:PCLOCAL0001'),
      JSON.stringify(JSON.parse(shared.files.get(ownPath)).removed));
  }

  { // 53. nowy utwór z YouTube z drugiego urządzenia ściąga się sam
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    pc.api.setImportWait(400);
    const pane = pc.api.openPanel();
    const results = [{ provider: 'youtube', id: 'NEWSONG0001', ytId: 'NEWSONG0001', title: 'Nowy z telefonu', artist: 'Wykonawca' }];
    const net = makeNet({
      results,
      onImport: function (index) {
        const item = results[index] || {};
        pc.library.state.tracks.push({ netId: 'youtube:' + item.id, title: item.title, artist: item.artist, durMs: 0, fav: false, plays: 0 });
      },
    });
    pc.sandbox.window.__player = { __net: net };

    phone.library.state.tracks.push(track({ netId: 'youtube:NEWSONG0001', title: 'Nowy z telefonu', artist: 'Wykonawca' }));
    await phone.api.sync();
    await pc.api.sync();
    const status = pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ');
    check('the panel counts what waits for an automatic download',
      /Automatyczne pobieranie: włączone( · czeka na pobranie: 1)?/.test(status), status.slice(-150));

    await wait(900);
    check('the track from the other device downloads by itself',
      pc.library.state.tracks.some((item) => item.netId === 'youtube:NEWSONG0001'),
      JSON.stringify(net.calls));
    check('the panel says what was downloaded automatically',
      /Ostatnio pobrane automatycznie: Nowy z telefonu/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(-160));
    check('and it leaves the cloud-only list',
      !pc.api.cloudOnly().some((entry) => entry.key === 'youtube:NEWSONG0001'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
  }

  { // 54. nieudane pobranie jest widoczne w panelu z powodem
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:GONEVIDEO01', title: 'Nie ma go', artist: 'X' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    pc.api.setImportWait(300);
    const pane = pc.api.openPanel();
    pc.sandbox.window.__player = { __net: makeNet({ results: [] }) };

    await phone.api.sync();
    await pc.api.sync();
    await wait(800);
    const status = pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ');
    check('a failed automatic download is named with its reason',
      /Ostatnie pobieranie nie udało się: Nie ma go — YouTube nie zwrócił/.test(status), status.slice(-170));
    check('and the track waits for another try',
      pc.api.cloudOnly().some((entry) => entry.key === 'youtube:GONEVIDEO01'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
  }

  { // 55. „Pobierz wszystkie tutaj" działa także przy wyłączonym automacie
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:MANUALSONG1', title: 'Ręczny', artist: 'R' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    pc.api.setImportWait(400);
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="auto"]').change(false);
    await wait(20);
    const results = [{ provider: 'youtube', id: 'MANUALSONG1', ytId: 'MANUALSONG1', title: 'Ręczny', artist: 'R' }];
    const net = makeNet({
      results,
      onImport: function (index) {
        const item = results[index] || {};
        pc.library.state.tracks.push({ netId: 'youtube:' + item.id, title: item.title, artist: item.artist, durMs: 0, fav: false, plays: 0 });
      },
    });
    pc.sandbox.window.__player = { __net: net };

    await phone.api.sync();
    await pc.api.sync();
    await wait(700);
    check('with the switch off nothing downloads by itself',
      !pc.library.state.tracks.some((item) => item.netId === 'youtube:MANUALSONG1') && !net.calls.length,
      JSON.stringify(net.calls));
    check('and the panel says the automatic download is off',
      /Automatyczne pobieranie: wyłączone/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(-140));

    const all = pane.querySelector('[data-cloud="downloadAll"]');
    check('the button counts what is waiting', /Pobierz wszystkie tutaj \(1\)/.test(all.textContent), all.textContent);
    all.click();
    await wait(600);
    check('one click downloads the waiting track',
      pc.library.state.tracks.some((item) => item.netId === 'youtube:MANUALSONG1'), JSON.stringify(net.calls));
    check('and the cloud-only list is empty afterwards',
      pc.api.cloudOnly().length === 0, JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
  }

  { // 56. „Odśwież listę plików" mówi, co to urządzenie naprawdę widzi
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({})] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    const pane = phone.api.openPanel();
    await phone.api.sync();

    const pcName = pc.api.ownFile();
    const realDirectory = phone.sandbox.Neutralino.filesystem.readDirectory;
    phone.sandbox.Neutralino.filesystem.readDirectory = async (target) => {
      const list = await realDirectory(target);
      return list.filter((entry) => entry.entry !== pcName);
    };
    pane.querySelector('[data-cloud="refresh"]').click();
    await wait(120);
    check('a refresh names the files this device can see',
      phone.toasts.some((text) => /Widzę pliki: 1/.test(text)), JSON.stringify(phone.toasts.slice(-2)));
    check('and warns when only its own file is visible',
      /tylko własny plik/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(-150));

    phone.sandbox.Neutralino.filesystem.readDirectory = realDirectory;
    pane.querySelector('[data-cloud="refresh"]').click();
    await wait(120);
    check('with both files visible the refresh lists two',
      phone.toasts.some((text) => /Widzę pliki: 2/.test(text)), JSON.stringify(phone.toasts.slice(-1)));
    check('and the warning goes away',
      !/tylko własny plik/.test(pane.querySelector('[data-cloud="status"]').textContent),
      pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ').slice(-140));
  }

  { // 57. biblioteka większa niż to, co jedzie do chmury, jest nazwana w panelu
    const shared = { files: new Map(), dirs: new Set() };
    const env = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:WITHKEY0001' })] });
    const pane = env.api.openPanel();
    env.sandbox.window.__player = { state: () => ({ tracks: 3 }) };
    await env.api.sync();
    const status = pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ');
    check('the panel says how much of the library travels',
      /Biblioteka ma 3 utworów, a do chmury jedzie 1/.test(status), status.slice(-200));
  }

  { // 58. nieudane pobranie bez mostka YouTube nazywa mostek wprost
    const shared = { files: new Map(), dirs: new Set() };
    const phone = await folderEnv({ fs: shared, tracks: [track({ netId: 'youtube:NOBRIDGE001', title: 'Bez mostka', artist: 'X' })] });
    const pc = await folderEnv({ fs: shared, tracks: [track({})] });
    pc.api.setImportWait(300);
    const pane = pc.api.openPanel();
    const net = makeNet({ results: [] });
    net.youtube = {
      bridge: () => ({ ok: false, port: 8787, base: 'http://127.0.0.1:8787', ffmpeg: false }),
      probeBridge: () => Promise.resolve(false),
    };
    pc.sandbox.window.__player = { __net: net };

    await phone.api.sync();
    await pc.api.sync();
    await wait(900);
    const status = pane.querySelector('[data-cloud="status"]').textContent.replace(/\s+/g, ' ');
    check('a failed download names the YouTube bridge when it is down',
      /Mostek do YouTube nie odpowiada/.test(status), status.slice(-200));
    check('and the reason for the failure stays in the panel',
      /Ostatnie pobieranie nie udało się: Bez mostka/.test(status), status.slice(-260));
  }

  { // 59. zakładka Cloud na telefonie przewija się palcem do samego dołu
    const env = makeEnv({
      withPanel: true, folderPicked: true,
      tracks: [track({ netId: 'youtube:SCROLL0001', title: 'Przewijanie', artist: 'X' })],
    });
    const pane = env.api.openPanel();
    const smBody = env.dom.smBody;

    // Telefon: treść zakładki nie mieści się w oknie ustawień, a kontener
    // (#smBody) nie przewija — wtedy dolna część panelu była nieosiągalna.
    env.sandbox.window.innerHeight = 420;
    env.sandbox.window.getComputedStyle = (node) => ({
      overflowY: node && node.getAttribute && node.getAttribute('id') === 'smBody' ? 'auto' : 'visible',
    });
    smBody.clientHeight = 360;
    smBody.scrollHeight = 360;
    pane.getBoundingClientRect = () => ({ top: 40, bottom: 400, height: 360 });
    pane.scrollHeight = 2400;
    pane.clientHeight = 360;

    env.api.showPane('cloud');
    await wait(480);
    check('the cloud tab scrolls by touch on a phone',
      pane.getAttribute('data-cloud-scroll') === 'self', String(env.api.scrollInfo().mode));
    const room = Number(String(pane.style.maxHeight || '').replace('px', ''));
    check('and it is capped to the settings window height',
      room >= 160 && room <= 420, String(pane.style.maxHeight));
    check('the pane really hangs in the scrolling body of settings',
      pane.parentNode === smBody, String(pane.parentNode && pane.parentNode.getAttribute('id')));

    // Gdyby WebView i tak nie przewinął panelu, przewijamy treść sami.
    pane.dispatchEvent({ type: 'touchstart', touches: [{ clientY: 300 }] });
    pane.dispatchEvent({ type: 'touchmove', touches: [{ clientY: 200 }] });
    pane.dispatchEvent({ type: 'touchmove', touches: [{ clientY: 100 }] });
    check('a finger drag moves the tab when the WebView will not', pane.scrollTop > 0, String(pane.scrollTop));
    pane.dispatchEvent({ type: 'touchend' });

    // Gdy kontener ustawień przewija sam (szersze okno), panelu nie ruszamy.
    smBody.scrollHeight = 2000;
    env.api.showPane('cloud');
    await wait(480);
    check('a container that already scrolls keeps its own scrolling',
      pane.getAttribute('data-cloud-scroll') === null && !pane.style.maxHeight,
      String(pane.style.maxHeight));

    // Style panelu wchodzą raz, choćby panel powstawał wielokrotnie.
    env.api.openPanel();
    const styles = env.document.querySelectorAll('style').filter((node) => node.getAttribute('id') === 'pulsarCloudPanelStyles');
    check('the cloud styles are attached exactly once',
      styles.length === 1 && /overflow-scrolling: touch/.test(styles[0].textContent),
      String(styles.length));
  }

  { // 60. automat ściąga z YouTube także pliki z komputera — po tytule i autorze
    const shared = { files: new Map(), dirs: new Set() };
    const author = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: '', size: 2048, hash: 'beef01', title: 'Z komputera', artist: 'Ktoś Inny' })],
    });
    const authorPane = author.api.openPanel();
    authorPane.querySelector('[data-cloud="auto"]').change(false);
    authorPane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    author.api.setEnabled(true);
    await author.api.sync();

    const net = makeNet({
      results: [{ provider: 'youtube', id: 'AUTOSEARCH01', ytId: 'AUTOSEARCH01', title: 'Z komputera', artist: 'Ktoś Inny', ytStream: true }],
    });
    const other = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: 'youtube:BASE0000001', title: 'Baza', artist: 'X' })],
    });
    const pane = other.api.openPanel();
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    other.api.setEnabled(true);
    net.importIdx = function (index) {
      net.calls.push(['import', index]);
      other.library.state.tracks.push(track({ netId: 'youtube:AUTOSEARCH01', title: 'Z komputera', artist: 'Ktoś Inny' }));
      return Promise.resolve();
    };
    other.sandbox.window.__player = { __net: net };

    await other.api.sync();
    await wait(1200);
    check('the automatic download looks up a file that has no YouTube id',
      net.calls.some((call) => call[0] === 'search' && call[1] === 'Ktoś Inny Z komputera'), JSON.stringify(net.calls));
    check('and imports what YouTube returned',
      net.calls.some((call) => call[0] === 'import' && call[1] === 0), JSON.stringify(net.calls));
    check('the panel remembers the file as downloaded here',
      !!other.api.derived()['fp:2048:beef01'], JSON.stringify(other.api.derived()));
    check('the last automatic download is reported as successful',
      !!other.api.autoLast() && other.api.autoLast().ok === true && /Z komputera/.test(other.api.autoLast().title || ''),
      JSON.stringify(other.api.autoLast()));
    check('nothing waits to be downloaded any more',
      !other.api.cloudOnly().some((entry) => entry.key === 'fp:2048:beef01'),
      JSON.stringify(other.api.cloudOnly().map((entry) => entry.key)));
  }

  { // 61. wpis bez tytułu nie ma czego szukać — panel mówi to wprost
    const shared = { files: new Map(), dirs: new Set() };
    const phone = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: '', size: 777, hash: 'noname1', title: '', artist: '' })],
    });
    const phonePane = phone.api.openPanel();
    phonePane.querySelector('[data-cloud="auto"]').change(false);
    phonePane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    phone.api.setEnabled(true);
    await phone.api.sync();

    const pc = makeEnv({ desktop: true, fs: shared, tracks: [track({})], withPanel: true });
    const pane = pc.api.openPanel();
    pane.querySelector('[data-cloud="auto"]').change(false);
    pane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.api.setEnabled(true);
    await pc.api.sync();

    const card = pane.querySelector('[data-cloud-section="cloudOnly"]');
    check('an entry with no title is listed', pc.api.cloudOnly().length === 1,
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
    check('but it gets no download button', card.querySelectorAll('[data-cloud-download]').length === 0);
    check('the panel says there is nothing to look up',
      /nie ma po czym szukać|nothing to look up/i.test(card.textContent),
      card.textContent.replace(/\s+/g, ' ').slice(0, 120));
  }

  { // 62. ta sama piosenka pod dwoma kluczami nie ściąga się drugi raz
    const shared = { files: new Map(), dirs: new Set() };
    // Komputer ma plik z dysku; telefon ma tę samą piosenkę pobraną z YouTube.
    const pc = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: '', size: 4096, hash: 'giants01', title: 'Giants', artist: 'Imagine Dragons' })],
    });
    const pcPane = pc.api.openPanel();
    pcPane.querySelector('[data-cloud="auto"]').change(false);
    pcPane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    pc.api.setEnabled(true);
    await pc.api.sync();

    const phone = makeEnv({
      desktop: true, fs: shared, withPanel: true,
      tracks: [track({ netId: 'youtube:COPY0000001', title: 'Giants', artist: 'Imagine Dragons' })],
    });
    const phonePane = phone.api.openPanel();
    phonePane.querySelector('[data-cloud="auto"]').change(false);
    phonePane.querySelector('[data-cloud="choose"]').click();
    await wait(40);
    phone.api.setEnabled(true);
    await phone.api.sync();
    await phone.api.sync();
    await pc.api.sync();

    check('the cloud really carries both entries before filtering',
      pc.api.cloudMeta().tracks === 2 && phone.api.cloudMeta().tracks === 2,
      String(pc.api.cloudMeta().tracks) + ' / ' + String(phone.api.cloudMeta().tracks));
    check('the computer does not offer to fetch a song it already has as a file',
      !pc.api.cloudOnly().some((entry) => entry.key === 'youtube:COPY0000001'),
      JSON.stringify(pc.api.cloudOnly().map((entry) => entry.key)));
    check('the phone does not offer to fetch the computer file of the song it already has',
      !phone.api.cloudOnly().some((entry) => entry.key === 'fp:4096:giants01'),
      JSON.stringify(phone.api.cloudOnly().map((entry) => entry.key)));
    check('both libraries still hold both entries',
      pc.api.state().enabled === true && typeof pc.api._pure.namePair === 'function' &&
        pc.api._pure.namePair({ title: 'Giants (Remastered)', artist: 'Imagine Dragons' }) === 'giants|imagine dragons',
      String(pc.api._pure.namePair({ title: 'Giants (Remastered)', artist: 'Imagine Dragons' })));
  }

  await checkRuntimeHooks();
  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL'));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})();
