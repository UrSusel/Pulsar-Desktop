// Testy przeglądarkowe Pulsara (headless Chromium).
//   NODE_PATH=<katalog z puppeteer-core i @sparticuz/chromium> node tests/browser-test.mjs <media-dir> [gapless|tags|backup|desktop|obs|settings|library|covers|all]
// Tryb „przeglądarka”: neutralino.js podmieniony na pusty plik (desktop.js się nie włącza).
// Tryb „desktop”: neutralino.js podmieniony na stub, którego system plików i execCommand obsługuje Node
//   (yt-dlp jest symulowany — sprawdzamy logikę aktualizacji, nie sieć).
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'x.js'));
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RES = process.env.RES_DIR || path.resolve(HERE, '../app/resources');
const MEDIA = path.resolve(process.argv[2] || '/home/user/work');
const WHICH = process.argv[3] || 'all';
const OUT = path.join(MEDIA, 'bt-out'); fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = 'http://pulsar.test';
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png', svg: 'image/svg+xml', json: 'application/json', css: 'text/css' };

let failures = 0;
function check(name, ok, info){ console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); if (!ok) failures++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, ms = 15000, step = 100){ const t0 = Date.now(); while (Date.now() - t0 < ms){ const v = await fn(); if (v) return v; await sleep(step); } return null; }

async function launch(){
  const args = chromium.args.filter(a => a !== '--mute-audio' && !a.startsWith('--single-process'))
    .concat(['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files']);
  return puppeteer.launch({ args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 840 } });
}

/* ---------------- stub Neutralino (tryb desktop) ---------------- */
const STUB = String.raw`
(function(){
  var handlers = {};
  function call(op){ var a = Array.prototype.slice.call(arguments, 1); return window.__nfs(op, JSON.stringify(a)).then(function(r){ r = JSON.parse(r); if (r && r.__err) { var e = new Error(r.__err); e.code = r.code; throw e; } return r; }); }
  function b64ToAb(b){ var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
  function abToB64(ab){ var u = new Uint8Array(ab), s = ''; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  var noop = function(){ return Promise.resolve(null); };
  var anyNs = function(extra){ return new Proxy(extra || {}, { get: function(t, k){ return k in t ? t[k] : noop; } }); };
  window.NL_PATH = window.__NL_PATH; window.NL_PORT = 47329; window.NL_TOKEN = 'a.b.c';
  window.Neutralino = {
    init: function(){},
    events: { on: function(e, f){ (handlers[e] = handlers[e] || []).push(f); return Promise.resolve(); }, off: noop, dispatch: noop, broadcast: noop },
    filesystem: anyNs({
      readDirectory: function(p, o){ return call('readDirectory', p, o || {}); },
      getStats: function(p){ return call('getStats', p); },
      readBinaryFile: function(p){ return call('readBinaryFile', p).then(b64ToAb); },
      writeBinaryFile: function(p, ab){ return call('writeBinaryFile', p, abToB64(ab)); },
      appendBinaryFile: function(p, ab){ return call('appendBinaryFile', p, abToB64(ab)); },
      writeFile: function(p, s){ return call('writeFile', p, s); },
      createDirectory: function(p){ return call('createDirectory', p); },
      remove: function(p){ return call('remove', p); },
      createWatcher: function(p){ return call('createWatcher', p); },
      removeWatcher: function(id){ return call('removeWatcher', id); }
    }),
    os: anyNs({
      execCommand: function(c){ return call('execCommand', c); },
      getEnv: function(){ return Promise.resolve(window.__NL_TMP); },
      showFolderDialog: function(t, o){ return call('showFolderDialog', t, o); },
      showSaveDialog: function(t, o){ return call('showSaveDialog', t, o); }
    }),
    window: anyNs({ getTitle: function(){ return Promise.resolve('Pulsar'); } }),
    app: anyNs({}),
    storage: anyNs({})
  };
  window.__nlEmit = function(e, d){ (handlers[e] || []).forEach(function(f){ try { f({ detail: d }); } catch(x){ console.error(x); } }); };
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(function(){ window.__nlEmit('ready', {}); }, 50); });
})();
`;

function makeNodeFs(state){
  const toNative = p => String(p).replace(/\\/g, '/');
  return async function(op, argsJson){
    const a = JSON.parse(argsJson);
    try {
      switch (op){
        case 'readDirectory': {
          const root = toNative(a[0]), rec = a[1] && a[1].recursive, out = [];
          const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })){ const p = path.join(d, e.name); out.push({ entry: e.name, path: p, type: e.isDirectory() ? 'DIRECTORY' : e.isFile() ? 'FILE' : 'OTHER' }); if (rec && e.isDirectory()) walk(p); } };
          walk(root); return JSON.stringify(out);
        }
        case 'getStats': {
          const p = toNative(a[0]);
          if (/yt-dlp\.exe$/.test(p)) return JSON.stringify({ size: 1, isFile: true, isDirectory: false, createdAt: 0, modifiedAt: 0 });
          if (/ffmpeg\.exe$/.test(p)) return JSON.stringify({ __err: 'NE_FS_NOPATHE' });
          const st = fs.statSync(p); return JSON.stringify({ size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), createdAt: st.birthtimeMs, modifiedAt: st.mtimeMs });
        }
        case 'readBinaryFile': return JSON.stringify(fs.readFileSync(toNative(a[0])).toString('base64'));
        case 'writeBinaryFile': state.writes.push(toNative(a[0])); fs.writeFileSync(toNative(a[0]), Buffer.from(a[1], 'base64')); return 'null';
        case 'appendBinaryFile': fs.appendFileSync(toNative(a[0]), Buffer.from(a[1], 'base64')); return 'null';
        case 'writeFile': fs.mkdirSync(path.dirname(toNative(a[0])), { recursive: true }); fs.writeFileSync(toNative(a[0]), a[1]); return 'null';
        case 'createDirectory': fs.mkdirSync(toNative(a[0]), { recursive: true }); return 'null';
        case 'remove': fs.rmSync(toNative(a[0]), { force: true, recursive: true }); return 'null';
        case 'createWatcher': {
          const dir = toNative(a[0]); const id = ++state.watchSeq;
          const w = fs.watch(dir, { recursive: true }, (ev, fn) => { state.emit('watchFile', { id, action: ev === 'rename' ? 'add' : 'modified', dir, filename: fn ? path.basename(fn) : '' }); });
          state.watchers.set(id, w); return JSON.stringify(id);
        }
        case 'removeWatcher': { const w = state.watchers.get(a[0]); if (w) w.close(); state.watchers.delete(a[0]); return 'true'; }
        case 'execCommand': {
          const c = String(a[0]); state.exec.push(c);
          if (/^curl\.exe /.test(c)){ // pobieranie okładek/metadanych przez curl (omija CORS)
            const m = c.match(/-o "([^"]+)" "([^"]+)"$/);
            const body = m && state.curl ? state.curl(new URL(m[2])) : null;
            if (!body) return JSON.stringify({ stdOut: '', stdErr: 'curl: (22) The requested URL returned error: 404', exitCode: 22 });
            fs.writeFileSync(toNative(m[1]), body); return JSON.stringify({ stdOut: '', stdErr: '', exitCode: 0 });
          }
          if (/ --version/.test(c)) return JSON.stringify({ stdOut: state.ytVer + '\n', stdErr: '', exitCode: 0 });
          if (/ -U\b/.test(c)){ const old = state.ytVer; state.ytVer = state.ytLatest; return JSON.stringify({ stdOut: old === state.ytLatest ? 'yt-dlp is up to date (stable@' + old + ')' : 'Updated yt-dlp to stable@' + state.ytLatest, stdErr: '', exitCode: 0 }); }
          return JSON.stringify({ stdOut: '', stdErr: '', exitCode: 0 });
        }
        case 'showFolderDialog': return JSON.stringify(state.folderPick || '');
        case 'showSaveDialog': return JSON.stringify(state.savePick || '');
      }
      return JSON.stringify({ __err: 'unknown op ' + op });
    } catch (e){ return JSON.stringify({ __err: String(e.message || e) }); }
  };
}

