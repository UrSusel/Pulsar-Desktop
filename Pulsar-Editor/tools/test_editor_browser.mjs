// Test integracyjny gotowej paczki (headless Chromium).
// NODE_PATH=<node_modules> node Pulsar-Editor/tools/test_editor_browser.mjs <rozpakowane-resources>
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), 'x.js'));
const puppeteerModule = require('puppeteer-core');
const chromiumModule = require('@sparticuz/chromium');
const puppeteer = puppeteerModule.default || puppeteerModule;
const chromium = chromiumModule.default || chromiumModule;
const RES = path.resolve(process.argv[2] || process.env.RES_DIR || '');
if (!fs.existsSync(path.join(RES, 'index.html'))) throw new Error('Podaj katalog z rozpakowanym resources.neu');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-editor-browser-'));
const DESKTOP = process.env.EDITOR_DESKTOP === '1';
const DOWNLOADS = path.join(TMP, 'downloads'); fs.mkdirSync(DOWNLOADS);
const NATIVE_DIR = path.join(TMP, 'native'); fs.mkdirSync(NATIVE_DIR);
const NATIVE_OUTPUT = path.join(NATIVE_DIR, 'Test Artist - Test Song (edycja).wav');
const NATIVE_OUTPUT_MP3 = path.join(NATIVE_DIR, 'Test Artist - Test Song (edycja).mp3');
const AI_PYTHON = path.join(TMP, 'pulsar', 'lyrics-ai', 'env', 'bin', 'python');
fs.mkdirSync(path.dirname(AI_PYTHON), { recursive: true }); fs.writeFileSync(AI_PYTHON, 'test python placeholder');
let lastFfmpegCommand = '';
let lastAiRequest = null;
let aiCheckShouldFail = false;
let aiPipMissing = false;
const aiSetupCommands = [];
const NEUTRALINO_STUB = String.raw`
(function(){
  var handlers = {};
  function call(op){ var a = Array.prototype.slice.call(arguments, 1); return window.__nfs(op, JSON.stringify(a)).then(function(r){ r = JSON.parse(r); if (r && r.__err) throw new Error(r.__err); return r; }); }
  function b64ToAb(b){ var s = atob(b), u = new Uint8Array(s.length); for (var i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u.buffer; }
  function abToB64(ab){ var u=new Uint8Array(ab),s=''; for(var i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000)); return btoa(s); }
  var noop=function(){return Promise.resolve(null);};
  var ns=function(extra){return new Proxy(extra||{},{get:function(t,k){return k in t?t[k]:noop;}});};
  window.NL_PATH=window.__NL_PATH||''; window.NL_PORT=47329; window.NL_TOKEN='editor.test';
  window.Neutralino={
    init:function(){},
    events:{on:function(e,f){(handlers[e]=handlers[e]||[]).push(f);return Promise.resolve();},off:noop,dispatch:noop,broadcast:noop},
    filesystem:ns({
      getStats:function(p){return call('getStats',p);}, readBinaryFile:function(p){return call('readBinaryFile',p).then(b64ToAb);}, readFile:function(p){return call('readFile',p);},
      writeBinaryFile:function(p,b){return call('writeBinaryFile',p,abToB64(b));}, appendBinaryFile:function(p,b){return call('appendBinaryFile',p,abToB64(b));},
      writeFile:function(p,s){return call('writeFile',p,s);}, createDirectory:function(p){return call('createDirectory',p);}, remove:function(p){return call('remove',p);},
      readDirectory:function(p,o){return call('readDirectory',p,o||{});}, createWatcher:function(){return Promise.resolve(1);}, removeWatcher:noop
    }),
    os:ns({execCommand:function(c){return call('execCommand',c);},getEnv:function(){return Promise.resolve(window.__NL_PATH);},showSaveDialog:function(t,o){return call('showSaveDialog',t,o);}}),
    window:ns({getTitle:function(){return Promise.resolve('Pulsar');}}), app:ns({}), storage:ns({})
  };
  window.__nlEmit=function(e,d){(handlers[e]||[]).forEach(function(f){try{f({detail:d});}catch(x){console.error(x);}});};
  document.addEventListener('DOMContentLoaded',function(){setTimeout(function(){window.__nlEmit('ready',{});},50);});
})();`;
let failures = 0;
const dialogMessages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  if (!ok) failures++;
}
async function poll(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  return null;
}
function makeWav(file) {
  const sr = 22050, seconds = 6, channels = 2, frames = sr * seconds;
  const dataSize = frames * channels * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0); out.writeUInt32LE(36 + dataSize, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22); out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const silent = (t >= 1 && t < 2) || (t >= 4 && t < 5);
    const sample = silent ? 0 : Math.round(Math.sin(2 * Math.PI * 220 * t) * 0.18 * 32767);
    out.writeInt16LE(sample, 44 + i * 4); out.writeInt16LE(sample, 46 + i * 4);
  }
  fs.writeFileSync(file, out);
}

