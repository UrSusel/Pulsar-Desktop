/* Pulsar Linux desktop layer.
 *
 * This file is intentionally separate from the Windows bridge.  It keeps the
 * shared player UI intact while replacing PowerShell/WinForms/Windows paths
 * with POSIX tools and Neutralino's cross-platform APIs.
 */
(function () {
  'use strict';
  if (typeof Neutralino === 'undefined') return;

  try { Neutralino.init(); } catch (e) {}

  const APP_DIR = (typeof NL_PATH === 'string' && NL_PATH) ? NL_PATH : '.';
  const TMP_FALLBACK = APP_DIR.replace(/[\\/]+$/, '') + '/tmp';
  const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;
  const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm', webm: 'audio/webm' };
  const K = { mini: 'pulsarLinuxMini', miniGeo: 'pulsarLinuxMiniGeo', normalGeo: 'pulsarLinuxNormalGeo', onTop: 'pulsarLinuxOnTop', closeToTray: 'pulsarLinuxCloseToTray', notify: 'pulsarLinuxNotify', watchDir: 'pulsarLinuxWatchDir' };
  const MINI = { width: 480, height: 440, minWidth: 360, minHeight: 300 };
  const NORMAL = { width: 1280, height: 840, minWidth: 760, minHeight: 560 };
  const W = Neutralino.window;
  let tmpDir = null;
  let ytDlpPath = null;
  let ffmpegPath = null;
  let commandChain = Promise.resolve();
  let mini = false;
  let onTop = getBool(K.onTop, false);
  let closeToTray = getBool(K.closeToTray, false);
  let trayReady = false;
  let hidden = false;
  let focused = true;
  let quitting = false;
  let refreshTimer = 0;

  function getBool(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch (e) { return fallback; }
  }
  function setBool(key, value) { try { localStorage.setItem(key, value ? '1' : '0'); } catch (e) {} }
  function getJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function setJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function joinPath(a, b) { return String(a).replace(/[\\/]+$/, '') + '/' + String(b).replace(/^[/\\]+/, ''); }
  function baseName(path) { return String(path || '').replace(/[\\/]+$/, '').split('/').pop().split('\\').pop(); }
  function ext(path) { const m = /\.([a-z0-9]+)$/i.exec(String(path || '')); return m ? m[1].toLowerCase() : ''; }
  function normalizePath(path) { return String(path || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
  function relPath(path, root) { return baseName(root) + '/' + normalizePath(path).slice(normalizePath(root).length + 1); }
  function shellQuote(value) { return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'"; }
  function uuid() { return 'pulsar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function host() { return window.__pulsarHost || null; }
  function tr(value) { try { return host() && host().t ? host().t(value) : value; } catch (e) { return value; } }
  function toast(value) { try { if (host() && host().toast) host().toast(value); } catch (e) {} }
  function safe(fn) { try { return Promise.resolve(fn()).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); } }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function execOutput(result) {
    return {
      stdout: String((result && (result.stdOut != null ? result.stdOut : result.stdout)) || ''),
      stderr: String((result && (result.stdErr != null ? result.stdErr : result.stderr)) || '').trim(),
      code: result && typeof result.exitCode === 'number' ? result.exitCode : 0
    };
  }
  function run(command, timeout) {
    const limit = timeout || 240000;
    const job = commandChain.then(function () {
      return Promise.race([
        Neutralino.os.execCommand('sh -lc ' + shellQuote(command)),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, limit); })
      ]);
    });
    commandChain = job.catch(function () {});
    return job;
  }
  function parseJson(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    try { return JSON.parse(value); } catch (e) {}
    const start = value.indexOf('{');
    if (start >= 0) { try { return JSON.parse(value.slice(start)); } catch (e) {} }
    return null;
  }
  async function getTmp() {
    if (tmpDir) return tmpDir;
    let root = '';
    try { root = await Neutralino.os.getEnv('XDG_CACHE_HOME'); } catch (e) {}
    tmpDir = root ? joinPath(root, 'pulsar') : TMP_FALLBACK;
    try { await Neutralino.filesystem.createDirectory(tmpDir); } catch (e) {}
    return tmpDir;
  }
  async function exists(path) {
    try { await Neutralino.filesystem.getStats(path); return true; } catch (e) { return false; }
  }
  async function resolveTool(name, cached) {
    if (cached && await exists(cached)) return cached;
    const local = joinPath(APP_DIR, name);
    if (await exists(local)) return local;
    try {
      const out = execOutput(await run('command -v ' + shellQuote(name), 6000)).stdout.trim().split(/\s+/)[0];
      return out || null;
    } catch (e) { return null; }
  }
  async function getTools() {
    ytDlpPath = await resolveTool('yt-dlp', ytDlpPath);
    ffmpegPath = await resolveTool('ffmpeg', ffmpegPath);
    return { yt: ytDlpPath, ffmpeg: ffmpegPath };
  }
  async function ytdlp(args, timeout) {
    const tools = await getTools();
    if (!tools.yt) throw new Error(tr('yt-dlp nie znaleziony — dołącz go do folderu aplikacji albo zainstaluj w systemie.'));
    const result = execOutput(await run(shellQuote(tools.yt) + ' ' + args + ' --no-warnings --no-progress', timeout));
    if (result.code && !result.stdout.trim()) throw new Error(result.stderr || 'yt-dlp failed');
    return { out: parseJson(result.stdout), raw: result.stdout, stderr: result.stderr, code: result.code };
  }
  function mapEntry(entry) {
    if (!entry || !entry.id) return null;
    return { id: String(entry.id), ytId: String(entry.id), title: entry.title || '', uploader: entry.uploader || entry.channel || 'YouTube', duration: typeof entry.duration === 'number' ? entry.duration : 0 };
  }
  async function makeDownload(id, mode) {
    const tools = await getTools();
    if (!tools.yt) throw new Error('yt-dlp not found');
    const tmp = await getTmp();
    const stem = joinPath(tmp, uuid());
    let format = 'bestaudio/best';
    let args = '--no-playlist -f ' + shellQuote(format) + ' -o ' + shellQuote(stem + '.%(ext)s');
    if (mode === 'mp3' && tools.ffmpeg) args = '--no-playlist -f bestaudio/best -x --audio-format mp3 --audio-quality 192K --ffmpeg-location ' + shellQuote(tools.ffmpeg) + ' -o ' + shellQuote(stem + '.%(ext)s');
    else if (mode === 'save' && !tools.ffmpeg) args = '--no-playlist -f bestaudio[ext=m4a]/bestaudio/best -o ' + shellQuote(stem + '.%(ext)s');
    args += ' ' + shellQuote('https://www.youtube.com/watch?v=' + id);
    await ytdlp(args, 300000);
    const entries = await Neutralino.filesystem.readDirectory(tmp);
    const fileName = function (entry) { return String((entry && (entry.entry != null ? entry.entry : entry.name)) || ''); };
    const hit = (entries || []).find(function (entry) { const n = fileName(entry); return entry && entry.type === 'FILE' && n.indexOf(baseName(stem)) === 0 && /\.(mp3|m4a|webm|opus|ogg)$/i.test(n); });
    if (!hit) throw new Error('download failed');
    const name = fileName(hit);
    return { path: joinPath(tmp, name), name: name, ext: ext(name), mime: MIME[ext(name)] || 'audio/mp4' };
  }
  async function readAndRemove(path) {
    const bytes = await Neutralino.filesystem.readBinaryFile(path);
    try { await Neutralino.filesystem.remove(path); } catch (e) {}
    return bytes;
  }
  async function writeBinary(path, data) {
    const buffer = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    return Neutralino.filesystem.writeBinaryFile(path, buffer);
  }
  function jsonResponse(value, status) { return new Response(JSON.stringify(value), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
  async function endpoint(url) {
    const path = url.pathname;
    if (path === '/ping') {
      const tools = await getTools();
      let version = '';
      if (tools.yt) { try { version = execOutput(await run(shellQuote(tools.yt) + ' --version', 10000)).stdout.trim(); } catch (e) {} }
      return jsonResponse({ ok: !!(tools.yt && version), ytdlp: !!(tools.yt && version), ffmpeg: !!tools.ffmpeg, version: version, platform: 'linux' });
    }
    if (path === '/savedir') {
      const dir = normalizePath(url.searchParams.get('dir') || '');
      if (!dir) return jsonResponse({ ok: true, dir: '' });
      try { await Neutralino.filesystem.createDirectory(dir); return jsonResponse({ ok: true, dir: dir }); }
      catch (e) { return jsonResponse({ ok: false, error: String(e.message || e) }, 400); }
    }
    if (path === '/search') {
      const term = String(url.searchParams.get('q') || '').trim();
      if (!term) return jsonResponse({ ok: true, items: [] });
      const r = await ytdlp('--flat-playlist --dump-single-json --playlist-end 12 ' + shellQuote('ytsearch12:' + term), 60000);
      const items = r.out && Array.isArray(r.out.entries) ? r.out.entries.map(mapEntry).filter(Boolean) : [];
      return jsonResponse({ ok: true, items: items });
    }
    if (path === '/playlist') {
      const source = String(url.searchParams.get('u') || '').trim();
      const r = await ytdlp('--flat-playlist --dump-single-json --playlist-end 100 ' + shellQuote(source), 120000);
      return jsonResponse({ ok: true, title: r.out && r.out.title || 'Playlista', items: (r.out && r.out.entries || []).map(mapEntry).filter(Boolean) });
    }
    if (path === '/audio' || path === '/mp3') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return new Response('missing id', { status: 400 });
      const file = await makeDownload(id, path === '/mp3' ? 'mp3' : 'play');
      const bytes = await readAndRemove(file.path);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': file.mime, 'Cache-Control': 'no-store' } });
    }
    if (path === '/mp3save') {
      const id = String(url.searchParams.get('id') || '').trim();
      const dir = normalizePath(url.searchParams.get('dir') || '');
      if (!id || !dir) return jsonResponse({ ok: false, error: tr('Nie ustawiono folderu na dysku') }, 400);
      await Neutralino.filesystem.createDirectory(dir);
      const meta = await ytdlp('--dump-single-json --no-playlist ' + shellQuote('https://www.youtube.com/watch?v=' + id), 30000);
      const file = await makeDownload(id, 'save');
      const safeTitle = String((meta.out && meta.out.title) || id).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || id;
      const dest = joinPath(dir, safeTitle + '.' + file.ext);
      await writeBinary(dest, await Neutralino.filesystem.readBinaryFile(file.path));
      try { await Neutralino.filesystem.remove(file.path); } catch (e) {}
      return jsonResponse({ ok: true, dir: dir, file: baseName(dest), path: dest });
    }
    return new Response('pulsar linux bridge: unknown endpoint', { status: 404 });
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  function bridgeUrl(value) {
    try {
      const u = new URL(value, location.href);
      if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') || String(u.port) === String(location.port)) return null;
      return u;
    } catch (e) { return null; }
  }
  if (originalFetch) {
    window.fetch = function (input, init) {
      const raw = typeof input === 'string' ? input : input && input.url || '';
      const u = bridgeUrl(raw);
      return u ? endpoint(u).catch(function (e) { return jsonResponse({ ok: false, error: String(e.message || e) }, 500); }) : originalFetch(input, init);
    };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor && descriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        get: descriptor.get,
        set: function (value) {
          const u = bridgeUrl(value);
          if (!u || (u.pathname !== '/audio' && u.pathname !== '/mp3')) { descriptor.set.call(this, value); return; }
          const media = this;
          endpoint(u).then(function (response) { if (!response.ok) throw new Error('audio download failed'); return response.blob(); }).then(function (blob) { descriptor.set.call(media, URL.createObjectURL(blob)); }).catch(function () { try { media.dispatchEvent(new Event('error')); } catch (e) {} });
        }
      });
    }
  } catch (e) {}

  window.__pulsarFs = {
    writeBinary: writeBinary,
    readBinary: function (path) { return Neutralino.filesystem.readBinaryFile(path); },
    appendBinary: function (path, data) { const b = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data; return Neutralino.filesystem.appendBinaryFile(path, b); },
    saveDialog: function (title, name, extension, label) {
      return Neutralino.os.showSaveDialog(title, { defaultPath: name, filters: [{ name: label || extension, extensions: [extension] }, { name: 'All files', extensions: ['*'] }] }).then(function (path) { if (!path) return ''; return /\.[a-z0-9]+$/i.test(path) ? path : path + '.' + extension; });
    }
  };

  function getHost() { return window.__pulsarHost || null; }
  function syncSettings() {
    const top = document.getElementById('smOnTop'); if (top) top.checked = onTop;
    const close = document.getElementById('smCloseToTray'); if (close) close.checked = closeToTray;
    const notify = document.getElementById('smNotify'); if (notify) notify.checked = getBool(K.notify, false);
    const miniBtn = document.getElementById('smMiniBtn'); if (miniBtn) miniBtn.textContent = tr('Włącz');
  }
  async function readGeometry() {
    const size = await safe(function () { return W.getSize(); });
    const position = await safe(function () { return W.getPosition(); });
    return size && size.width > 50 ? { width: size.width, height: size.height, x: position && position.x, y: position && position.y } : null;
  }
  async function setMini(value, options) {
    options = options || {};
    if (typeof value !== 'boolean') value = !mini;
    if (value === mini) return;
    if (value) {
      if (!options.startup) { const geometry = await readGeometry(); if (geometry && geometry.width > 700) setJson(K.normalGeo, geometry); }
      mini = true; setBool(K.mini, true); document.documentElement.classList.add('nl-mini');
      const saved = getJson(K.miniGeo) || {};
      await safe(function () { return W.setSize({ width: Math.max(MINI.minWidth, saved.width || MINI.width), height: Math.max(MINI.minHeight, saved.height || MINI.height), minWidth: MINI.minWidth, minHeight: MINI.minHeight }); });
      if (saved.x != null && saved.y != null) await safe(function () { return W.move(saved.x, saved.y); });
    } else {
      const geometry = await readGeometry(); if (geometry) setJson(K.miniGeo, geometry);
      mini = false; setBool(K.mini, false); document.documentElement.classList.remove('nl-mini');
      const saved = getJson(K.normalGeo) || {};
      await safe(function () { return W.setSize({ width: Math.max(NORMAL.minWidth, saved.width || NORMAL.width), height: Math.max(NORMAL.minHeight, saved.height || NORMAL.height), minWidth: NORMAL.minWidth, minHeight: NORMAL.minHeight }); });
      if (saved.x != null && saved.y != null) await safe(function () { return W.move(saved.x, saved.y); }); else await safe(function () { return W.center(); });
    }
    await safe(function () { return W.setAlwaysOnTop(mini ? getBool('pulsarLinuxMiniOnTop', true) : onTop); });
    try { document.dispatchEvent(new CustomEvent('pulsar:mini', { detail: { on: mini } })); } catch (e) {}
    syncSettings(); refreshTray();
  }
  function toggleOnTop() { onTop = !onTop; setBool(K.onTop, onTop); safe(function () { return W.setAlwaysOnTop(mini ? getBool('pulsarLinuxMiniOnTop', true) : onTop); }); syncSettings(); refreshTray(); }
  function showWindow() { hidden = false; return safe(function () { return W.show(); }); }
  function hideWindow() { hidden = true; return safe(function () { return W.hide(); }); }
  function quit() { quitting = true; return safe(function () { return Neutralino.app.exit(); }); }
  function nowPlaying() { try { return getHost() && getHost().nowPlaying ? getHost().nowPlaying() : null; } catch (e) { return null; } }
  function refreshTray() {
    if (!trayReady) return;
    const np = nowPlaying();
    const items = [
      { id: 'np', text: np && np.title ? String(np.title).slice(0, 64) : tr('Nic nie gra'), isDisabled: true },
      { text: '-' },
      { id: 'toggle', text: tr(np && np.playing ? 'Pauza' : 'Odtwórz'), isDisabled: !(np && np.hasTracks) },
      { id: 'prev', text: tr('Poprzedni'), isDisabled: !(np && np.hasTracks) },
      { id: 'next', text: tr('Następny'), isDisabled: !(np && np.hasTracks) },
      { text: '-' },
      { id: 'show', text: hidden ? tr('Pokaż okno') : tr('Ukryj okno') },
      { id: 'mini', text: tr('Tryb mini'), isChecked: mini },
      { id: 'top', text: tr('Zawsze na wierzchu'), isChecked: mini ? getBool('pulsarLinuxMiniOnTop', true) : onTop },
      { id: 'close', text: tr('Zamykaj do zasobnika'), isChecked: closeToTray },
      { text: '-' },
      { id: 'quit', text: tr('Zakończ') }
    ];
    safe(function () { return Neutralino.os.setTray({ icon: '/resources/icons/trayIcon.png', menuItems: items }); });
  }
  function onTray(event) {
    const id = event && event.detail && event.detail.id;
    const h = getHost();
    if (id === 'toggle' && h) h.toggle();
    else if (id === 'prev' && h) h.prev();
    else if (id === 'next' && h) h.next();
    else if (id === 'show') hidden ? showWindow() : hideWindow();
    else if (id === 'mini') setMini(!mini);
    else if (id === 'top') toggleOnTop();
    else if (id === 'close') { closeToTray = !closeToTray; setBool(K.closeToTray, closeToTray); refreshTray(); }
    else if (id === 'quit') quit();
  }

  /* Linux folder watcher: polling is portable and avoids inotify-specific native code. */
  const watcher = { dir: '', timer: 0, seen: {} };
  async function listFiles(dir, output) {
    output = output || [];
    let entries = [];
    try { entries = await Neutralino.filesystem.readDirectory(dir); } catch (e) { return output; }
    for (const entry of entries || []) {
      const name = String(entry.entry != null ? entry.entry : entry.name || '');
      const path = joinPath(dir, name);
      if (entry.type === 'DIRECTORY') await listFiles(path, output);
      else if (entry.type === 'FILE' && AUDIO_RE.test(name)) output.push(path);
    }
    return output;
  }
  async function scanFolder() {
    if (!watcher.dir || !getHost() || !getHost().importFiles) return;
    const files = await listFiles(watcher.dir);
    const known = getHost().libraryPaths ? getHost().libraryPaths() : new Set();
    for (const path of files) {
      const key = normalizePath(path).toLowerCase();
      if (watcher.seen[key] || known.has(key)) continue;
      try {
        const bytes = await Neutralino.filesystem.readBinaryFile(path);
        const stat = await Neutralino.filesystem.getStats(path);
        const file = new File([bytes], baseName(path), { type: MIME[ext(path)] || '', lastModified: stat && stat.modifiedAt || Date.now() });
        const relative = relPath(path, watcher.dir);
        try { Object.defineProperty(file, 'webkitRelativePath', { value: relative }); } catch (e) {}
        file.__srcPath = normalizePath(path);
        getHost().importFiles([file]);
        if (getHost().adoptPath) getHost().adoptPath(relative, stat && stat.size || file.size, normalizePath(path));
        watcher.seen[key] = 1;
      } catch (e) {}
    }
    try { localStorage.setItem('pulsarLinuxWatchSeen', JSON.stringify(watcher.seen)); } catch (e) {}
  }
  async function chooseFolder() {
    try {
      const dir = await Neutralino.os.showFolderDialog(tr('Wybierz folder z muzyką'));
      if (!dir) return;
      watcher.dir = normalizePath(dir); setBool(K.watchDir, true); localStorage.setItem(K.watchDir + ':path', watcher.dir); watcher.seen = {};
      updateWatcherUi(); scanFolder();
    } catch (e) { toast(tr('Nie udało się wybrać folderu')); }
  }
  function disableWatcher() { watcher.dir = ''; try { localStorage.removeItem(K.watchDir + ':path'); localStorage.removeItem('pulsarLinuxWatchSeen'); } catch (e) {} updateWatcherUi(); }
  function updateWatcherUi() {
    const label = document.getElementById('smWatchPath'); if (label) label.textContent = watcher.dir || tr('nie wybrano');
    const choose = document.getElementById('smWatchBtn'); if (choose) choose.textContent = tr(watcher.dir ? 'Zmień folder…' : 'Wybierz folder…');
    const off = document.getElementById('smWatchOff'); if (off) off.hidden = !watcher.dir;
  }
  function initWatcher() {
    try { watcher.dir = normalizePath(localStorage.getItem(K.watchDir + ':path') || ''); watcher.seen = JSON.parse(localStorage.getItem('pulsarLinuxWatchSeen') || '{}') || {}; } catch (e) {}
    const choose = document.getElementById('smWatchBtn'); if (choose) choose.addEventListener('click', chooseFolder);
    const off = document.getElementById('smWatchOff'); if (off) off.addEventListener('click', disableWatcher);
    updateWatcherUi();
    clearInterval(watcher.timer); watcher.timer = setInterval(scanFolder, 5000); setTimeout(scanFolder, 1800);
  }

  function initTray() {
    safe(function () { return Neutralino.os.setTray({ icon: '/resources/icons/trayIcon.png', menuItems: [] }); }).then(function (result) {
      if (result !== null) { trayReady = true; refreshTray(); }
    });
  }
  function init() {
    document.documentElement.classList.add('nl-desktop', 'nl-linux');
    initTray();
    window.__pulsarDesktop = { setMini: setMini, isMini: function () { return mini; }, toggleOnTop: toggleOnTop, isOnTop: function () { return mini ? getBool('pulsarLinuxMiniOnTop', true) : onTop; }, show: showWindow, hide: hideWindow, quit: quit, linux: true };
    window.__pulsarDesktop.obs = { enabled: function () { return false; }, set: function () { toast(tr('OBS audio bridge jest dostępny w wersji Windows; overlay może działać jako Browser Source.')); }, files: function () { return true; }, help: function () { toast(tr('Dodaj plik obs/pulsar-obs.html jako Browser Source w OBS.')); } };
    const miniButton = document.getElementById('smMiniBtn'); if (miniButton) miniButton.addEventListener('click', function () { const menu = document.getElementById('settingsMenu'); if (menu) menu.hidden = true; setMini(true); });
    const top = document.getElementById('smOnTop'); if (top) top.addEventListener('change', function () { onTop = top.checked; setBool(K.onTop, onTop); safe(function () { return W.setAlwaysOnTop(onTop); }); refreshTray(); });
    const close = document.getElementById('smCloseToTray'); if (close) close.addEventListener('change', function () { closeToTray = close.checked; setBool(K.closeToTray, closeToTray); refreshTray(); });
    const notify = document.getElementById('smNotify'); if (notify) notify.addEventListener('change', function () { setBool(K.notify, notify.checked); });
    initWatcher(); syncSettings();
    document.addEventListener('pulsar:state', function () { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshTray, 100); });
    document.addEventListener('pulsar:lang', function () { syncSettings(); refreshTray(); updateWatcherUi(); });
    try { Neutralino.events.on('windowClose', function () { if (!quitting && closeToTray && trayReady) hideWindow(); else quit(); }); } catch (e) {}
    try { Neutralino.events.on('trayMenuItemClicked', onTray); } catch (e) {}
    safe(function () { return W.setAlwaysOnTop(onTop); });
    if (getBool(K.mini, false)) setMini(true, { startup: true });
    refreshTray();
  }
  try { Neutralino.events.on('ready', function () { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init(); }); } catch (e) { setTimeout(init, 300); }
})();