async function openApp(browser, opts = {}){
  // osobny kontekst = osobne IndexedDB/localStorage (testy nie widzą swoich bibliotek)
  const ctx = opts.ctx || await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.on('pageerror', e => { console.log('  [pageerror]', e.message); if (!opts.allowErrors) failures++; });
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|net::ERR|chunk-|musicbrainz|coverartarchive|lrclib/i.test(m.text())) console.log('  [console.error]', m.text().slice(0, 200)); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.origin === ORIGIN){
      let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
      if (p === '/neutralino.js') return req.respond({ status: 200, contentType: MIME.js, body: opts.desktop ? STUB : '' });
      const f = path.join(RES, p);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return req.respond({ status: 200, contentType: MIME[p.split('.').pop()] || 'application/octet-stream', body: fs.readFileSync(f) });
      return req.respond({ status: 404, body: 'nf' });
    }
    if (u.hostname === 'api.github.com' && opts.state) return req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ tag_name: opts.state.ytLatest }) });
    if (opts.netMock){ const r = opts.netMock(u, req); if (r) return req.respond(r); }
    return req.respond({ status: 503, body: 'offline in tests' }); // brak sieci: wzbogacanie metadanych itp.
  });
  if (opts.desktop){
    await page.exposeFunction('__nfs', makeNodeFs(opts.state));
    opts.state.emit = (e, d) => page.evaluate((e, d) => window.__nlEmit && window.__nlEmit(e, d), e, d).catch(() => {});
  }
  await page.evaluateOnNewDocument((ls, np, tmp, slow) => {
    if (!sessionStorage.getItem('__lsInit')){ sessionStorage.setItem('__lsInit', '1'); Object.keys(ls).forEach(k => localStorage.setItem(k, ls[k])); }
    window.__NL_PATH = np; window.__NL_TMP = tmp;
    // piaskownica nie ma GPU: animowane tło zjada CPU i spowalnia odtwarzacz mediów — w testach czasu audio ograniczamy rAF
    if (slow) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 250);
  }, Object.assign({ playerLang: 'pl', playerSkipSilence: '0', playerNorm: '0', pulsarYtdlpAuto: '1' }, opts.ls || {}), opts.nlPath || '', path.join(OUT, 'tmp'), !!opts.slowRaf);
  await page.goto(ORIGIN + '/index.html', { waitUntil: 'load' });
  await sleep(600);
  return page;
}
async function loadFiles(page, files){
  await page.$eval('#folderInput', el => el.removeAttribute('webkitdirectory'));
  const inp = await page.$('#folderInput');
  await inp.uploadFile(...files);
  await poll(() => page.evaluate(n => window.__player.state().tracks >= n, files.filter(f => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f)).length));
}
async function idbTracks(page){
  return page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('ambient-player-library', 2);
    r.onsuccess = () => { const q = r.result.transaction('tracks').objectStore('tracks').getAll(); q.onsuccess = () => res(q.result.map(x => ({ id: x.id, name: x.name, title: x.title, artist: x.artist, size: x.blob && x.blob.size, cover: x.coverBlob ? x.coverBlob.size : 0, fav: x.fav, plays: x.plays, srcPath: x.srcPath }))); };
  }));
}
async function idbBlobB64(page, id){
  return page.evaluate(id => new Promise(res => {
    const r = indexedDB.open('ambient-player-library', 2);
    r.onsuccess = () => { const q = r.result.transaction('tracks').objectStore('tracks').get(id); q.onsuccess = async () => { const u = new Uint8Array(await q.result.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); res(btoa(s)); }; };
  }), id);
}
function mutagen(file){
  const py = `
import sys, json
from mutagen import File
f = File(sys.argv[1]); d = {}
if f is None: print('{}'); sys.exit()
t = f.tags
if hasattr(t, 'getall'):
    d['title'] = str(t.get('TIT2')); d['artist'] = str(t.get('TPE1')); d['album'] = str(t.get('TALB')); d['cover'] = len(t.getall('APIC'))
else:
    d['title'] = (t.get('\\xa9nam') or [''])[0]; d['artist'] = (t.get('\\xa9ART') or [''])[0]; d['cover'] = len(t.get('covr') or [])
print(json.dumps(d, ensure_ascii=False))`;
  return JSON.parse(execFileSync('python3', ['-c', py, file]).toString());
}
async function editTags(page, id, fields){
  const ok = await page.evaluate((m) => {
    const li = document.querySelector('.track-list li[data-track-id="' + m + '"]');
    if (!li) return false; li.querySelector('.tag-act').click(); return true;
  }, id);
  if (!ok) return false;
  await poll(() => page.evaluate(() => !document.getElementById('modalDim').hidden && !!document.querySelector('.tag-ed')));
  await page.evaluate(f => {
    const ins = document.querySelectorAll('.tag-ed-input');
    if (f.title !== undefined) ins[0].value = f.title; if (f.artist !== undefined) ins[1].value = f.artist;
  }, fields);
  if (fields.cover){
    const fi = await page.$('.tag-ed-cover input[type=file]');
    await fi.uploadFile(fields.cover);
    await poll(() => page.evaluate(() => /^blob:/.test(document.querySelector('.tag-ed-cover img').src)));
  }
  if (fields.disk === false) await page.evaluate(() => { const c = document.querySelector('.tag-ed-disk input'); if (c) c.checked = false; });
  const info = await page.evaluate(() => ({ note: (document.querySelector('.tag-ed-note') || {}).textContent, disk: !!document.querySelector('.tag-ed-disk input') }));
  await page.$eval('#modalOk', b => b.click());
  await poll(() => page.evaluate(() => document.getElementById('modalDim').hidden));
  return info;
}