const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css', png: 'image/png', wav: 'audio/wav', lrc: 'text/plain; charset=utf-8', py: 'text/x-python; charset=utf-8' };
const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/neutralino.js') { res.writeHead(200, { 'Content-Type': mime.js }); res.end(DESKTOP ? NEUTRALINO_STUB : ''); return; }
  const file = path.join(RES, pathname);
  if (!file.startsWith(RES + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file).slice(1)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const wavPath = path.join(TMP, 'Test Artist - Test Song.wav');
const lrcPath = path.join(TMP, 'Test Artist - Test Song.lrc');
const importedLrcPath = path.join(TMP, 'Imported lyrics.lrc');
makeWav(wavPath);
fs.writeFileSync(lrcPath, '[00:01.00] w pierwszej ciszy\n[00:02.50] druga linia\n[00:04.50] w drugiej ciszy\n[00:05.50] ostatnia linia\n');
fs.writeFileSync(importedLrcPath, '[00:00.50] imported first line\n[00:03.00] imported second line\n');
async function nativeFs(op, argsJson) {
  const args = JSON.parse(argsJson);
  try {
    if (op === 'showSaveDialog') {
      const requested = String(args[1] && args[1].defaultPath || '');
      return JSON.stringify(/\.mp3$/i.test(requested) ? NATIVE_OUTPUT_MP3 : NATIVE_OUTPUT);
    }
    if (op === 'writeBinaryFile') { fs.writeFileSync(args[0], Buffer.from(args[1], 'base64')); return 'null'; }
    if (op === 'appendBinaryFile') { fs.appendFileSync(args[0], Buffer.from(args[1], 'base64')); return 'null'; }
    if (op === 'readBinaryFile') return JSON.stringify(fs.readFileSync(args[0]).toString('base64'));
    if (op === 'readFile') return JSON.stringify(fs.readFileSync(args[0], 'utf8'));
    if (op === 'writeFile') { fs.writeFileSync(args[0], args[1]); return 'null'; }
    if (op === 'createDirectory') { fs.mkdirSync(args[0], { recursive: true }); return 'null'; }
    if (op === 'remove') { fs.rmSync(args[0], { force: true, recursive: true }); return 'null'; }
    if (op === 'getStats') {
      const stat = fs.statSync(args[0]);
      return JSON.stringify({ size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), createdAt: stat.birthtimeMs, modifiedAt: stat.mtimeMs });
    }
    if (op === 'readDirectory') return JSON.stringify(fs.readdirSync(args[0], { withFileTypes: true }).map(entry => ({ entry: entry.name, type: entry.isDirectory() ? 'DIRECTORY' : 'FILE' })));
    if (op === 'execCommand') {
      const command = String(args[0] || '');
      if (command === 'command -v ffmpeg' || command === 'where ffmpeg' || command.includes('command -v ffmpeg')) return JSON.stringify({ stdOut: '/usr/bin/ffmpeg\n', stdErr: '', exitCode: 0 });
      if (command.includes('lyrics-aligner.py') && command.includes('--check')) {
        if (aiCheckShouldFail) return JSON.stringify({ stdOut: '', stdErr: "PULSAR_AI_ERROR: No module named 'stable_whisper'", exitCode: 2 });
        return JSON.stringify({ stdOut: '{"ok":true,"stable_ts":"2.19.1"}\n', stdErr: '', exitCode: 0 });
      }
      if (command.includes(' -m pip --version')) {
        aiSetupCommands.push(command);
        return JSON.stringify(aiPipMissing ? { stdOut: '', stdErr: 'No module named pip', exitCode: 1 } : { stdOut: 'pip 26.0\n', stdErr: '', exitCode: 0 });
      }
      if (command.includes(' -m ensurepip --upgrade')) {
        aiSetupCommands.push(command); aiPipMissing = false;
        return JSON.stringify({ stdOut: 'pip bootstrapped\n', stdErr: '', exitCode: 0 });
      }
      if (command.includes(' -m pip install ')) {
        aiSetupCommands.push(command);
        if (aiPipMissing) return JSON.stringify({ stdOut: '', stdErr: 'No module named pip', exitCode: 1 });
        aiCheckShouldFail = false;
        return JSON.stringify({ stdOut: 'AI packages installed\n', stdErr: '', exitCode: 0 });
      }
      if (command.includes('lyrics-aligner.py') && command.includes('--request')) {
        const match = command.match(/--request '([^']+)' --output '([^']+)'/);
        if (!match) return JSON.stringify({ stdOut: '', stdErr: 'no AI request path', exitCode: 2 });
        const request = JSON.parse(fs.readFileSync(match[1], 'utf8'));
        lastAiRequest = request;
        const audioStart = Number(request.audio_start) || 0;
        const lines = request.lines.map((text, index) => {
          const tokens = text.split(/\s+/).filter(Boolean);
          return { t: audioStart + index + 1, d: tokens.length * 0.1, txt: text, words: tokens.map((token, wordIndex) => ({
            t: audioStart + index + 1 + wordIndex * 0.1, d: 0.1,
            txt: token + (wordIndex + 1 < tokens.length ? ' ' : '')
          })) };
        });
        fs.writeFileSync(match[2], JSON.stringify({ version: 1, lines, model: request.model, language: request.language, duration: 6, mean_probability: 0.9 }));
        return JSON.stringify({ stdOut: '', stdErr: '', exitCode: 0 });
      }
      if (command.includes('-hide_banner') && command.includes('-filter_complex')) {
        lastFfmpegCommand = command;
        const match = command.match(/'([^']+)'\s*$/) || command.match(/"([^"]+)"\s*$/);
        if (!match) return JSON.stringify({ stdOut: '', stdErr: 'no output path', exitCode: 1 });
        fs.writeFileSync(match[1], Buffer.from('ID3 simulated FFmpeg output'));
        return JSON.stringify({ stdOut: '', stdErr: '', exitCode: 0 });
      }
      return JSON.stringify({ stdOut: '2026.01.01\n', stdErr: '', exitCode: 0 });
    }
    return JSON.stringify({ __err: 'unknown op ' + op });
  } catch (error) { return JSON.stringify({ __err: String(error.message || error) }); }
}
let browser;
let outputSize = 0;
let mockLyricsProviders = false;
let mockAppRelease = { tag_name: 'v0.22.1', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.1' };
const appUpdateRequests = [];
const lyricsProviderRequests = [];
const lrclibLineOnly = {
  id: 1133018, duration: 6, hasWordSync: false,
  syncedLyrics: '[00:01.00]Take my breath'
};
const lyricsPlusWord = {
  type: 'Word', metadata: { source: 'QQ Music' },
  lyrics: [{
    time: 1000, duration: 1900, text: 'Take my breath',
    syllabus: [
      { time: 1000, duration: 250, text: 'Take ' },
      { time: 1250, duration: 250, text: 'my ' },
      { time: 1500, duration: 600, text: 'breath' }
    ]
  }],
  processingTime: { selectedSongMetadata: { title: 'Take My Breath', artist: 'The Weeknd', duration: 6 } }
};
try {
  const args = chromium.args.filter(arg => arg !== '--mute-audio' && !arg.startsWith('--single-process'))
    .concat(['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files']);
  browser = await puppeteer.launch({ args, executablePath: await chromium.executablePath(), headless: true, defaultViewport: { width: 1280, height: 900 } });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => { dialogMessages.push(dialog.message()); dialog.accept().catch(() => {}); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(origin)) {
      if (url === 'https://api.github.com/repos/UrSusel/Pulsar-Desktop/releases/latest') {
        appUpdateRequests.push(url);
        request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(mockAppRelease) }).catch(() => {});
      } else if (mockLyricsProviders && (url.startsWith('https://lrclib.net/') || url.startsWith('https://lyricsplus.prjktla.my.id/'))) {
        lyricsProviderRequests.push(url);
        const body = url.startsWith('https://lrclib.net/') ? lrclibLineOnly : lyricsPlusWord;
        request.respond({
          status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(body)
        }).catch(() => {});
      } else request.abort().catch(() => {});
    } else request.continue().catch(() => {});
  });
  await page.evaluateOnNewDocument((desktop, nlPath) => {
    if (desktop) window.__NL_PATH = nlPath;
    if (!sessionStorage.getItem('editorTestInit')) {
      sessionStorage.setItem('editorTestInit', '1');
      localStorage.setItem('playerLang', 'pl');
      localStorage.setItem('playerNetEnrich', '0');
      localStorage.setItem('playerSkipSilence', '0');
      localStorage.setItem('playerNorm', '0');
      localStorage.setItem('pulsarAppUpdateCheckedAt', String(Date.now()));
    }
  }, DESKTOP, TMP);
  if (DESKTOP) await page.exposeFunction('__nfs', nativeFs);
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  await page.goto(origin, { waitUntil: 'load' });
  check('moduł i przycisk edytora startują', await poll(() => page.evaluate(() => !!window.PulsarAudioEditor && !!document.getElementById('audioEditorBtn'))));
  check('ustawienia używają klasycznego cogwheela', await page.evaluate(() => {
    const path = document.querySelector('#settingsBtn svg path');
    return !!path && path.getAttribute('d').startsWith('M10.325') && !path.getAttribute('d').includes('M12 2.8v3');
  }));
  check('osobna nakładka karaoke jest całkowicie usunięta', await page.evaluate(() => !window.PulsarKaraoke && !document.getElementById('karaokeBtn') && !document.getElementById('karaokeMode')));

  await page.$eval('#folderInput', input => input.removeAttribute('webkitdirectory'));
  const input = await page.$('#folderInput');
  await input.uploadFile(wavPath, lrcPath);
  check('utwór testowy i LRC trafiają do biblioteki', await poll(() => page.evaluate(() => window.__player && __player.state().tracks === 1 && __player.state().currentIndex === 0)));
  await page.click('#audioEditorBtn');
  check('audio zostaje zdekodowane w edytorze', await poll(() => page.evaluate(() => window.PulsarAudioEditor.state().decoded)));
  check('import napisów jest osobną zakładką, a przycisk paska zniknął', await page.evaluate(() => !!document.querySelector('[data-tab="import"]') && !document.getElementById('lyricsImportBtn')));
  await page.click('[data-tab="import"]');
  const importInput = await page.$('#paeLyricsFile');
  await importInput.uploadFile(importedLrcPath);
  check('import z zakładki zapisuje zsynchronizowane napisy dla bieżącego utworu', await poll(() => page.evaluate(() => {
    const data = __player.__lyrics.forTrack(__player.__editor.current().id);
    return data && data.source === 'import' && data.sourceName === 'Imported lyrics.lrc' && data.synced && data.synced[0].txt === 'imported first line';
  })));
  check('importowana zmiana trafia też do warstwy napisów odtwarzacza', await page.evaluate(() => __player.__lyrics.data().source === 'import'));
  await page.click('#paeRestoreLyrics');
  check('przywracanie cofa import i ponownie pobiera lokalne napisy źródłowe', await poll(() => page.evaluate(() => {
    const data = __player.__lyrics.forTrack(__player.__editor.current().id);
    return data && data.source === 'lrc' && data.synced[0].txt === 'w pierwszej ciszy';
  })));
  await page.click('[data-tab="audio"]');

  await page.click('#paeDetect');
  check('wykrywanie ciszy dodaje dwa zakresy', await poll(() => page.evaluate(() => PulsarAudioEditor.state().cuts.length === 2)));
  await page.click('#paeClear');
  const setCut = async (start, end) => {
    await page.evaluate(({ start, end }) => {
      const s = document.getElementById('paeCutStart'), e = document.getElementById('paeCutEnd');
      s.value = String(start); e.value = String(end);
      document.getElementById('paeAddCut').click();
    }, { start, end });
  };
  await setCut(1, 2); await setCut(4, 5);
  check('ręczne cięcia mają dokładne czasy', await page.evaluate(() => JSON.stringify(PulsarAudioEditor.state().cuts) === JSON.stringify([{ start: 1, end: 2 }, { start: 4, end: 5 }])));
  check('podsumowanie pokazuje 4 sekundy wyniku', await page.$eval('#paeFinalDuration', el => el.textContent === '0:04.00'));

  await page.evaluate(() => { document.getElementById('audio').currentTime = 1.2; });
  await page.click('#paePreview');
  check('podgląd przeskakuje usunięty zakres', await poll(() => page.evaluate(() => document.getElementById('audio').currentTime >= 1.99)));
  await page.click('#paePreview');

  await page.$eval('.pae-cut-input', input => { input.value = '1.01'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  check('granica wycinka ma precyzyjne pole 1 ms', await page.evaluate(() => PulsarAudioEditor.state().cuts[0].start === 1.01));
  await page.click('#paeUndo');
  check('cofanie przywraca poprzednią granicę', await page.evaluate(() => PulsarAudioEditor.state().cuts[0].start === 1));
  await page.click('#paeZoomIn');
  check('zoom fali zwiększa widok do 2×', await page.evaluate(() => PulsarAudioEditor.state().zoom === 2));
  await page.$eval('#paeFadeIn', input => { input.value = '120'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.$eval('#paeJoinFade', input => { input.value = '25'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.$eval('#paeSilenceMin', input => { input.value = '1.2'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#paeSaveSession');
  const savedSessionKey = await page.evaluate(() => PulsarAudioEditor.state().sessionKey);
  check('sesja zapisuje decyzje bez audio w localStorage', await page.evaluate(key => {
    const raw = localStorage.getItem(key), value = JSON.parse(raw || 'null');
    return !!value && value.cuts.length === 2 && value.fadeInMs === 120 && value.joinFadeMs === 25 && value.silenceMin === 1.2 && raw.length < 2000;
  }, savedSessionKey));
  await page.click('#paeClose');
  await page.click('#audioEditorBtn');
  const resumed = await poll(() => page.evaluate(() => {
    const s = PulsarAudioEditor.state();
    return s.open && s.decoded && s.cuts.length === 2 && s.fadeInMs === 120 && s.joinFadeMs === 25 && s.silenceMin === 1.2 && s.zoom === 2;
  }));
  if (!resumed) console.log('DIAG resumed', await page.evaluate(key => ({ state: PulsarAudioEditor.state(), saved: JSON.parse(localStorage.getItem(key) || 'null'), status: document.getElementById('paeAudioStatus').textContent, hidden: document.getElementById('audioEditor').hidden }), savedSessionKey));
  check('sesja wznawia cięcia, przejścia, ciszę i zoom', !!resumed);
  if (!resumed) throw new Error('Sesja nie wznowiła się — szczegóły DIAG powyżej');

  await page.click('[data-tab="lyrics"]');
  check('lokalne LRC jest widoczne w edytorze', await poll(() => page.evaluate(() => document.querySelectorAll('#paeLyricsPreview .pae-lyric-row').length > 0)));
  await page.$eval('#paeOffsetNumber', el => { el.value = '0.5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  check('przesunięcie +0,5 s działa w runtime', await page.evaluate(() => __player.__lyrics.offset() === 0.5 && document.getElementById('paeOffsetValue').textContent.includes('0,50')));
  check('przesunięcie jest trwałe w localStorage', await page.evaluate(() => {
    const id = __player.__editor.current().id;
    return localStorage.getItem('playerLyricsOffset:' + id) === '0.5';
  }));

  await page.click('[data-tab="audio"]');
  await page.click('#paeSave');
  check('po zapisie biblioteka zawiera drugi utwór', await poll(() => page.evaluate(() => __player.state().tracks === 2)));
  check('edytor zamyka się po udanym zapisie', await poll(() => page.evaluate(() => !PulsarAudioEditor.state().open)));
  const outputFile = DESKTOP ? NATIVE_OUTPUT : path.join(DOWNLOADS, 'Test Artist - Test Song (edycja).wav');
  check(DESKTOP ? 'Neutralino zapisuje nowy WAV przez natywny dialog' : 'przeglądarka zapisuje nowy WAV', await poll(async () => fs.existsSync(outputFile) && fs.statSync(outputFile).size > 44));
  if (fs.existsSync(outputFile)) {
    const wav = fs.readFileSync(outputFile);
    outputSize = wav.length;
    const sampleRate = wav.readUInt32LE(24);
    check('WAV ma 4 sekundy stereo PCM', wav.readUInt32LE(40) === 4 * sampleRate * 2 * 2, { bytes: wav.length, sampleRate, data: wav.readUInt32LE(40) });
  }

  const record = await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('ambient-player-library', 2);
    request.onsuccess = () => {
      const get = request.result.transaction('tracks').objectStore('tracks').getAll();
      get.onsuccess = async () => {
        const item = get.result.find(x => /\(edycja\)\.wav$/i.test(x.name));
        resolve(item && { title: item.title, artist: item.artist, durMs: item.durMs, size: item.blob.size, srcPath: item.srcPath, lyrics: item.lyricsData });
      };
    };
  }));
  check('kopia zachowuje metadane i czas trwania', record && record.title === 'Test Song (edycja)' && record.artist === 'Test Artist' && record.durMs === 4000 && record.size === outputSize, record && { title: record.title, durMs: record.durMs, size: record.size });
  if (DESKTOP) check('biblioteka zna natywną ścieżkę zapisanej kopii', record && record.srcPath === NATIVE_OUTPUT, record && record.srcPath);
  check('napisy kopii są przesunięte i dopasowane do cięć', record && JSON.stringify(record.lyrics && record.lyrics.synced) === JSON.stringify([
    { t: 2, txt: 'druga linia' }, { t: 3, txt: 'w drugiej ciszy' }, { t: 4, txt: 'ostatnia linia' }
  ]), record && record.lyrics);

  await page.reload({ waitUntil: 'load' });
  check('biblioteka odtwarza oba utwory po restarcie', await poll(() => page.evaluate(() => window.__player && __player.state().tracks === 2)));
  const indices = await page.evaluate(() => __player.__sound.trackIds().map((id, index) => ({ index, name: __player.__net.trackAt(index).fileName })));
  const editedIndex = indices.find(item => /\(edycja\)\.wav$/i.test(item.name)).index;
  const originalIndex = indices.find(item => !/\(edycja\)\.wav$/i.test(item.name)).index;
  const persisted = await page.evaluate(async (index) => {
    await __player.loadIndex(index);
    const data = await __player.__lyrics.fetchFor(index);
    return { offset: __player.__lyrics.offset(), lines: data && data.synced };
  }, editedIndex);
  check('dopasowane napisy przeżywają restart, bez podwójnego offsetu', persisted && persisted.offset === 0 && persisted.lines && persisted.lines.length === 3 && persisted.lines[0].t === 2, persisted);
  const originalOffset = await page.evaluate(async (index) => { await __player.loadIndex(index); return __player.__lyrics.offset(); }, originalIndex);
  check('oryginał zachowuje własne przesunięcie +0,5 s', originalOffset === 0.5);

  const wordView = await page.evaluate(async () => {
    const api = __player.__lyrics, audio = document.getElementById('audio');
    const original = api.data(), oldOffset = api.offset(), oldTime = audio.currentTime, wasOn = api.on();
    const audioDurationDescriptor = Object.getOwnPropertyDescriptor(audio, 'duration');
    const source = `version: "1.0"\nmetadata:\n  title: Test\n  artist: Test\nlines:\n  - text: A man that\n    words:\n      - text: "A "\n        start_ms: 1000\n      - text: "man "\n        start_ms: 1400\n        end_ms: 1600\n      - text: that\n        start_ms: 1800\n    start_ms: 1000\n    end_ms: 2200\n`;
    try {
      if (!wasOn) { api.set(true); await api.fetchFor(__player.state().currentIndex); }
      api.setOffset(0);
      const lines = api.parseWords(source);
      api.render({ synced: lines, plain: null, source: 'lrclib', wordSync: true });
      audio.currentTime = 1.2; api.highlight();
      const derivedProgress = parseFloat(document.querySelector('#lyricsBox .lyrics-word').style.getPropertyValue('--word-progress'));
      audio.currentTime = 1.5; api.highlight();
      const active = document.querySelector('#lyricsBox .lyrics-line.active');
      const words = active ? Array.from(active.querySelectorAll('.lyrics-word')) : [];
      const middle = {
        text: active && active.textContent,
        sung: words.filter(word => word.classList.contains('sung')).map(word => word.textContent),
        total: words.length,
        progress: words.length === 3 ? parseFloat(words[1].style.getPropertyValue('--word-progress')) : null,
        gradient: words.length === 3 && getComputedStyle(words[1]).backgroundImage.includes('linear-gradient'),
        colorsDiffer: words.length === 3 && getComputedStyle(words[0]).color !== getComputedStyle(words[2]).color
      };
      audio.currentTime = 1.9; api.highlight();
      const allSung = words.length === 3 && words.every(word => word.classList.contains('sung'));
      const lastProgress = words.length === 3 ? parseFloat(words[2].style.getPropertyValue('--word-progress')) : null;
      const boundaryLines = api.parseWords(`version: "1.0"\nlines:\n  - text: A B\n    words:\n      - text: "A "\n        start_ms: 1000\n      - text: B\n        start_ms: 1400\n    start_ms: 1000\n  - text: Next end\n    words:\n      - text: "Next "\n        start_ms: 2000\n      - text: end\n        start_ms: 3000\n    start_ms: 2000\n`);
      api.render({ synced: boundaryLines, plain: null, source: 'lrclib', wordSync: true });
      audio.currentTime = 1.7; api.highlight();
      const nextLineProgress = parseFloat(document.querySelector('#lyricsBox .lyrics-line.active .lyrics-word:last-child').style.getPropertyValue('--word-progress'));
      Object.defineProperty(audio, 'duration', { configurable: true, value: 6 });
      audio.currentTime = 4.5; api.highlight();
      const audioEndProgress = parseFloat(document.querySelector('#lyricsBox .lyrics-line.active .lyrics-word:last-child').style.getPropertyValue('--word-progress'));
      const mediaDuration = audio.duration;
      const audioEndExpected = (4.5 - 3) / (mediaDuration - 3) * 100;
      api.render({ synced: api.parse('[00:01.00]A man that'), plain: null, source: 'lrc' });
      audio.currentTime = 1.5; api.highlight();
      const standard = document.querySelector('#lyricsBox .lyrics-line.active');
      return { middle, derivedProgress, allSung, lastProgress, nextLineProgress, audioEndProgress, audioEndExpected, standardLine: !!standard && !standard.querySelector('.lyrics-word') && standard.textContent === 'A man that' };
    } finally {
      if (audioDurationDescriptor) Object.defineProperty(audio, 'duration', audioDurationDescriptor); else delete audio.duration;
      api.render(original); api.setOffset(oldOffset); audio.currentTime = oldTime; api.highlight();
      if (!wasOn) api.set(false);
    }
  });
  check('zwykłe napisy rozjaśniają tylko słowa, których czas już nadszedł', wordView.middle.text === 'A man that' && wordView.middle.total === 3 && JSON.stringify(wordView.middle.sung) === JSON.stringify(['A ', 'man ']) && wordView.middle.colorsDiffer, wordView.middle);
  check('bieżące słowo wypełnia się stopniowo zgodnie z rzeczywistym end_ms', Math.abs(wordView.middle.progress - 50) < 0.2 && wordView.middle.gradient, { progress: wordView.middle.progress, gradient: wordView.middle.gradient });
  check('bez własnego czasu słowo używa odstępu do następnego', Math.abs(wordView.derivedProgress - 50) < 0.2, wordView.derivedProgress);
  check('kolejne słowo rozjaśnia się po swoim znaczniku czasu', wordView.allSung);
  check('ostatnie słowo może użyć rzeczywistego końca linii', Math.abs(wordView.lastProgress - 25) < 0.2, wordView.lastProgress);
  check('ostatnie słowo bez end_ms wypełnia się do następnej linii', Math.abs(wordView.nextLineProgress - 50) < 0.2, wordView.nextLineProgress);
  check('ostatnie słowo ostatniej linii wypełnia się do końca audio', Number.isFinite(wordView.audioEndExpected) && Math.abs(wordView.audioEndProgress - wordView.audioEndExpected) < 0.2, { actual: wordView.audioEndProgress, expected: wordView.audioEndExpected });
  check('bez czasów słów zostaje standardowe podświetlanie całej linii', wordView.standardLine);

  const generatedLifecycle = await page.evaluate(async () => {
    const api = __player.__lyrics, id = __player.__editor.current().id;
    const generated = {
      synced: [{ t: 2, txt: 'druga linia', words: [{ t: 2, txt: 'druga ' }, { t: 2.2, txt: 'linia' }] }],
      plain: null, source: 'ai', generated: true, experimental: true, wordSync: true, model: 'base', coverage: 1
    };
    api.applyFor(id, generated);
    const applied = api.forTrack(id);
    const cached = JSON.parse(localStorage.getItem('playerLyricsV2:' + id) || 'null');
    await api.resetFor(id);
    const restored = api.forTrack(id);
    return { applied, cached, restored };
  });
  check('wynik AI trafia do cache i jest oznaczony jako eksperymentalny', generatedLifecycle.applied && generatedLifecycle.applied.source === 'ai' && generatedLifecycle.applied.generated === true && generatedLifecycle.applied.synced[0].words.length === 2 && generatedLifecycle.cached && generatedLifecycle.cached.source === 'ai', generatedLifecycle.applied);
  check('przywracanie usuwa wynik AI i ponownie używa lokalnego LRC', generatedLifecycle.restored && generatedLifecycle.restored.source === 'lrc' && generatedLifecycle.restored.synced.length === 4 && !generatedLifecycle.restored.synced.some(line => line.words), generatedLifecycle.restored);

  if (DESKTOP) {
    await page.click('#audioEditorBtn');
    await page.click('[data-tab="lyrics"]');
    check('przycisk AI jest dostępny dla tekstu bez źródłowego word-sync', await poll(() => page.evaluate(() => {
      const button = document.getElementById('paeAiAlign');
      return button && !button.disabled && !!document.getElementById('paeAiLanguage');
    })));
    await page.select('#paeAiLanguage', 'en');
    await page.click('#paeAiAlign');
    check('AI pokazuje kandydata bez zapisywania go przy utworze', await poll(() => page.evaluate(() => {
      const id = __player.__editor.current().id, saved = __player.__lyrics.forTrack(id), preview = __player.__lyrics.data();
      return !document.getElementById('paeAiCandidate').hidden && saved && saved.source === 'lrc' && preview && preview.source === 'ai';
    })));
    await page.evaluate(() => __player.__lyrics.setOffset(1.25));
    await page.click('#paeAiPreviewSource');
    check('porównanie A/B potrafi wrócić do źródła bez zmiany cache', await page.evaluate(() => {
      const id = __player.__editor.current().id;
      return __player.__lyrics.data().source === 'lrc' && __player.__lyrics.forTrack(id).source === 'lrc' && !document.getElementById('paeAiCandidate').hidden;
    }));
    await page.click('#paeAiPreviewNew');
    check('podgląd AI nie nalicza starego offsetu podczas porównania', await page.evaluate(() => {
      const preview = __player.__lyrics.data(), offset = __player.__lyrics.offset();
      return preview.source === 'ai' && Math.abs(preview.synced[0].t + offset - 1) < 0.001;
    }));
    await page.evaluate(() => document.getElementById('audio').pause());
    await page.click('#paeAiDiscard');
    check('odrzucenie usuwa kandydata i zachowuje poprzednie napisy', await page.evaluate(() => {
      const id = __player.__editor.current().id;
      return document.getElementById('paeAiCandidate').hidden && __player.__lyrics.data().source === 'lrc' && __player.__lyrics.forTrack(id).source === 'lrc' && __player.__lyrics.offset() === 1.25;
    }));
    await page.click('#paeAiAlign');
    await poll(() => page.evaluate(() => !document.getElementById('paeAiCandidate').hidden));
    await page.evaluate(() => __player.__lyrics.setOffset(1.25));
    await page.click('#paeAiAccept');
    check('dopiero akceptacja zapisuje wynik słów przez prawdziwy mostek', await poll(() => page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.source === 'ai' && data.generated && data.wordSync && data.synced.length === 4 && data.synced[0].words.length > 0;
    })));
    check('akceptacja AI zeruje stary offset, aby nie naliczyć go ponownie', await page.evaluate(() => __player.__lyrics.offset() === 0));
    check('wynik AI zachowuje rzeczywiste czasy trwania słów', await page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.synced[0].d > 0 && data.synced[0].words[0].d === 0.1;
    }));
    check('helper dostaje język, model i rzeczywiste linie tekstu', lastAiRequest && lastAiRequest.language === 'en' && lastAiRequest.model === 'base' && lastAiRequest.lines.length === 4 && /w pierwszej ciszy/.test(lastAiRequest.lines[0]) && /\.wav$/i.test(lastAiRequest.audio_path), lastAiRequest && { language: lastAiRequest.language, model: lastAiRequest.model, lines: lastAiRequest.lines.length });
    check('wynik AI ma oznaczenie i przycisk przywrócenia', await page.evaluate(() => /Eksperymentalny wynik AI/.test(document.getElementById('paeAiStatus').textContent) && !document.getElementById('paeAiRestore').hidden));
    const aiPersisted = await page.evaluate(() => new Promise(resolve => {
      const id = __player.__editor.current().id;
      const request = indexedDB.open('ambient-player-library', 2);
      request.onsuccess = () => {
        const get = request.result.transaction('tracks').objectStore('tracks').getAll();
        get.onsuccess = () => { const item = get.result.find(x => x.id === id); resolve(item && item.lyricsData); };
      };
    }));
    check('wynik AI jest trwale zapisany przy utworze', aiPersisted && aiPersisted.source === 'ai' && aiPersisted.generated === true && aiPersisted.synced[0].words.length > 0, aiPersisted && { source: aiPersisted.source, generated: aiPersisted.generated });
    await page.click('#paeAiRestore');
    check('przycisk przywraca źródło po teście AI', await poll(() => page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.source === 'lrc' && data.synced.length === 4 && !data.generated;
    })));
    await page.select('#paeAiScope', 'range');
    await page.$eval('#paeAiRangeStart', input => { input.value = '2'; });
    await page.$eval('#paeAiRangeEnd', input => { input.value = '4'; });
    await page.click('#paeAiAlign');
    check('zakres AI tworzy niezapisanego kandydata i wysyła tylko wybraną linię', await poll(() => page.evaluate(() => !document.getElementById('paeAiCandidate').hidden)) && lastAiRequest && lastAiRequest.audio_start === 2 && lastAiRequest.audio_end === 4 && JSON.stringify(lastAiRequest.lines) === JSON.stringify(['druga linia']), lastAiRequest);
    await page.click('#paeAiAccept');
    const partialMerged = await poll(() => page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.generated ? data : null;
    }));
    check('akceptacja zakresu scala wynik bez ruszania linii poza nim', partialMerged && partialMerged.partial && JSON.stringify(partialMerged.synced.map(line => line.t)) === JSON.stringify([1, 3, 4.5, 5.5]) && partialMerged.synced[0].txt.includes('pierwszej') && partialMerged.synced[2].txt.includes('drugiej') && partialMerged.synced[3].txt.includes('ostatnia'), partialMerged);
    await page.click('#paeAiRestore');
    await poll(() => page.evaluate(() => __player.__lyrics.forTrack(__player.__editor.current().id).source === 'lrc'));
    await page.select('#paeAiScope', 'full');
    aiCheckShouldFail = true; aiPipMissing = true; aiSetupCommands.length = 0;
    const pipRecovery = await page.evaluate(async () => {
      const current = __player.__editor.current();
      const result = await __pulsarDesktopTools.alignLyrics({
        inputBlob: current.file, inputName: current.file.name,
        lines: ['Broken venv recovery'], language: 'en', model: 'base'
      });
      return { source: result.source, words: result.synced[0].words.length };
    });
    const setupSequence = aiSetupCommands.map(command => command.includes('pip --version') ? 'pip-check' : command.includes('ensurepip') ? 'ensurepip' : 'install');
    check('niekompletne venv bez pip jest naprawiane przed instalacją AI', pipRecovery.source === 'ai' && pipRecovery.words === 3 && JSON.stringify(setupSequence) === JSON.stringify(['pip-check', 'ensurepip', 'install']), { setupSequence, commands: aiSetupCommands });
    check('instalator używa python -m pip zamiast launchera pip.exe', aiSetupCommands.length === 3 && aiSetupCommands.every(command => command.includes(AI_PYTHON) && command.includes(' -m ')), aiSetupCommands);
    aiCheckShouldFail = true; aiPipMissing = false; aiSetupCommands.length = 0;
    const decoderRecovery = await page.evaluate(async () => {
      const current = __player.__editor.current();
      const result = await __pulsarDesktopTools.alignLyrics({
        inputBlob: current.file, inputName: current.file.name,
        lines: ['PyAV nineteen recovery'], language: 'en', model: 'base'
      });
      return { source: result.source, words: result.synced[0].words.length };
    });
    const decoderSequence = aiSetupCommands.map(command => command.includes('pip --version') ? 'pip-check' : 'install');
    check('niezgodny PyAV jest wykrywany i naprawiany przez ograniczenie av<19', decoderRecovery.source === 'ai' && decoderRecovery.words === 3 && JSON.stringify(decoderSequence) === JSON.stringify(['pip-check', 'install']) && aiSetupCommands.some(command => command.includes('av>=12,<19')), { decoderSequence, commands: aiSetupCommands });
    await page.click('#paeClose');
  }

  check('panel Auto-DJ 2.0 jest dostępny', await page.evaluate(() => !!document.getElementById('pulsarDjPlus') && !!window.PulsarAutoDj));
  const djChoice = await page.evaluate(() => {
    PulsarAutoDj.set({ mood: 'calm', artistDiversity: 80, genreDiversity: 60 });
    const preview = PulsarAutoDj.preview();
    const index = __player.__dj.choose();
    const last = PulsarAutoDj.lastChoice();
    return { preview: preview && preview.index, index: index, reason: last && last.reason, settings: PulsarAutoDj.settings() };
  });
  check('Auto-DJ stosuje nastrój i zwraca wyjaśnienie wyboru', djChoice && Number.isInteger(djChoice.index) && djChoice.index !== originalIndex && /Spokojnie/.test(djChoice.reason || '') && djChoice.settings.artistDiversity === 80, djChoice);
  const djUndo = await page.evaluate(() => {
    const start = __player.state().currentIndex;
    const picked = PulsarAutoDj.playSimilar();
    const after = __player.state().currentIndex;
    const backed = __player.__dj.back();
    return { start: start, picked: picked, after: after, backed: backed, restored: __player.state().currentIndex, history: __player.__dj.history().length };
  });
  check('Więcej podobnych i cofanie korzystają z historii DJ', djUndo && djUndo.picked === djUndo.after && djUndo.backed && djUndo.restored === djUndo.start, djUndo);

  if (DESKTOP) {
    check('natywny FFmpeg jest wykrywany', await page.evaluate(async () => (await __pulsarDesktopTools.capabilities(true)).ffmpeg));
    const backupResults = await page.evaluate(async dir => {
      PulsarBackups.set({ enabled: false, safety: true, folder: dir, keep: 2 });
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await PulsarBackups.snapshot('test-' + i));
      return results.map(x => ({ name: x.name, size: x.size, tracks: x.tracks }));
    }, NATIVE_DIR);
    const backupFiles = fs.readdirSync(NATIVE_DIR).filter(name => /^Pulsar-auto-.*\.pulsarlib$/i.test(name)).sort();
    check('automatyczne migawki mają format .pulsarlib i rotację do 2 wersji', backupResults.length === 3 && backupFiles.length === 2 && backupFiles.every(name => fs.readFileSync(path.join(NATIVE_DIR, name)).subarray(0, 9).toString() === 'PULSARLIB'), { results: backupResults, files: backupFiles });
    const uniqueGuard = await page.evaluate(async () => {
      const current = __player.__editor.current();
      return __pulsarLibraryGuard.beforeRemove([current], { total: __player.state().tracks, kind: 'remove' });
    });
    check('usunięcie jedynej kopii wymaga osobnego ostrzeżenia i robi migawkę', uniqueGuard === true && dialogMessages.some(message => /tylko w bibliotece/i.test(message)), dialogMessages.slice(-3));
    const restoreGuard = await page.evaluate(async () => {
      const allowed = await __pulsarLibraryGuard.beforeRestore({ tracks: 1 });
      return { allowed: allowed, path: PulsarBackups.state().lastPath };
    });
    check('restore jest poprzedzony migawką bezpieczeństwa', restoreGuard.allowed === true && /before-restore/.test(restoreGuard.path), restoreGuard);

    await page.evaluate(async index => { await __player.loadIndex(index); }, originalIndex);
    await page.click('#audioEditorBtn');
    await poll(() => page.evaluate(() => PulsarAudioEditor.state().decoded));
    await setCut(1, 2);
    await page.select('#paeFormat', 'mp3');
    await page.$eval('#paeImport', input => { input.checked = false; });
    await page.click('#paeSave');
    check('eksport MP3 przechodzi przez natywny FFmpeg', await poll(async () => fs.existsSync(NATIVE_OUTPUT_MP3) && fs.statSync(NATIVE_OUTPUT_MP3).size > 0));
    check('FFmpeg otrzymuje kodek MP3, cięcia i fade', lastFfmpegCommand.includes('libmp3lame') && lastFfmpegCommand.includes('atrim=') && lastFfmpegCommand.includes('afade='), lastFfmpegCommand.slice(-500));
    await poll(() => page.evaluate(() => !PulsarAudioEditor.state().open));

    const enlarged = await page.evaluate(async index => {
      await __player.loadIndex(index);
      const file = __player.__editor.current().file;
      try { Object.defineProperty(file, 'size', { value: 90 * 1024 * 1024, configurable: true }); return file.size > 80 * 1024 * 1024; } catch (e) { return false; }
    }, originalIndex);
    check('test może oznaczyć źródło jako duży plik', enlarged);
    await page.click('#audioEditorBtn');
    check('duży plik używa FFmpeg bez AudioBuffer', await poll(() => page.evaluate(() => PulsarAudioEditor.state().nativeMode && !PulsarAudioEditor.state().decoded)));
    await page.evaluate(() => { PulsarAudioEditor.close(); const file = __player.__editor.current().file; try { delete file.size; } catch (e) {} });
  }

  await page.evaluate(() => __player.__lyrics.set(false));
  const plusWavPath = path.join(TMP, 'The Weeknd - Take My Breath.wav');
  makeWav(plusWavPath);
  await page.$eval('#folderInput', input => input.removeAttribute('webkitdirectory'));
  const plusInput = await page.$('#folderInput');
  await plusInput.uploadFile(plusWavPath);
  check('utwór bez lokalnego LRC trafia do testu źródeł online', await poll(() => page.evaluate(() => __player.state().tracks === 3)));
  mockLyricsProviders = true;
  const plusResult = await page.evaluate(async () => {
    const index = __player.state().tracks - 1;
    await __player.loadIndex(index);
    const id = __player.__editor.current().id;
    // Stary cache z wersji LRCLIB-only nie może blokować nowego resolvera.
    localStorage.setItem('playerLyrics:' + id, JSON.stringify({ synced: [{ t: 0, txt: 'stary cache' }], plain: null, source: 'lrclib' }));
    const data = await __player.__lyrics.fetchFor(index);
    const cached = JSON.parse(localStorage.getItem('playerLyricsV2:' + id) || 'null');
    return { data, cached, title: __player.__editor.current().title, artist: __player.__editor.current().artist };
  });
  mockLyricsProviders = false;
  check('LRCLIB bez słów jest ulepszany przez Lyrics+ z prawdziwymi czasami', plusResult && plusResult.data && plusResult.data.source === 'lyricsplus' && plusResult.data.provider === 'QQ Music' && plusResult.data.wordSync === true && JSON.stringify(plusResult.data.synced[0].words) === JSON.stringify([
    { t: 1, txt: 'Take ', d: 0.25 }, { t: 1.25, txt: 'my ', d: 0.25 }, { t: 1.5, txt: 'breath', d: 0.6 }
  ]), plusResult && plusResult.data);
  check('Lyrics+ otrzymuje właściwy tytuł i wykonawcę po LRCLIB', (() => {
    const lrclibAt = lyricsProviderRequests.findIndex(url => url.startsWith('https://lrclib.net/'));
    const plusAt = lyricsProviderRequests.findIndex(url => url.startsWith('https://lyricsplus.prjktla.my.id/'));
    if (lrclibAt < 0 || plusAt <= lrclibAt) return false;
    const query = new URL(lyricsProviderRequests[plusAt]).searchParams;
    return query.get('title') === 'Take My Breath' && query.get('artist') === 'The Weeknd';
  })(), lyricsProviderRequests);
  check('nowy cache zachowuje wynik word-sync i omija stary format', plusResult && plusResult.cached && plusResult.cached.source === 'lyricsplus' && plusResult.cached.wordSync === true, plusResult && plusResult.cached);
  check('źródło napisów przekazuje deklarowaną długość do kontroli wersji', plusResult && plusResult.data.sourceDuration === 6 && plusResult.cached.sourceDuration === 6, plusResult && { data: plusResult.data.sourceDuration, cached: plusResult.cached.sourceDuration });

  await page.evaluate(() => { __player.__lyrics.forTrack(__player.__editor.current().id).sourceDuration = 12; });
  await page.click('#audioEditorBtn'); await page.click('[data-tab="lyrics"]');
  check('duża różnica długości pokazuje możliwość innej wersji, nie pewnik', await poll(() => page.evaluate(() => {
    const warning = document.getElementById('paeVersionWarning');
    return warning && !warning.hidden && /mogą pochodzić z innej wersji/.test(warning.textContent) && /12|00:12/.test(warning.textContent);
  })));
  const firstWordOffset = await page.evaluate(() => {
    const audio = document.getElementById('audio'); audio.pause(); audio.currentTime = 3.25; return audio.currentTime;
  });
  await page.click('#paeOffsetFirst');
  check('pierwsze słowo kalibruje globalny offset z bieżącej pozycji', await poll(() => page.evaluate(() => Math.abs(__player.__lyrics.offset() - 2.25) < 0.001)), firstWordOffset);
  await page.evaluate(() => { __player.__lyrics.setOffset(0); __player.__lyrics.forTrack(__player.__editor.current().id).sourceDuration = 6; });
  await page.click('#paeClose');

  const aiSourceOverride = await page.evaluate(async () => {
    const id = __player.__editor.current().id;
    const generated = {
      synced: [{ t: 1, txt: 'Take my breath', words: [{ t: 1, txt: 'Take ' }, { t: 1.2, txt: 'my ' }, { t: 1.4, txt: 'breath' }] }],
      source: 'ai', generated: true, wordSync: true
    };
    let guard = '', applied = null, restored = null, error = '';
    try { __player.__lyrics.applyFor(id, generated); } catch (caught) { guard = String(caught && caught.message || caught); }
    try {
      __player.__lyrics.applyFor(id, generated, { allowSourceWordSync: true });
      applied = __player.__lyrics.forTrack(id);
      restored = await __player.__lyrics.resetFor(id);
    } catch (caught) { error = String(caught && caught.message || caught); }
    return { guard, applied, restored, error };
  });
  check('API bez potwierdzenia nadal chroni źródłowy word-sync', /potwierdzenia/.test(aiSourceOverride.guard), aiSourceOverride.guard);
  check('ręczne dopasowanie może zastąpić źródłowy word-sync i zachowuje kopię', !aiSourceOverride.error && aiSourceOverride.applied && aiSourceOverride.applied.source === 'ai' && aiSourceOverride.applied.previousLyrics && aiSourceOverride.applied.previousLyrics.source === 'lyricsplus', aiSourceOverride);
  check('przywrócenie odzyskuje źródłowy word-sync po ręcznym zastąpieniu', aiSourceOverride.restored && aiSourceOverride.restored.source === 'lyricsplus' && aiSourceOverride.restored.wordSync === true && aiSourceOverride.restored.synced[0].words.length === 3, aiSourceOverride.restored);

  check('manifest i karta pokazują zainstalowaną wersję 0.22.1', await poll(() => page.evaluate(() => {
    const version = document.getElementById('pupdateVersion');
    return !!window.PulsarUpdates && !!version && version.textContent.startsWith('0.22.1') && document.getElementById('pupdateAuto').checked;
  })));
  check('aplikacja automatycznie sprawdza aktualizację po uruchomieniu', await poll(() => appUpdateRequests.length >= 1));
  mockAppRelease = { tag_name: 'v0.22.2', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.2' };
  await page.evaluate(() => { document.getElementById('settingsMenu').hidden = false; document.getElementById('pupdateCheck').click(); });
  check('ręczne sprawdzenie pokazuje nowszy release i bezpieczny link', await poll(() => page.evaluate(() => {
    const result = PulsarUpdates.state(), link = document.getElementById('pupdateDownload');
    return result && result.updateAvailable && result.latest === '0.22.2' && !link.hidden && link.href === 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.2' && link.target === '_blank' && link.rel.includes('noopener') && /0\.22\.2/.test(document.getElementById('pupdateStatus').textContent);
  })));
  if (DESKTOP) {
    check('desktop otwiera release przez natywny system, nie wewnętrzny webview', await page.evaluate(() => {
      const link = document.getElementById('pupdateDownload');
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    }));
  }
  mockAppRelease = { tag_name: 'v0.22.1', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.1' };
  await page.evaluate(() => document.getElementById('pupdateCheck').click());
  check('release równy zainstalowanej wersji nie oferuje pobierania', await poll(() => page.evaluate(() => {
    const result = PulsarUpdates.state();
    return result && !result.error && !result.updateAvailable && result.latest === '0.22.1' && document.getElementById('pupdateDownload').hidden && /najnowszą wersję/.test(document.getElementById('pupdateStatus').textContent);
  })));
  mockAppRelease = { tag_name: 'Linux', name: 'Release 0.20.12', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/Linux' };
  await page.evaluate(() => document.getElementById('pupdateCheck').click());
  check('nienumeryczny tag release jest zgłaszany jako nieznana wersja', await poll(() => page.evaluate(() => {
    const result = PulsarUpdates.state();
    return result && result.error === 'invalid-tag' && !result.updateAvailable && document.getElementById('pupdateDownload').hidden && /nie ma tagu wersji/.test(document.getElementById('pupdateStatus').textContent);
  })));
  check('UI odpytuje wyłącznie endpoint latest właściwego repozytorium', appUpdateRequests.length >= 4 && appUpdateRequests.every(url => url === 'https://api.github.com/repos/UrSusel/Pulsar-Desktop/releases/latest'), appUpdateRequests);
  mockAppRelease = { tag_name: 'v0.23.0', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.23.0' };
  await page.evaluate(() => PulsarUpdates.check({ manual: true }));
  check('nowa wersja pokazuje powiadomienie w aplikacji', await poll(() => page.evaluate(() => {
    const toast = document.getElementById('styleToast');
    return !!toast && /0\\.23\\.0/.test(toast.textContent);
  })));
  await page.evaluate(() => { document.getElementById('settingsMenu').hidden = true; });

  await page.evaluate(() => PulsarAudioEditor.open('lyrics'));
  for (const lang of ['en', 'es']) {
    const translationAudit = await page.evaluate(async (language) => {
      __player.__i18n.set(language);
      await new Promise(resolve => setTimeout(resolve, 60));
      const roots = ['audioEditor', 'pulsarDjPlus', 'pulsarAutoBackup', 'pulsarAppUpdate'].map(id => document.getElementById(id)).filter(Boolean);
      const missed = [];
      const inspect = (value) => {
        const key = String(value || '').trim();
        const entry = PulsarI18n.dictionary[key];
        if (entry && entry[language] && entry[language] !== key) missed.push(key);
      };
      roots.forEach(root => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) inspect(node.nodeValue);
        root.querySelectorAll('[title], [aria-label], [placeholder], [alt]').forEach(el => ['title', 'aria-label', 'placeholder', 'alt'].forEach(attr => inspect(el.getAttribute(attr))));
      });
      return {
        missed: Array.from(new Set(missed)),
        editorTitle: document.getElementById('paeTitle').textContent,
        aiTitle: document.querySelector('.pae-ai-section h3').textContent,
        editorButton: document.getElementById('audioEditorBtn').title,
        saveTitle: document.getElementById('paeSave').title,
        backupTitle: document.querySelector('#pulsarAutoBackup h3').textContent,
        updateStatus: document.getElementById('pupdateStatus').textContent,
        djReason: document.getElementById('padjReason').textContent,
        lyricsStatus: document.getElementById('paeLyricsStatus').textContent
      };
    }, lang);
    check('nowe panele nie zostawiają polskich kluczy po zmianie na ' + lang, translationAudit.missed.length === 0, translationAudit);
    check('edytor i przycisk są przetłumaczone na ' + lang, translationAudit.editorTitle === (lang === 'en' ? 'Edit track' : 'Editar canción') && /AI|IA/.test(translationAudit.aiTitle) && translationAudit.editorButton === (lang === 'en' ? 'Edit audio and lyrics' : 'Editar audio y letra') && !/Oryginał|nadpisany/.test(translationAudit.saveTitle), translationAudit);
    check('aktualizacje, kopie, Auto-DJ i status napisów odświeżają język ' + lang, lang === 'en'
      ? /latest release/.test(translationAudit.updateStatus) && /Automatic backups/.test(translationAudit.backupTitle) && /Drag the slider/.test(translationAudit.lyricsStatus) && !/Spokojnie|brzmienie/.test(translationAudit.djReason)
      : /última versión/.test(translationAudit.updateStatus) && /Copias automáticas/.test(translationAudit.backupTitle) && /Arrastra el control/.test(translationAudit.lyricsStatus) && !/Spokojnie|brzmienie/.test(translationAudit.djReason), translationAudit);
  }
  check('powrót do polskiego przywraca oryginalne teksty nowych paneli', await page.evaluate(() => {
    __player.__i18n.set('pl');
    return document.getElementById('paeTitle').textContent === 'Edycja utworu'
      && /Dopasowanie AI/.test(document.querySelector('.pae-ai-section h3').textContent)
      && document.querySelector('#pulsarAutoBackup h3').textContent === 'Automatyczne kopie i bezpieczeństwo'
      && /Najnowszy release/.test(document.getElementById('pupdateStatus').textContent);
  }));
  await page.evaluate(() => PulsarAudioEditor.close());

  if (DESKTOP) {
    const bridgeGuard = await page.evaluate(async () => {
      try { await __pulsarDesktopTools.alignLyrics({ lines: ['Take my breath'], hasSourceWordSync: true }); return ''; }
      catch (error) { return String(error && error.message || error); }
    });
    check('mostek bez potwierdzenia nadal odrzuca zastąpienie word-sync', /potwierdzenia/.test(bridgeGuard), bridgeGuard);
    const bridgeRangeGuard = await page.evaluate(async () => {
      try { await __pulsarDesktopTools.alignLyrics({ lines: ['Take my breath'], audioStart: 3, audioEnd: 2 }); return ''; }
      catch (error) { return String(error && error.message || error); }
    });
    check('mostek odrzuca niepoprawny zakres przed uruchomieniem analizy', /zakres/.test(bridgeRangeGuard), bridgeRangeGuard);
    await page.click('#audioEditorBtn');
    await page.click('[data-tab="lyrics"]');
    check('word-sync nie blokuje już ręcznego przycisku AI', await poll(() => page.evaluate(() => {
      const button = document.getElementById('paeAiAlign');
      return button && !button.disabled && /możesz ręcznie/.test(document.getElementById('paeAiStatus').textContent);
    })));
    await page.select('#paeAiLanguage', 'en');
    await page.evaluate(() => {
      const tools = __pulsarDesktopTools, align = tools.alignLyrics;
      window.__testSourceAiJob = null;
      tools.alignLyrics = function (job, onProgress) {
        window.__testSourceAiJob = { hasSourceWordSync: job.hasSourceWordSync, allowSourceWordSync: job.allowSourceWordSync };
        return align.call(this, job, onProgress);
      };
    });
    await page.click('#paeAiAlign');
    check('mimo źródłowego word-sync wynik również czeka na akceptację', await poll(() => page.evaluate(() => {
      const id = __player.__editor.current().id;
      return !document.getElementById('paeAiCandidate').hidden && __player.__lyrics.forTrack(id).source === 'lyricsplus' && __player.__lyrics.data().source === 'ai';
    })));
    await page.click('#paeAiAccept');
    check('UI pozwala zapisać dopasowanie wersji teledysku mimo źródłowego word-sync', await poll(() => page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.source === 'ai' && data.generated && data.previousLyrics && data.previousLyrics.source === 'lyricsplus';
    })));
    const sourceAiJob = await page.evaluate(() => window.__testSourceAiJob);
    check('mostek dostaje jawne zezwolenie na zastąpienie źródłowego word-sync', sourceAiJob && sourceAiJob.hasSourceWordSync === true && sourceAiJob.allowSourceWordSync === true, sourceAiJob);
    check('potwierdzenie informuje o zastąpieniu i możliwości przywrócenia', dialogMessages.some(message => /ma już word-sync/.test(message) && /zachowane do przywrócenia/.test(message)), dialogMessages);
    await page.click('#paeAiRestore');
    check('przycisk przywraca źródło także po dopasowaniu wersji teledysku', await poll(() => page.evaluate(() => {
      const data = __player.__lyrics.forTrack(__player.__editor.current().id);
      return data && data.source === 'lyricsplus' && data.wordSync && data.synced[0].words.length === 3;
    })));
  }

  check('brak nieobsłużonych błędów JavaScript', pageErrors.length === 0, pageErrors);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} — test integracyjny edytora, błędów: ${failures}`);
process.exitCode = failures ? 1 : 0;