/* ---------------- GAPLESS ---------------- */
async function gaplessRun(browser, on, xfade){
  const page = await openApp(browser, { slowRaf: true, ls: { playerGapless: on ? '1' : '0', playerXfade: String(xfade || 0), threeDMode: 'false' } });
  // bez GPU: pełnoekranowe rozmycia tła rasteryzowane na CPU blokują wątek na sekundy — w teście czasu audio je wyłączamy
  await page.addStyleTag({ content: '*,*::before,*::after{filter:none!important;backdrop-filter:none!important;animation:none!important;transition:none!important}' });
  await page.evaluate(() => { window.__hb = []; let last = performance.now(); setInterval(() => { const n = performance.now(); if (n - last > 150) window.__hb.push([Math.round(n), Math.round(n - last)]); last = n; }, 50); });
  const LONG = !!xfade; // crossfade: pliki 10 s (okno wyzwolenia nie nachodzi na start utworu)
  await loadFiles(page, (LONG ? ['lA.wav', 'lB.wav', 'lC.wav'] : ['gA.wav', 'gB.wav', 'gC.wav']).map(f => path.join(MEDIA, f)));
  await page.evaluate(() => window.__player.loadIndex(0));
  await poll(() => page.evaluate(() => !!(window.__pulsarHost.audioTap() && !document.getElementById('audio').paused)), 20000);
  // analiza (pady) — poczekaj aż się policzy dla wszystkich
  await poll(() => page.evaluate(() => [0, 1, 2].every(i => window.__player.__silence && window.__player.__silence.for(i))), 20000);
  await page.evaluate(v => { window.__seekTo = v; }, LONG ? 5.5 : 2.2);
  await page.evaluate(() => {
    const tap = window.__pulsarHost.audioTap(); const ctx = tap.ctx;
    const sp = ctx.createScriptProcessor(512, 2, 2); const g = ctx.createGain(); g.gain.value = 0;
    window.__rec = []; window.__idx = [];
    const A = document.getElementById('audio'), X = document.getElementById('audioXF');
    window.__ev = [];
    const T0 = performance.now();
    const logEv = (el, n) => el.addEventListener(n, () => window.__ev.push([Math.round(performance.now() - T0), (el === A ? 'audio.' : 'xf.') + n, +A.currentTime.toFixed(3), +X.currentTime.toFixed(3), window.__player.state().currentIndex]));
    ['play', 'playing', 'pause', 'ended', 'seeked', 'loadedmetadata', 'waiting'].forEach(n => { logEv(A, n); logEv(X, n); });
    sp.onaudioprocess = e => { const d = e.inputBuffer.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; window.__rec.push([e.playbackTime, Math.sqrt(s / d.length), window.__player.state().currentIndex, +A.currentTime.toFixed(2), A.paused ? 'P' : 'p', +X.currentTime.toFixed(2), X.paused ? 'P' : 'p', performance.now() | 0]); };
    tap.node.connect(sp); sp.connect(g); g.connect(ctx.destination); window.__sp = sp;
    const a = document.getElementById('audio'); a.currentTime = window.__seekTo;
  });
  const done = await poll(() => page.evaluate(() => window.__player.state().currentIndex === 2 && document.getElementById('audio').currentTime > 1.0), 60000);
  await sleep(300);
  const r = await page.evaluate(() => { window.__sp.disconnect(); return window.__rec; });
  const ev = await page.evaluate(() => window.__ev);
  if (process.env.DBG) console.log('  blokady wątku >150 ms:', JSON.stringify(await page.evaluate(() => window.__hb)));
  if (process.env.DBG) ev.forEach(e => console.log('  ev', JSON.stringify(e)));
  await page.close();
  if (process.env.DBG) r.forEach((x, i) => { if (x[1] < 0.3 && i > 50) console.log('  dip', x[0].toFixed(3), x[1].toFixed(3), 'i' + x[2], 'a=' + x[3] + x[4], 'x=' + x[5] + x[6]); });
  if (process.env.DBG){ let last = ''; for (const x of r){ const k = (x[1] > 0.2 ? 'SND' : 'sil') + ' i' + x[2] + ' ' + x[4] + x[6]; if (k !== last){ console.log(x[0].toFixed(3), k, 'a=' + x[3], 'x=' + x[5], 'wall=' + x[7]); last = k; } } }
  // pomiń początek (przewinięcie) i koniec
  const body = r.filter(x => x[0] > r[0][0] + 0.6);
  // sinus 0,5 → RMS ≈ 0,35. Cisza = RMS < 0,03. Częściowy spadek (< 0,2) bywa przy przejęciu audioXF → audio:
  // dwa identyczne sinusy przesunięte o kilkanaście ms częściowo się znoszą — w muzyce to niesłyszalne.
  let minR = 1, dips = 0, worst = 0, run = 0;
  for (const [, v] of body){ if (v < minR) minR = v; if (v < 0.2) dips++; if (v < 0.03){ run++; worst = Math.max(worst, run); } else run = 0; }
  return { reachedThird: !!done, blocks: body.length, minRms: +minR.toFixed(3), partialDips: dips, longestGapMs: Math.round(worst * 512 / 44.1) };
}

async function testGapless(browser){
  if (process.env.ONLYXF){ const x = await gaplessRun(browser, false, 2); check('xf', x.longestGapMs === 0, x); return; }
  const on = await gaplessRun(browser, true);
  check('gapless wł.: przejście przez 3 utwory', on.reachedThird, on);
  check('gapless wł.: zero ciszy między utworami', on.longestGapMs === 0 && on.minRms > 0.03, on);
  const off = await gaplessRun(browser, false);
  check('gapless wył. (kontrola): test wykrywa przerwę', off.longestGapMs > 100, off);
  // crossfade korzysta z tego samego przejęcia audioXF → audio (regresja)
  const xf = await gaplessRun(browser, false, 2);
  check('crossfade 2 s: 3 utwory bez ciszy', xf.reachedThird && xf.longestGapMs === 0, xf);
}

/* ---------------- TAGI (przeglądarka) ---------------- */
async function testTags(browser){
  const page = await openApp(browser, {});
  await loadFiles(page, ['t_v23.mp3', 't.m4a', 'gA.wav'].map(f => path.join(MEDIA, f)));
  await page.evaluate(() => { document.getElementById('libraryPanel') && window.__player && 0; });
  const btns = await page.evaluate(() => document.querySelectorAll('.track-list li .tag-act').length);
  check('ołówek w każdym wierszu', btns === 3, btns);
  const before = await idbTracks(page);
  const mp3 = before.find(x => x.name === 't_v23.mp3'), m4a = before.find(x => x.name === 't.m4a');
  const i1 = await editTags(page, mp3.id, { title: 'Nowy tytuł ąę', artist: 'Wykonawca Ł', cover: path.join(MEDIA, 'cover.jpg') });
  check('edytor: notka MP3', /MP3/.test(i1.note || ''), i1);
  await sleep(500);
  let after = await idbTracks(page);
  let r = after.find(x => x.id === mp3.id);
  check('biblioteka: tytuł/wykonawca/okładka MP3', r.title === 'Nowy tytuł ąę' && r.artist === 'Wykonawca Ł' && r.cover > 1000, r);
  fs.writeFileSync(path.join(OUT, 'edited.mp3'), Buffer.from(await idbBlobB64(page, mp3.id), 'base64'));
  const m1 = mutagen(path.join(OUT, 'edited.mp3'));
  check('plik MP3: tagi ID3 zapisane (album zachowany)', m1.title === 'Nowy tytuł ąę' && m1.artist === 'Wykonawca Ł' && m1.cover === 1 && m1.album === 'Album X', m1);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.track-list li')).some(li => li.textContent.indexOf('Nowy tytuł ąę') > -1));
  check('lista odświeżona', shown);

  const i2 = await editTags(page, m4a.id, { title: 'M4A tytuł', artist: 'M4A art', cover: path.join(MEDIA, 'cover.jpg') });
  await sleep(500);
  fs.writeFileSync(path.join(OUT, 'edited.m4a'), Buffer.from(await idbBlobB64(page, m4a.id), 'base64'));
  const m2 = mutagen(path.join(OUT, 'edited.m4a'));
  check('edytor M4A znalazł wiersz', !!i2, i2);
  check('plik M4A: tagi zapisane', m2.title === 'M4A tytuł' && m2.artist === 'M4A art' && m2.cover === 1, m2);
  // odtwarzalność po edycji
  const ff = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
  for (const f of ['edited.mp3', 'edited.m4a']){
    let ok = true; try { execFileSync(ff, ['-v', 'error', '-i', path.join(OUT, f), '-f', 'null', '-'], { stdio: 'pipe' }); } catch (e){ ok = false; }
    check('dekodowanie ' + f, ok);
  }
  const wav = before.find(x => x.name === 'gA.wav');
  const i3 = await editTags(page, wav.id, { title: 'Tylko w bibliotece', artist: 'X' });
  check('WAV: notka o zapisie tylko w bibliotece', /FLAC\/OGG\/WAV/.test(i3.note || ''), i3.note);
  await sleep(400);
  after = await idbTracks(page);
  r = after.find(x => x.id === wav.id);
  check('WAV: tytuł w bibliotece, plik bez zmian', r.title === 'Tylko w bibliotece' && r.size === wav.size, r);
  // usunięcie okładki
  await page.evaluate(() => { const li = Array.from(document.querySelectorAll('.track-list li')).find(li => li.textContent.indexOf('Nowy tytuł ąę') > -1); li.querySelector('.tag-act').click(); });
  await poll(() => page.evaluate(() => !!document.querySelector('.tag-ed')));
  await page.screenshot({ path: path.join(OUT, 'tag-editor.png') });
  await page.evaluate(() => { document.querySelectorAll('.tag-ed-btn')[1].click(); document.getElementById('modalOk').click(); });
  await sleep(800);
  fs.writeFileSync(path.join(OUT, 'edited2.mp3'), Buffer.from(await idbBlobB64(page, mp3.id), 'base64'));
  const m3 = mutagen(path.join(OUT, 'edited2.mp3'));
  check('usunięcie okładki z pliku', m3.cover === 0 && m3.title === 'Nowy tytuł ąę', m3);
  await page.close();
}

/* ---------------- KOPIA ZAPASOWA (przeglądarka) ---------------- */
async function testBackup(browser){
  const dl = path.join(OUT, 'dl'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
  let page = await openApp(browser, { ls: { playerVolume: '0.42' } });
  await loadFiles(page, ['t_v23.mp3', 't.m4a', 'gA.wav', 'cover.jpg'].map(f => path.join(MEDIA, f)));
  const tr = await idbTracks(page);
  // ulubione + album bezpośrednio w bazie, potem przeładowanie (restoreLibrary)
  await page.evaluate(ids => new Promise(res => {
    const r = indexedDB.open('ambient-player-library', 2);
    r.onsuccess = () => {
      const tx = r.result.transaction(['tracks', 'playlists'], 'readwrite');
      const st = tx.objectStore('tracks');
      const g = st.get(ids[0]); g.onsuccess = () => { const v = g.result; v.fav = true; v.plays = 7; st.put(v); };
      tx.objectStore('playlists').put({ id: 'alb-test', name: 'Mój album', trackIds: [ids[0], ids[1]], createdAt: 1, customCover: true, coverBlob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' }) });
      tx.oncomplete = res;
    };
  }), tr.map(x => x.id));
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, browserContextId: page.__ctx.id });
  await page.reload({ waitUntil: 'load' }); await sleep(800);
  await page.evaluate(() => document.getElementById('smBackupBtn').click());
  const file = await poll(() => { const f = fs.readdirSync(dl).find(n => /\.pulsarlib$/.test(n)); return f ? path.join(dl, f) : null; }, 15000);
  check('eksport: plik .pulsarlib pobrany', !!file, file);
  if (!file){ await page.close(); return; }
  await sleep(500);
  const buf = fs.readFileSync(file);
  const magic = buf.slice(0, 9).toString(), len = buf.readUInt32LE(10), man = JSON.parse(buf.slice(14, 14 + len).toString());
  const dataSize = buf.length - 14 - len;
  check('format: nagłówek + manifest', magic === 'PULSARLIB' && buf[9] === 1 && man.tracks.length === 3 && man.albums.length === 1, { magic, tracks: man.tracks.length, albums: man.albums.length });
  check('format: rozmiar danych = suma blobów', dataSize === man.dataSize, { dataSize, declared: man.dataSize });
  check('format: ustawienia (player*) w kopii, bez pulsarWatch*', man.settings.playerVolume === '0.42' && !Object.keys(man.settings).some(k => /^pulsarWatch/.test(k)), Object.keys(man.settings).length);
  // czysta baza → przywrócenie
  await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('ambient-player-library'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.close();
  page = await openApp(browser, {});
  await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('ambient-player-library'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.reload({ waitUntil: 'load' }); await sleep(600);
  check('czysta biblioteka przed przywróceniem', (await page.evaluate(() => window.__player.state().tracks)) === 0);
  const fi = await page.$('#backupFileInput');
  await fi.uploadFile(file);
  await poll(() => page.evaluate(() => !document.getElementById('modalDim').hidden && !!document.querySelector('.backup-sum')));
  await page.screenshot({ path: path.join(OUT, 'restore-dialog.png') });
  await page.evaluate(() => { document.querySelector('.backup-sum input[type=checkbox]').checked = true; document.getElementById('modalOk').click(); });
  await poll(() => page.evaluate(() => window.__player.state().tracks === 3), 15000);
  await sleep(800);
  const st = await page.evaluate(() => window.__player.state());
  check('przywrócono utwory i album', st.tracks === 3 && st.albums.length === 1 && st.albums[0].tracks === 2, { tracks: st.tracks, albums: st.albums });
  const t2 = await idbTracks(page);
  const fav = t2.find(x => x.id === tr[0].id);
  check('zachowane id, ulubione, licznik, rozmiary plików', fav && fav.fav === true && fav.plays === 7 && t2.every(x => tr.find(y => y.id === x.id && y.size === x.size)), fav);
  check('ustawienia przywrócone (po zaznaczeniu)', (await page.evaluate(() => localStorage.getItem('playerVolume'))) === '0.42');
  const alb = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('ambient-player-library', 2); r.onsuccess = () => { const q = r.result.transaction('playlists').objectStore('playlists').get('alb-test'); q.onsuccess = () => res({ name: q.result.name, cover: q.result.coverBlob instanceof Blob ? q.result.coverBlob.size : -1 }); }; }));
  check('album z okładką-Blobem w bazie', alb.name === 'Mój album' && alb.cover === 5, alb);
  // ponowne przywrócenie — bez duplikatów
  await fi.uploadFile(file);
  await poll(() => page.evaluate(() => !!document.querySelector('.backup-sum')));
  await page.evaluate(() => document.getElementById('modalOk').click());
  await sleep(1500);
  const st2 = await page.evaluate(() => window.__player.state());
  check('drugie przywrócenie nie dubluje', st2.tracks === 3 && st2.albums.length === 1, { tracks: st2.tracks, albums: st2.albums.length });
  // odtwarzanie przywróconego pliku
  await page.evaluate(() => window.__player.loadIndex(0));
  const playing = await poll(() => page.evaluate(() => document.getElementById('audio').currentTime > 0.3), 15000);
  check('przywrócony utwór gra', !!playing);
  // zły plik
  const bad = path.join(OUT, 'bad.pulsarlib'); fs.writeFileSync(bad, 'hello world, not a backup');
  await fi.uploadFile(bad); await sleep(600);
  const toast = await page.evaluate(() => (document.getElementById('styleToast') || {}).textContent || '');
  check('zły plik → komunikat', /kopii/i.test(toast), toast);
  await page.close();
}

/* ---------------- DESKTOP (stub): yt-dlp, obserwowany folder, tagi na dysku, kopia na dysk ---------------- */
async function testDesktop(browser){
  const base = path.join(OUT, 'desk'); fs.rmSync(base, { recursive: true, force: true });
  const watch = path.join(base, 'Muzyka Test'); fs.mkdirSync(path.join(watch, 'sub'), { recursive: true });
  fs.copyFileSync(path.join(MEDIA, 't_v23.mp3'), path.join(watch, 'Artysta - Piosenka.mp3'));
  fs.copyFileSync(path.join(MEDIA, 'cover.jpg'), path.join(watch, 'Artysta - Piosenka.jpg'));
  fs.copyFileSync(path.join(MEDIA, 'gA.wav'), path.join(watch, 'sub', 'ton.wav'));
  fs.writeFileSync(path.join(watch, 'notatki.txt'), 'x');
  const old = Date.now() / 1000 - 60; for (const f of ['Artysta - Piosenka.mp3', 'Artysta - Piosenka.jpg', 'sub/ton.wav']) fs.utimesSync(path.join(watch, f), old, old);
  const state = { writes: [], exec: [], watchers: new Map(), watchSeq: 0, ytVer: '2025.01.15', ytLatest: '2026.09.20', folderPick: watch.replace(/\//g, '\\'), savePick: path.join(base, 'kopia') };
  const page = await openApp(browser, { desktop: true, state, nlPath: path.join(base, 'app') });
  await poll(() => page.evaluate(() => document.documentElement.classList.contains('nl-desktop')));
  check('tryb desktop aktywny', await page.evaluate(() => document.documentElement.classList.contains('nl-desktop') && !!window.__pulsarFs));

  // yt-dlp: automatyczna aktualizacja po starcie (nowsze wydanie na GitHubie)
  const upd = await poll(() => state.exec.some(c => / -U\b/.test(c)), 15000);
  check('yt-dlp: auto-aktualizacja uruchomiona', !!upd, state.exec.filter(c => /yt-dlp/.test(c)));
  const btnTxt = await poll(() => page.evaluate(() => { const b = document.getElementById('smYtdlpBtn'); return b && /2026\.09\.20/.test(b.textContent) ? b.textContent : null; }), 8000);
  check('yt-dlp: przycisk pokazuje nową wersję', !!btnTxt, btnTxt);
  const nU = state.exec.filter(c => / -U\b/.test(c)).length;
  await page.evaluate(() => document.getElementById('smYtdlpBtn').click());
  await poll(() => state.exec.filter(c => / -U\b/.test(c)).length > nU, 5000);
  const t1 = await poll(() => page.evaluate(() => { const t = document.getElementById('styleToast'); return t && /aktualny/.test(t.textContent) ? t.textContent : null; }), 5000);
  check('yt-dlp: ręcznie → „jest aktualny”', !!t1, t1);
  check('yt-dlp: 24 h pamięci sprawdzenia', !!(await page.evaluate(() => localStorage.getItem('pulsarYtdlpCheck'))));

  // obserwowany folder: wybór → skan
  await page.evaluate(() => document.getElementById('smWatchBtn').click());
  await poll(() => page.evaluate(() => window.__player.state().tracks === 2), 15000);
  let tr = await idbTracks(page);
  check('folder: 2 utwory audio (txt pominięty)', tr.length === 2, tr.map(x => x.name));
  const song = tr.find(x => x.name === 'Artysta - Piosenka.mp3');
  check('folder: srcPath zapisany', !!(song && /Muzyka Test\/Artysta - Piosenka\.mp3$/.test(song.srcPath)), song && song.srcPath);
  check('folder: okładka (osadzona w MP3 lub .jpg obok)', song && song.cover > 500, song && song.cover);
  const lab = await page.evaluate(() => document.getElementById('smWatchPath').textContent);
  check('folder: ścieżka w ustawieniach', /Muzyka Test/.test(lab), lab);
  const folderName = await page.evaluate(() => Array.from(document.querySelectorAll('.track-list li')).map(li => li.textContent).join('|'));
  // nowy plik → watcher
  fs.copyFileSync(path.join(MEDIA, 't.m4a'), path.join(watch, 'sub', 'nowy.m4a'));
  const got3 = await poll(() => page.evaluate(() => window.__player.state().tracks === 3), 20000);
  check('folder: nowy plik dodany automatycznie (watcher)', !!got3);
  // edycja tagów z zapisem na dysk — bez ponownego importu
  const info = await editTags(page, song.id, { title: 'Dysk tytuł', artist: 'Dysk artysta' });
  check('edytor: opcja zapisu na dysk widoczna', info && info.disk, info);
  await sleep(1200);
  const md = mutagen(path.join(watch, 'Artysta - Piosenka.mp3'));
  check('plik na dysku zaktualizowany', md.title === 'Dysk tytuł' && md.artist === 'Dysk artysta' && md.album === 'Album X', md);
  await sleep(6500); // watcher zobaczy modyfikację
  check('zmodyfikowany plik nie zaimportowany ponownie', (await page.evaluate(() => window.__player.state().tracks)) === 3);
  // usunięty z biblioteki nie wraca
  await page.evaluate(() => { const li = Array.from(document.querySelectorAll('.track-list li')).find(li => /ton/.test(li.textContent)); li.querySelector('.mini-act.danger').click(); });
  await sleep(300);
  await page.evaluate(() => { const ok = document.getElementById('modalOk'); if (!document.getElementById('modalDim').hidden) ok.click(); });
  await sleep(300);
  const nAfterDel = await page.evaluate(() => window.__player.state().tracks);
  await page.evaluate(() => window.__desktopBridge.watch.scan());
  await sleep(1500);
  check('usunięty utwór nie wraca przy skanie', (await page.evaluate(() => window.__player.state().tracks)) === nAfterDel, nAfterDel);

  // kopia na dysk (writeBinaryFile + appendBinaryFile)
  await page.evaluate(() => document.getElementById('smBackupBtn').click());
  const kp = state.savePick + '.pulsarlib';
  const ok = await poll(() => { try { const b = fs.readFileSync(kp); const len = b.readUInt32LE(10); const m = JSON.parse(b.slice(14, 14 + len)); return b.length - 14 - len === m.dataSize ? m : null; } catch (e){ return null; } }, 15000);
  check('kopia na dysk: kompletna', !!ok, ok && { tracks: ok.tracks.length, size: fs.statSync(kp).size });
  check('kopia: srcPath w manifeście', !!(ok && ok.tracks.some(t => t.srcPath)), '');

  // OBS: okno z wyglądem overlayu
  await page.evaluate(() => window.__pulsarDesktop.obs.help());
  await poll(() => page.evaluate(() => !!document.querySelector('.obs-theme select')));
  await sleep(800);
  await page.evaluate(() => { const s = document.querySelectorAll('.obs-theme select'); s[0].value = 'bar'; s[0].dispatchEvent(new Event('change')); s[1].value = 'tr'; s[1].dispatchEvent(new Event('change')); s[2].value = 'custom'; s[2].dispatchEvent(new Event('change')); const c = document.querySelector('.obs-theme input[type=color]'); c.value = '#22cc88'; c.dispatchEvent(new Event('input')); });
  await sleep(900);
  const th = await page.evaluate(() => JSON.parse(localStorage.getItem('pulsarObsTheme')));
  check('OBS: motyw zapisany', th.style === 'bar' && th.pos === 'tr' && th.accent === '#22cc88', th);
  const fr = page.frames().find(f => /overlay\.html\?preview/.test(f.url()));
  const fa = fr && await fr.evaluate(() => ({ style: document.documentElement.getAttribute('data-style'), pos: document.documentElement.getAttribute('data-pos'), acc: document.body.style.getPropertyValue('--acc'), title: document.getElementById('title').textContent }));
  check('OBS: podgląd na żywo (styl, pozycja, kolor)', !!fa && fa.style === 'bar' && fa.pos === 'tr' && /34, ?204, ?136/.test(fa.acc), fa);
  await page.evaluate(() => { const b = document.querySelector('.obs-theme'); if (b) b.scrollIntoView({ block: 'start' }); });
  await sleep(300);
  // headless (renderowanie programowe) źle składa backdrop-filter nad ramką — tylko na potrzeby zrzutu
  await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' });
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'obs-theme-modal.png') });
  // wygenerowany plik dla OBS ma zapieczony motyw
  const gen = path.join(base, 'app', 'obs', 'pulsar-obs.html');
  await page.evaluate(() => window.__pulsarDesktop.obs.set(true, true)).catch(() => {});
  await sleep(1500);
  const html = fs.existsSync(gen) ? fs.readFileSync(gen, 'utf8') : '';
  check('OBS: pulsar-obs.html z motywem', /data-style="bar" data-pos="tr" data-viz="1"/.test(html), html.slice(0, 120));
  // ustawienia — zrzut menu
  await page.evaluate(() => { const m = document.getElementById('settingsMenu'); window.__player && 0; if (document.getElementById('modalDim')) document.getElementById('modalCancel').click(); });
  await sleep(300);
  await page.evaluate(() => { const b = document.getElementById('settingsBtn') || document.querySelector('[aria-label*="Ustawienia"]'); if (b) b.click(); });
  await sleep(500);
  await page.evaluate(() => { const m = document.getElementById('settingsMenu'); if (m) m.scrollTop = m.scrollHeight; });
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, 'settings-desktop.png') });
  for (const w of state.watchers.values()) w.close();
  await page.close();
}

/* ---------------- OBS overlay: zrzuty motywów ---------------- */
async function testObs(browser){
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 360 });
  await page.setRequestInterception(true);
  page.on('pageerror', e => { console.log('  [pageerror]', e.message); failures++; });
  page.on('request', req => { const u = new URL(req.url()); const f = path.join(RES, u.pathname); if (u.origin === ORIGIN && fs.existsSync(f)) return req.respond({ status: 200, contentType: MIME.html, body: fs.readFileSync(f) }); req.respond({ status: 404, body: '' }); });
  await page.goto(ORIGIN + '/obs/overlay.html?preview=1');
  await page.evaluate(() => document.body.style.background = '#3a4a5a');
  const cover = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(MEDIA, 'cover.jpg')).toString('base64');
  const shots = [];
  for (const [style, pos, accent] of [['card', 'bl', ''], ['bar', 'bl', '255, 90, 60'], ['cover', 'br', ''], ['minimal', 'tl', '80, 200, 255'], ['card', 'bc', '255, 200, 0'], ['bar', 'tr', '']]){
    await page.evaluate((style, pos, accent, cover) => window.postMessage({ pulsarObsPreview: { title: 'Bardzo długi tytuł utworu, który się nie zmieści', artist: 'Wykonawca Testowy', playing: true, hasTrack: true, pos: 83, dur: 215, accent: '160, 107, 255', lang: 'pl', coverId: 'x', theme: { style, pos, viz: true, accent } }, cover }, '*'), style, pos, accent, cover);
    await sleep(900);
    const f = path.join(OUT, 'obs-' + style + '-' + pos + '.png'); await page.screenshot({ path: f }); shots.push(f);
    const attrs = await page.evaluate(() => [document.documentElement.getAttribute('data-style'), document.documentElement.getAttribute('data-pos')]);
    check('overlay ' + style + '/' + pos, attrs[0] === style && attrs[1] === pos);
  }
  await page.close();
}

/* ---------------- okno ustawień + zapamiętanie albumu ---------------- */
async function testSettings(browser){
  let page = await openApp(browser, {});
  await loadFiles(page, ['gA.wav', 'gB.wav', 'gC.wav'].map(f => path.join(MEDIA, f)));
  await sleep(800);
  const tr = await idbTracks(page);
  const idOf = n => (tr.find(x => x.name === n) || {}).id;
  // album z dwóch utworów (B, C) prosto w IndexedDB, potem przeładowanie
  await page.evaluate((b, c) => new Promise(res => {
    const r = indexedDB.open('ambient-player-library', 2);
    r.onsuccess = () => { const tx = r.result.transaction('playlists', 'readwrite'); tx.objectStore('playlists').put({ id: 'alb1', name: 'Test album', trackIds: [b, c], createdAt: 1, customCover: false }); tx.oncomplete = res; };
  }), idOf('gB.wav'), idOf('gC.wav'));
  await page.reload({ waitUntil: 'load' }); await sleep(1200);
  const idx = await page.evaluate(ids => ids.map(id => window.__pulsarTest.indexOf(id)), [idOf('gA.wav'), idOf('gB.wav'), idOf('gC.wav')]).catch(() => null);
  // odtwórz utwór B z widoku albumu (tak jak użytkownik)
  await page.evaluate(() => window.__pulsarTest.openAlbum('alb1'));
  await sleep(400);
  const clicked = await page.evaluate(() => { const li = document.querySelectorAll('#albumTrackList li')[0]; if (!li) return false; li.click(); return true; });
  await sleep(1200);
  const s1 = await page.evaluate(() => ({ st: window.__player.state(), ls: localStorage.getItem('playerActiveAlbum') }));
  check('album: kliknięcie utworu w albumie → kolejka z albumu', clicked && s1.ls === 'alb1' && s1.st.queue.length === 2 && idx && s1.st.currentIndex === idx[1], { clicked, ls: s1.ls, queue: s1.st.queue, cur: s1.st.currentIndex, idx });
  await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 1.5; a.pause(); });
  await sleep(500);
  await page.reload({ waitUntil: 'load' }); await sleep(1500);
  const s2 = await page.evaluate(() => ({ st: window.__player.state(), card: !!document.querySelector('.album-card.active-album') }));
  check('album: po restarcie kolejka nadal z albumu', s2.st.queue.length === 2 && s2.st.currentIndex === idx[1] && s2.st.queue.indexOf(idx[0]) === -1, { queue: s2.st.queue, cur: s2.st.currentIndex });
  await page.evaluate(() => window.__player.nextTrack()); await sleep(800);
  const s3 = await page.evaluate(() => window.__player.state());
  check('album: następny utwór = następny z albumu', s3.currentIndex === idx[2], { cur: s3.currentIndex });
  // odtworzenie z całej biblioteki → album zapomniany
  await page.evaluate(() => { document.getElementById('audio').pause(); });
  await page.evaluate(() => window.__pulsarTest.playFromLibrary(0)); await sleep(800);
  const lsOff = await page.evaluate(() => localStorage.getItem('playerActiveAlbum'));
  await page.evaluate(() => document.getElementById('audio').pause());
  await page.reload({ waitUntil: 'load' }); await sleep(1500);
  const s4 = await page.evaluate(() => window.__player.state());
  check('biblioteka: po graniu z całej listy restart nie wraca do albumu', lsOff === null && s4.queue.length === 3, { lsOff, queue: s4.queue });

  // --- okno ustawień ---
  const shot = async n => { const f = path.join(OUT, n); await page.screenshot({ path: f }); return f; };
  await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' }); // piaskownica bez GPU
  await page.$eval('#settingsBtn', b => b.click()); await sleep(500);
  const open = await page.evaluate(() => { const m = document.getElementById('settingsMenu'); const d = m.querySelector('.sm-dialog').getBoundingClientRect(); return { hidden: m.hidden, w: Math.round(d.width), h: Math.round(d.height), tabs: [...m.querySelectorAll('.sm-tab')].filter(b => b.getClientRects().length).map(b => b.dataset.pane), active: (m.querySelector('.sm-pane.active') || {}).dataset?.pane }; });
  check('ustawienia: okno otwarte, zakładki (bez Windows/OBS w przeglądarce)', !open.hidden && open.w > 700 && open.tabs.join() === 'play,look,lib,net' && open.active === 'play', open);
  await shot('settings-play.png');
  for (const pane of ['look', 'lib', 'net']){
    await page.$eval('.sm-tab[data-pane="' + pane + '"]', b => b.click()); await sleep(250);
    await shot('settings-' + pane + '.png');
  }
  const act = await page.evaluate(() => document.querySelector('.sm-pane.active').dataset.pane);
  check('ustawienia: przełączanie zakładek', act === 'net');
  // kontrolki nadal działają (np. przełącznik gapless)
  await page.$eval('.sm-tab[data-pane="play"]', b => b.click());
  await page.$eval('#smGapless', el => el.click()); await sleep(200);
  const gl = await page.evaluate(() => localStorage.getItem('playerGapless'));
  await page.$eval('#smGapless', el => el.click());
  check('ustawienia: przełącznik gapless zapisuje się', gl === '0', gl);
  await page.$eval('#smSkipSilence', el => el.click()); await sleep(200);
  const ss = await page.evaluate(() => [localStorage.getItem('playerSkipSilence'), document.getElementById('skipSilenceBtn').classList.contains('active')]);
  await page.$eval('#smSkipSilence', el => el.click()); await sleep(200);
  const ss2 = await page.evaluate(() => [localStorage.getItem('playerSkipSilence'), document.getElementById('smSkipSilence').checked]);
  check('ustawienia: przełącznik „Pomijaj ciszę” steruje funkcją', ss[0] === '1' && ss[1] && ss2[0] === '0' && !ss2[1], { ss, ss2 });
  await page.$eval('#smAutoDj', el => el.click()); await sleep(200);
  const dj = await page.evaluate(() => [document.getElementById('autoDjBtn').classList.contains('active'), document.getElementById('smAutoDj').checked]);
  await page.$eval('#smAutoDj', el => el.click()); await sleep(200);
  check('ustawienia: przełącznik Auto-DJ steruje funkcją', dj[0] && dj[1], dj);
  await shot('settings-play2.png');
  // wyszukiwarka
  await page.type('#smSearch', 'gapless'); await sleep(200);
  const f1 = await page.evaluate(() => [...document.querySelectorAll('#smBody .sm-row, #smBody .sm-btn')].filter(e => e.getClientRects().length).map(e => e.textContent.trim().slice(0, 40)));
  await shot('settings-search.png');
  check('ustawienia: szukaj „gapless” → 1 wynik', f1.length === 1 && /Gapless/.test(f1[0]), f1);
  await page.$eval('#smSearch', el => { el.value = ''; }); await page.type('#smSearch', 'folder'); await sleep(200);
  const f2 = await page.evaluate(() => [...document.querySelectorAll('#smBody .sm-row, #smBody .sm-btn')].filter(e => e.getClientRects().length).length);
  check('ustawienia: szukaj „folder” → wyniki z innych zakładek', f2 >= 2, f2);
  await page.$eval('#smSearch', el => { el.value = ''; }); await page.type('#smSearch', 'zzzqqq'); await sleep(200);
  const empty = await page.evaluate(() => !document.getElementById('smEmpty').hidden);
  check('ustawienia: brak wyników → komunikat', empty);
  await page.keyboard.press('Escape'); await sleep(150);
  const afterEsc1 = await page.evaluate(() => ({ q: document.getElementById('smSearch').value, hidden: document.getElementById('settingsMenu').hidden }));
  await page.keyboard.press('Escape'); await sleep(150);
  const afterEsc2 = await page.evaluate(() => document.getElementById('settingsMenu').hidden);
  check('ustawienia: Esc czyści wyszukiwanie, drugi Esc zamyka', afterEsc1.q === '' && !afterEsc1.hidden && afterEsc2, { afterEsc1, afterEsc2 });
  // ostatnia zakładka zapamiętana, klik w tło zamyka
  await page.$eval('#settingsBtn', b => b.click()); await sleep(300);
  await page.$eval('.sm-tab[data-pane="look"]', b => b.click());
  await page.mouse.click(20, 420); await sleep(200);
  const bg = await page.evaluate(() => document.getElementById('settingsMenu').hidden);
  await page.$eval('#settingsBtn', b => b.click()); await sleep(300);
  const rem = await page.evaluate(() => document.querySelector('.sm-pane.active').dataset.pane);
  check('ustawienia: klik w tło zamyka, ostatnia zakładka zapamiętana', bg && rem === 'look', { bg, rem });
  // wersja desktopowa (Windows/OBS) + angielski — tylko wygląd
  await page.evaluate(() => { document.documentElement.classList.add('nl-desktop'); window.__player.__i18n.set('en'); });
  await page.$eval('.sm-tab[data-pane="win"]', b => b.click()); await sleep(300);
  await shot('settings-win-en.png');
  const en = await page.evaluate(() => document.querySelector('.sm-pane.active .sm-pane-title').textContent + ' | ' + document.getElementById('smSearch').placeholder);
  check('ustawienia: tłumaczenie EN', /Windows/.test(en) && /Search settings/.test(en), en);
  await page.setViewport({ width: 520, height: 800 }); await sleep(300);
  await shot('settings-narrow.png');
  await page.close();
}

/* ---------------- dodawanie folderu nie kasuje biblioteki ---------------- */
async function testLibraryAdd(browser){
  const page = await openApp(browser, {});
  const first = ['gA.wav', 'gB.wav', 't_v23.mp3'].map(f => path.join(MEDIA, f));
  await loadFiles(page, first);
  await sleep(1000);
  const before = await idbTracks(page);
  const idB = before.find(x => x.name === 'gB.wav').id, idV = before.find(x => x.name === 't_v23.mp3').id;
  // ulubiony + album + licznik odtworzeń + własny tytuł
  await page.evaluate((idB, idV) => new Promise(res => {
    const r = indexedDB.open('ambient-player-library', 2);
    r.onsuccess = () => { const tx = r.result.transaction('playlists', 'readwrite'); tx.objectStore('playlists').put({ id: 'albX', name: 'Mój album', trackIds: [idB, idV], createdAt: 1, customCover: false }); tx.oncomplete = res; };
  }), idB, idV);
  await page.reload({ waitUntil: 'load' }); await sleep(1200);
  const iV = await page.evaluate(id => window.__pulsarTest.indexOf(id), idV);
  await page.evaluate(i => window.__player.__stats.setFav(i, true), iV);
  await editTags(page, idB, { title: 'Mój tytuł B' });
  await page.evaluate(() => window.__pulsarTest.openAlbum('albX')); await sleep(300);
  await page.evaluate(() => document.querySelectorAll('#albumTrackList li')[0].click()); await sleep(1500);
  await page.evaluate(() => document.getElementById('audio').pause());
  const playing = await page.evaluate(() => window.__player.state().currentIndex);
  const snap = await idbTracks(page);
  // „Dodaj muzykę” z TYM SAMYM folderem + jeden nowy plik
  await loadFiles(page, first.concat([path.join(MEDIA, 'gC.wav')]));
  await sleep(1500);
  const toast = await page.evaluate(() => document.getElementById('styleToast').textContent);
  const after = await idbTracks(page);
  const st = await page.evaluate(() => ({ st: window.__player.state(), active: localStorage.getItem('playerActiveAlbum') }));
  check('dodanie tego samego folderu: nic nie znika, dochodzi tylko nowy plik', after.length === 4 && snap.every(o => after.some(n => n.id === o.id)), { before: snap.length, after: after.map(x => x.name) });
  const nb = after.find(x => x.id === idB), nv = after.find(x => x.id === idV);
  const same = snap.every(o => { const n = after.find(x => x.id === o.id); return n && ['title', 'artist', 'fav', 'plays', 'cover', 'size'].every(k => n[k] === o[k]); });
  check('istniejące utwory nietknięte (tytuł, ulubione, okładka, licznik)', same && nb.title === 'Mój tytuł B' && nv.fav === true && nb.plays >= 1, { nb, nv });
  check('album zachowany', st.st.albums.length === 1 && st.st.albums[0].tracks === 2, st.st.albums);
  check('odtwarzany utwór i kolejka z albumu bez zmian', st.st.currentIndex === playing && st.active === 'albX' && st.st.queue.length === 2, { cur: st.st.currentIndex, playing, active: st.active, queue: st.st.queue });
  check('komunikat: dodano 1, pominięto 3', /1/.test(toast) && /3/.test(toast), toast);
  // drugi raz — nic nowego
  await loadFiles(page, first); await sleep(800);
  const toast2 = await page.evaluate(() => document.getElementById('styleToast').textContent);
  const after2 = await idbTracks(page);
  check('ponowne dodanie: bez duplikatów, komunikat „już są”', after2.length === 4 && /już/.test(toast2), { n: after2.length, toast2 });
  // po restarcie wszystko nadal jest
  await page.reload({ waitUntil: 'load' }); await sleep(1200);
  const st3 = await page.evaluate(() => window.__player.state());
  check('po restarcie: 4 utwory, album z 2 utworami', st3.tracks === 4 && st3.albums[0].tracks === 2, { tracks: st3.tracks, albums: st3.albums });
  await page.close();
}

/* ---------------- okładki z sieci (symulowane Deezer / iTunes / MusicBrainz) ---------------- */
async function testCovers(browser){
  const jpg = fs.readFileSync(path.join(MEDIA, 'cover.jpg'));
  const wrong = Buffer.concat([jpg, Buffer.alloc(777)]); // inna okładka (inny rozmiar) — nie może trafić do Bones
  const log = { deezer: [], itunes: [], mb: [], img: [] };
  const CORS = { 'Access-Control-Allow-Origin': '*' };
  const json = (o, cors) => ({ status: 200, contentType: 'application/json', headers: cors ? CORS : {}, body: JSON.stringify(o) });
  const netMock = (u) => {
    const q = (u.searchParams.get('q') || u.searchParams.get('term') || u.searchParams.get('query') || '').toLowerCase();
    if (u.hostname === 'api.deezer.com'){
      const cb = u.searchParams.get('callback');
      log.deezer.push({ q, jsonp: !!cb });
      let data = [];
      if (q.includes('bones')) data = [
        { title: 'Bones', title_short: 'Bones', artist: { name: 'Equinox' }, album: { title: 'Bones', cover_xl: 'https://cdn.test/wrong.jpg' } },
        { title: 'Bones', title_short: 'Bones', artist: { name: 'Imagine Dragons' }, album: { title: 'Mercury - Act 2', cover_xl: 'https://cdn.test/bones.jpg' } }];
      const body = JSON.stringify({ data });
      // prawdziwy Deezer nie wysyła nagłówków CORS → fetch z aplikacji się nie uda, działa JSONP
      // (przechwytywanie w puppeteerze omija CORS, więc blokadę symulujemy błędem)
      return cb ? { status: 200, contentType: 'text/javascript', body: cb + '(' + body + ')' } : { status: 403, contentType: 'text/plain', body: 'CORS' };
    }
    if (u.hostname === 'itunes.apple.com'){
      log.itunes.push({ q, t: Date.now() });
      let results = [];
      if (q.includes('believer')) results = [{ trackId: 1, trackName: 'Believer', artistName: 'Imagine Dragons', collectionName: 'Evolve', artworkUrl100: 'https://cdn.test/believer/100x100bb.jpg' }];
      if (q.includes('nieznany')) results = [{ trackId: 2, trackName: 'Całkiem Inny Utwór', artistName: 'Ktoś Inny', artworkUrl100: 'https://cdn.test/wrong/100x100bb.jpg' }];
      return json({ resultCount: results.length, results }, true);
    }
    if (u.hostname === 'musicbrainz.org'){
      log.mb.push(q);
      const recordings = q.includes('bohemian') ? [{ title: 'Bohemian Rhapsody', 'artist-credit': [{ name: 'Queen' }], releases: [{ id: 'rel-b', title: 'Bootleg', status: 'Bootleg' }, { id: 'rel-q', title: 'A Night at the Opera', status: 'Official' }] }] : [];
      return json({ recordings }, true);
    }
    if (u.hostname === 'coverartarchive.org'){ log.img.push(u.pathname); return u.pathname.includes('rel-q') ? { status: 200, contentType: 'image/jpeg', headers: CORS, body: jpg } : { status: 404, headers: CORS, body: '' }; }
    if (u.hostname === 'cdn.test'){ log.img.push(u.pathname); return { status: 200, contentType: 'image/jpeg', headers: CORS, body: u.pathname.includes('wrong') ? wrong : jpg }; }
    return null;
  };
  const page = await openApp(browser, { netMock, ls: { playerNetEnrich: '1' } });
  const dir = path.join(MEDIA, 'cov');
  await loadFiles(page, fs.readdirSync(dir).map(f => path.join(dir, f)));
  // auto-uzupełnianie startuje ~3,5 s po dodaniu; iTunes jest ograniczany do 1 zapytania / 3,2 s
  const t0 = Date.now();
  await poll(() => page.evaluate(() => !!document.getElementById('styleToast') && /Uzupełniono/.test(document.getElementById('styleToast').textContent)), 90000, 300);
  await sleep(500);
  const tr = await idbTracks(page);
  const by = n => tr.find(x => x.name === n) || {};
  const bones = by('Imagine Dragons - Bones (Official Audio).mp3'), bel = by('Believer.mp3'), unk = by('Nieznany.mp3'), q = by('Queen.mp3');
  check('okładki: Bones (tytuł z YouTube + kanał „ImagineDragons”) → Deezer, właściwy wykonawca', bones.cover === jpg.length && bones.title === 'Bones' && bones.artist === 'Imagine Dragons', bones);
  check('okładki: Deezer przez JSONP (bez CORS), zapytanie artist:"Imagine Dragons" track:"Bones"', log.deezer.some(d => d.jsonp && d.q === 'artist:"imagine dragons" track:"bones"'), log.deezer.slice(0, 3));
  check('okładki: Believer (kanał „- Topic”) → iTunes 600×600', bel.cover === jpg.length && bel.artist === 'Imagine Dragons' && log.img.includes('/believer/600x600bb.jpg'), { bel, img: log.img });
  check('okładki: Queen („QueenVEVO”, „(Remastered 2011)”) → MusicBrainz, oficjalne wydanie', q.cover === jpg.length && q.title === 'Bohemian Rhapsody' && q.artist === 'Queen' && log.img.includes('/release/rel-q/front-500') && !log.img.includes('/release/rel-b/front-500'), { q, img: log.img });
  check('okładki: niepasujący wynik NIE jest przypisywany', unk.cover === 0 && unk.title === 'Zupełnie Nieznany Kawałek [HD]', unk);
  const gaps = log.itunes.slice(1).map((x, i) => x.t - log.itunes[i].t);
  check('okładki: iTunes w limicie (≥ 3 s między zapytaniami)', log.itunes.length >= 2 && gaps.every(g => g >= 3000), { n: log.itunes.length, gaps });
  const toast = await page.evaluate(() => document.getElementById('styleToast').textContent);
  check('okładki: komunikat 3 / 4', /3\s*\/\s*4/.test(toast), { toast, s: Math.round((Date.now() - t0) / 1000) });
  // ręczne „Uzupełnij online” ponawia tylko brakujące
  const nDeezer = log.deezer.length;
  await page.evaluate(() => { const b = document.getElementById('enrichBtn'); b && b.click(); });
  await poll(() => page.evaluate(() => !document.getElementById('enrichBtn').disabled), 30000, 300);
  await sleep(300);
  check('okładki: ręczne ponowienie szuka tylko utworu bez okładki', log.deezer.slice(nDeezer).every(d => d.q.includes('nieznany') || d.q.includes('kawałek') || d.q.includes('ktoś')), log.deezer.slice(nDeezer));
  await page.close();
}

/* ---------------- okładki w wersji desktopowej: wszystko przez curl.exe ---------------- */
async function testCoversDesktop(browser){
  const base = path.join(OUT, 'deskcov'); fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(path.join(base, 'app'), { recursive: true });
  const jpg = fs.readFileSync(path.join(MEDIA, 'cover.jpg'));
  const curlLog = [];
  const state = { writes: [], exec: [], watchers: new Map(), watchSeq: 0, ytVer: '2026.09.20', ytLatest: '2026.09.20',
    curl: (u) => {
      curlLog.push(u.hostname + u.pathname);
      if (u.hostname === 'api.deezer.com'){
        const q = (u.searchParams.get('q') || '').toLowerCase();
        return Buffer.from(JSON.stringify({ data: q.includes('bones') ? [{ title: 'Bones', title_short: 'Bones', artist: { name: 'Imagine Dragons' }, album: { title: 'Mercury - Act 2', cover_xl: 'https://cdn.test/bones.jpg' } }] : [] }));
      }
      if (u.hostname === 'cdn.test') return jpg;
      return null;
    } };
  // w przeglądarce Deezer i CDN są niedostępne (CORS) — JSONP też nie działa
  const netMock = (u) => (u.hostname === 'api.deezer.com' || u.hostname === 'cdn.test') ? { status: 403, body: 'CORS' } :
    (u.hostname === 'itunes.apple.com' || u.hostname === 'musicbrainz.org') ? { status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"results":[],"recordings":[]}' } : null;
  const page = await openApp(browser, { desktop: true, state, netMock, nlPath: path.join(base, 'app'), ls: { playerNetEnrich: '1', pulsarYtdlpAuto: '0' } });
  await poll(() => page.evaluate(() => document.documentElement.classList.contains('nl-desktop')));
  await loadFiles(page, [path.join(MEDIA, 'cov', 'Imagine Dragons - Bones (Official Audio).mp3')]);
  await poll(async () => { const t = await idbTracks(page); return t[0] && t[0].cover > 0; }, 40000, 300);
  const tr = (await idbTracks(page))[0];
  const tmpLeft = fs.existsSync(path.join(OUT, 'tmp')) ? fs.readdirSync(path.join(OUT, 'tmp')).filter(f => f.endsWith('.http')) : [];
  check('desktop: okładka Bones przez curl.exe (Deezer + CDN bez CORS)', tr.cover === jpg.length && tr.artist === 'Imagine Dragons' && curlLog.includes('api.deezer.com/search') && curlLog.includes('cdn.test/bones.jpg'), { tr, curlLog });
  check('desktop: pliki tymczasowe curl usunięte', tmpLeft.length === 0, tmpLeft);
  await page.close();
}

const browser = await launch();
try {
  if (WHICH === 'all' || WHICH === 'obs') await testObs(browser);
  if (WHICH === 'all' || WHICH === 'tags') await testTags(browser);
  if (WHICH === 'all' || WHICH === 'backup') await testBackup(browser);
  if (WHICH === 'all' || WHICH === 'desktop') await testDesktop(browser);
  if (WHICH === 'all' || WHICH === 'library') await testLibraryAdd(browser);
  if (WHICH === 'all' || WHICH === 'covers'){ await testCovers(browser); await testCoversDesktop(browser); }
  if (WHICH === 'all' || WHICH === 'settings') await testSettings(browser);
  if (WHICH === 'all' || WHICH === 'gapless') await testGapless(browser);
} catch (e){ console.log('FAIL wyjątek:', e && e.stack || e); failures++; }
await browser.close();
console.log(failures ? '\n' + failures + ' FAIL' : '\nWSZYSTKO OK');
process.exit(failures ? 1 : 0);
