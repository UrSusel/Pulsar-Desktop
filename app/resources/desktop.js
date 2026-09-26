/* desktop.js — warstwa desktopowa Muzyki (Neutralino).
 * Zamienia wywołania lokalnego mostka HTTP (127.0.0.1:8765) na
 * bezpośrednie uruchamianie yt-dlp.exe leżącego obok aplikacji.
 * W przeglądarce ten plik nie jest ładowany — muzyka.html działa jak dotychczas.
 */
(function () {
  'use strict';
  if (typeof Neutralino === 'undefined') return;

  const ready = new Promise((resolve) => { try { Neutralino.init(); } catch (e) {} resolve(); });

  const APP_DIR = (typeof NL_PATH === 'string' && NL_PATH) ? NL_PATH : '.';
  const YTDLP = joinPath(APP_DIR, 'yt-dlp.exe');
  const FFMPEG = joinPath(APP_DIR, 'ffmpeg.exe');
  let tmpDir = null;
  let pingCache = null, pingTs = 0;
  let chain = Promise.resolve(); // serializacja wywołań yt-dlp
  let ffmpegPresent = null;      // null = nie sprawdzono

  function joinPath(a, b){ return a.replace(/[\\/]+$/, '') + '/' + b; }
  // ścieżka z okna dialogowego/wklejenia: cudzysłowy z „Kopiuj jako ścieżkę", spacje, końcowe ukośniki
  function cleanWinPath(p){
    let s = String(p || '').trim().replace(/^"+/, '').replace(/"+$/, '').trim();
    s = s.replace(/[\\/]+$/, '');
    return s;
  }
  function q(s){ return '"' + String(s).replace(/"/g, '') + '"'; }
  function uuid(){ return 'mu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function isBridgeUrl(u){
    try {
      const x = new URL(u, location.href);
      if (x.protocol !== 'http:') return null;
      if (x.hostname !== '127.0.0.1' && x.hostname !== 'localhost') return null;
      if (String(x.port) === String(location.port)) return null; // serwer Neutralino
      return x;
    } catch (e){ return null; }
  }

  async function getTmp(){
    if (tmpDir) return tmpDir;
    try {
      const t = await Neutralino.os.getEnv('TEMP');
      tmpDir = (t && t.trim()) ? t.trim().replace(/[\\/]+$/, '') : joinPath(APP_DIR, 'tmp');
    } catch (e){ tmpDir = joinPath(APP_DIR, 'tmp'); }
    try { await Neutralino.filesystem.createDirectory(tmpDir); } catch (e){}
    return tmpDir;
  }

  function run(cmd, timeoutMs){
    const to = timeoutMs || 240000;
    const job = chain.then(() => Promise.race([
      Neutralino.os.execCommand(cmd),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), to))
    ]));
    chain = job.catch(() => {});
    return job;
  }

  /* ---- Pobieranie przez curl.exe (Windows 10/11) — omija CORS; używane do okładek/metadanych ----
     Poza kolejką yt-dlp (run), żeby szukanie okładek nie czekało na pobieranie utworów. */
  let httpBusy = Promise.resolve();
  function httpGet(url, timeoutMs){
    url = String(url || '');
    if (!/^https:\/\/[^\s"<>|^]+$/i.test(url)) return Promise.reject(new Error('bad url'));
    const job = httpBusy.then(async function(){
      const tmp = await getTmp();
      const f = joinPath(tmp, uuid() + '.http');
      const to = Math.round((timeoutMs || 20000) / 1000);
      const cmd = 'curl.exe -sSL --fail --max-time ' + to + ' -A "Pulsar/1.0 (+https://github.com/UrSusel/Pulsar-Desktop)" -o ' + q(f) + ' ' + q(url);
      try {
        const r = await Promise.race([Neutralino.os.execCommand(cmd), new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('timeout')); }, (to + 5) * 1000); })]);
        const o = execOut(r);
        if (o.exitCode) throw new Error('curl ' + o.exitCode + ' ' + o.stderr.slice(0, 120));
        return new Uint8Array(await Neutralino.filesystem.readBinaryFile(f));
      } finally { try { await Neutralino.filesystem.remove(f); } catch (e){} }
    });
    httpBusy = job.catch(function(){});
    return job;
  }

  function parseJsonLoose(s){
    const t = String(s || '').trim();
    if (!t) return null;
    try { return JSON.parse(t); } catch (e){}
    const i = t.indexOf('{');
    if (i >= 0){ try { return JSON.parse(t.slice(i)); } catch (e){} }
    return null;
  }

  async function hasYtDlp(){
    try {
      const st = await Neutralino.filesystem.getStats(YTDLP);
      return !!st;
    } catch (e){ return false; }
  }
  async function hasFfmpeg(){
    if (ffmpegPresent !== null) return ffmpegPresent;
    try { await Neutralino.filesystem.getStats(FFMPEG); ffmpegPresent = true; }
    catch (e){ ffmpegPresent = false; }
    return ffmpegPresent;
  }

  function mapEntry(e){
    if (!e || !e.id) return null;
    return {
      id: String(e.id), ytId: String(e.id), title: e.title || '',
      uploader: e.uploader || e.channel || 'YouTube',
      duration: (typeof e.duration === 'number' && e.duration > 0) ? e.duration : 0
    };
  }

  /* ---- osadzanie tytułu/wykonawcy/okładki w MP4/M4A: wspólny kod w tags.js (używa go też edytor tagów) ---- */
  function mp4EmbedBytes(src, meta){
    try { return (window.PulsarTags && window.PulsarTags.mp4Embed) ? window.PulsarTags.mp4Embed(src, meta) : src; } catch (e){ return src; }
  }

  // okładka z YT: maxresdefault (1280×720, bez pasów) → mqdefault (320×180, bez pasów); hqdefault ma paski — unikamy
  async function fetchCoverJpeg(id){
    const urls = ['https://i.ytimg.com/vi/' + id + '/maxresdefault.jpg', 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'];
    for (let i = 0; i < urls.length; i++){
      try {
        const c = new AbortController();
        const tmr = setTimeout(function (){ try { c.abort(); } catch (e){} }, 9000);
        const r = await fetch(urls[i], { signal: c.signal });
        clearTimeout(tmr);
        if (!r.ok) continue;
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length > 3000 && b[0] === 0xFF && b[1] === 0xD8) return b; // JPEG, nie 120×90 placeholder
      } catch (e){}
    }
    return null;
  }

  function execOut(r){
    // Neutralino v6 zwraca { pid, stdOut, stdErr, exitCode }; stuby/testy: { stdout, stderr }
    return {
      raw: String((r && (r.stdOut != null ? r.stdOut : r.stdout)) || ''),
      stderr: String((r && (r.stdErr != null ? r.stdErr : r.stderr)) || '').trim(),
      exitCode: (r && typeof r.exitCode === 'number') ? r.exitCode : null
    };
  }
  async function ytdlpRun(args, timeoutMs){
    const r = execOut(await run(q(YTDLP) + ' ' + args + ' --no-warnings', timeoutMs));
    return { out: parseJsonLoose(r.raw), raw: r.raw, stderr: r.stderr, exitCode: r.exitCode };
  }
  async function ytdlpJson(args, timeoutMs){
    return (await ytdlpRun(args, timeoutMs)).out;
  }

  // pobiera audio do katalogu tymczasowego; zwraca { path, ext }
  // mode: 'play' — najszybciej (bez osadzania), 'mp3' — konwersja gdy ffmpeg,
  //       'save' — zapis na dysk: bez ffmpeg preferuj m4a (da się osadzić okładkę czystym JS)
  async function downloadAudio(id, mode){
    try { return await downloadAudioOnce(id, mode); }
    catch (e){
      // YouTube często psuje starsze yt-dlp → raz na sesję spróbuj aktualizacji i powtórz
      if (await ytdlpUpdater.autoFix()) return await downloadAudioOnce(id, mode);
      throw e;
    }
  }
  async function downloadAudioOnce(id, mode){
    const tmp = await getTmp();
    const base = joinPath(tmp, uuid());
    const ff = await hasFfmpeg();
    let args = '-f bestaudio/best --no-playlist -o ' + q(base + '.%(ext)s');
    if (mode === 'mp3' && ff){
      args += ' -x --audio-format mp3 --audio-quality 192K --embed-metadata --embed-thumbnail --ffmpeg-location ' + q(FFMPEG);
    } else if (mode === 'save' && !ff){
      args = '-f bestaudio[ext=m4a]/bestaudio/best --no-playlist -o ' + q(base + '.%(ext)s');
    }
    args += ' ' + q('https://www.youtube.com/watch?v=' + id);
    await run(q(YTDLP) + ' ' + args, 300000);
    const stem = base.split('/').pop().split('\\').pop();
    const entries = await Neutralino.filesystem.readDirectory(tmp);
    // Neutralino v6: DirectoryEntry = { entry: 'nazwa.plik', type: 'FILE'|'DIRECTORY' } (pole „name” nie istnieje)
    const fname = function (f){ return String((f && (f.entry != null ? f.entry : f.name)) || ''); };
    const hit = (entries || []).find(f => f && f.type === 'FILE' &&
      fname(f).indexOf(stem) === 0 && /\.(mp3|m4a|webm|opus|ogg)$/i.test(fname(f)));
    if (!hit) throw new Error('download failed');
    const ext = (fname(hit).match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase();
    return { path: joinPath(tmp, fname(hit)), ext: ext };
  }

  async function fileBlob(path, ext){
    const buf = await Neutralino.filesystem.readBinaryFile(path);
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'webm' ? 'audio/webm' :
      ext === 'opus' ? 'audio/ogg' : ext === 'ogg' ? 'audio/ogg' : 'audio/mp4';
    try { await Neutralino.filesystem.remove(path); } catch (e){}
    return new Blob([buf], { type: mime });
  }

  function jsonResponse(obj, status){
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }

  /* ---- obsługa endpointów mostka ---- */
  async function handleEndpoint(x){
    const p = x.pathname;
    if (p === '/ping'){
      if (pingCache && Date.now() - pingTs < 15000) return jsonResponse(pingCache);
      const ok = await hasYtDlp();
      const ff = ok ? await hasFfmpeg() : false;
      let ver = '';
      if (ok){
        try {
          const r = execOut(await run(q(YTDLP) + ' --version --no-warnings', 10000));
          ver = r.raw.trim();
        } catch (e){}
      }
      const live = !!(ok && ver); // plik jest ORAZ dał się uruchomić
      pingCache = { ok: live, ytdlp: live, ffmpeg: ff, version: ver };
      pingTs = Date.now();
      return jsonResponse(pingCache);
    }
    if (p === '/savedir'){
      const dir = cleanWinPath(x.searchParams.get('dir'));
      if (!dir) return jsonResponse({ ok: true, dir: '' });
      try { await Neutralino.filesystem.createDirectory(dir); } catch (e){} // istniejący folder też rzuca — ignorujemy
      try {
        const st = await Neutralino.filesystem.getStats(dir);
        if (!st) throw new Error('folder niedostępny po utworzeniu');
        return jsonResponse({ ok: true, dir: dir });
      } catch (e){ return jsonResponse({ ok: false, error: 'Nie mogę utworzyć folderu „' + dir + '": ' + String((e && e.message) || e) }, 400); }
    }
    if (!(await hasYtDlp())){
      return jsonResponse({ ok: false, error: 'yt-dlp.exe nie znaleziony obok aplikacji' }, 503);
    }
    if (p === '/search'){
      const term = x.searchParams.get('q') || '';
      const d = await ytdlpJson(q('ytsearch8:' + term) + ' --flat-playlist --dump-single-json');
      const items = (d && d.entries ? d.entries : []).map(mapEntry).filter(Boolean);
      return jsonResponse({ items: items });
    }
    if (p === '/track'){
      const id = x.searchParams.get('id') || '';
      const d = await ytdlpJson('--dump-single-json --no-playlist ' + q('https://www.youtube.com/watch?v=' + id));
      const m = mapEntry(d);
      return m ? jsonResponse(m) : jsonResponse({ ok: false, error: 'no metadata' }, 404);
    }
    if (p === '/playlist'){
      const raw = (x.searchParams.get('u') || '').trim();
      const m = raw.match(/[?&]list=([\w-]{12,})/) || raw.match(/^([\w-]{12,})$/);
      if (!m) return jsonResponse({ ok: true, title: 'Playlista', items: [], error: 'To nie jest link playlisty YouTube (brak list=…)' });
      const listId = m[1];
      const isMix = /^(RD|UL)/.test(listId); // RD… = radio/mix, UL… = My Mix — yt-dlp tego nie pobierze
      const PL_URL = q('https://www.youtube.com/playlist?list=' + listId);
      let res = await ytdlpRun('--flat-playlist --dump-single-json ' + PL_URL, 65000);
      if (!res.out){ // przejściowe zacięcie YouTube → jedna próba ponowna (2×65 s mieści się w limicie apki)
        await new Promise(function (r){ setTimeout(r, 1200); });
        res = await ytdlpRun('--flat-playlist --dump-single-json ' + PL_URL, 65000);
      }
      const items = (res.out && res.out.entries ? res.out.entries : []).map(mapEntry).filter(Boolean);
      let error = '';
      if (!items.length){
        if (isMix) error = 'To mix/radio YouTube (RD…/UL…) — yt-dlp nie potrafi pobrać takiej listy. Dodaj utwory pojedynczo albo wklej link zwykłej playlisty.';
        else {
          const last = (res.stderr || '').split('\n').filter(function (l){ return l.trim(); }).pop() || '';
          error = last.slice(0, 300)
            || (res.exitCode ? 'yt-dlp zakończył pracę z kodem błędu ' + res.exitCode + ' (bez szczegółów)' : '')
            || 'yt-dlp nie zwrócił żadnych pozycji playlisty';
        }
      }
      return jsonResponse({ ok: true, title: (res.out && res.out.title) || 'Playlista', items: items, error: error });
    }
    if (p === '/audio' || p === '/mp3'){
      const id = x.searchParams.get('id') || '';
      try {
        const dl = await downloadAudio(id, p === '/mp3' ? 'mp3' : 'play');
        const blob = await fileBlob(dl.path, dl.ext);
        return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type } });
      } catch (e){
        return new Response('desktop download failed: ' + String((e && e.message) || e), { status: 502 });
      }
    }
    if (p === '/mp3save'){
      const id = x.searchParams.get('id') || '';
      let dir = (x.searchParams.get('dir') || '').trim();
      if (!dir) return jsonResponse({ ok: false, error: 'Nie ustawiono folderu na dysku' }, 400);
      dir = cleanWinPath(dir);
      try { await Neutralino.filesystem.createDirectory(dir); } catch (e){}
      try {
        const st = await Neutralino.filesystem.getStats(dir);
        if (!st) throw new Error('folder niedostępny');
      } catch (e){ return jsonResponse({ ok: false, error: 'Nie mogę utworzyć folderu „' + dir + '": ' + String((e && e.message) || e) }, 400); }
      let meta = null;
      try { meta = await ytdlpJson('--dump-single-json --no-playlist ' + q('https://www.youtube.com/watch?v=' + id)); } catch (e){}
      try {
        const dl = await downloadAudio(id, 'save');
        const title = (meta && meta.title) || id;
        const uploader = (meta && (meta.uploader || meta.channel)) || '';
        const nice = String((uploader ? uploader + ' - ' : '') + title)
          .replace(/[<>:"/\\|?*]+/g, '_').replace(/\s{2,}/g, ' ').trim().slice(0, 140) || 'utwor';
        const dest = joinPath(dir, nice + '.' + dl.ext);
        let buf = await Neutralino.filesystem.readBinaryFile(dl.path);
        // okładka + tytuł + wykonawca prosto do MP4/M4A (bez ffmpeg); mp3 załatia yt-dlp --embed-thumbnail
        if (dl.ext === 'm4a' || dl.ext === 'mp4'){
          try {
            const artist = String(uploader).replace(/\s*-\s*Topic\s*$/i, '').trim();
            const cover = await fetchCoverJpeg(id);
            const embedded = mp4EmbedBytes(new Uint8Array(buf), { title: title, artist: artist, cover: cover });
            if (embedded !== buf) buf = embedded;
          } catch (e){}
        }
        await writeBinary(dest, buf);
        try { await Neutralino.filesystem.remove(dl.path); } catch (e){}
        return jsonResponse({ ok: true, dir: dir, file: nice + '.' + dl.ext, path: dest });
      } catch (e){
        return jsonResponse({ ok: false, error: 'Zapis na dysk nie powiódł się: ' + (e && e.message || e) }, 502);
      }
    }
    return new Response('desktop bridge: unknown endpoint', { status: 404 });
  }

  async function writeBinary(dest, buf){
    // Neutralino v6: filesystem.writeBinaryFile(path, ArrayBuffer)
    if (ArrayBuffer.isView(buf)){
      buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (Neutralino.filesystem.writeBinaryFile){
      await Neutralino.filesystem.writeBinaryFile(dest, buf);
      return;
    }
    // fallback: base64 przez writeFile
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000){
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    await Neutralino.filesystem.writeFile(dest, btoa(bin));
  }


  /* ---- dostęp do plików dla index.html (edytor tagów: zapis oryginału na dysku) ---- */
  window.__pulsarFs = {
    writeBinary: function (path, u8){ return writeBinary(path, u8); },
    readBinary: function (path){ return Neutralino.filesystem.readBinaryFile(path); },
    appendBinary: function (path, u8){
      const buf = ArrayBuffer.isView(u8) ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) : u8;
      return Neutralino.filesystem.appendBinaryFile(path, buf);
    },
    saveDialog: function (title, name, ext, label){
      return Neutralino.os.showSaveDialog(title, { defaultPath: name, filters: [{ name: label || ext, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] })
        .then(function (p){ if (!p) return ''; p = String(p); return /\.[a-z0-9]+$/i.test(p) ? p : p + '.' + ext; });
    }
  };

  function dHost(){ return window.__pulsarHost || null; }
  function dTr(s){ const h = dHost(); try { return h && h.t ? h.t(s) : s; } catch (e){ return s; } }
  function dToast(s){ const h = dHost(); try { if (h && h.toast) h.toast(s); } catch (e){} }
  function onReadyDom(fn){
    let done = false;
    const go = function (){ if (done) return; done = true; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); };
    try { Neutralino.events.on('ready', go); } catch (e){}
  }

  /* ================= Aktualizacja yt-dlp =================
   * Ręcznie: przycisk w ustawieniach (yt-dlp.exe -U). Automatycznie: raz na dobę porównanie
   * z najnowszym wydaniem na GitHubie; do tego jedna próba aktualizacji, gdy pobieranie się sypie.
   */
  const ytdlpUpdater = (function (){
    const K_CHECK = 'pulsarYtdlpCheck', K_AUTO = 'pulsarYtdlpAuto';
    let busy = null, triedFix = false, curVer = '';
    function autoOn(){ try { return localStorage.getItem(K_AUTO) !== '0'; } catch (e){ return true; } }
    async function version(){
      try {
        if (!(await hasYtDlp())) return '';
        const r = execOut(await run(q(YTDLP) + ' --version', 20000));
        curVer = (r.raw.trim().split(/\s+/)[0] || '');
      } catch (e){ curVer = ''; }
      updateUi();
      return curVer;
    }
    async function latest(){
      try {
        const r = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { cache: 'no-store' });
        if (!r.ok) return '';
        const j = await r.json();
        return String(j.tag_name || '').trim();
      } catch (e){ return ''; }
    }
    function newer(a, b){ // a > b dla wersji w formacie 2025.09.26(.123456)
      const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++){
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
      }
      return false;
    }
    function update(){
      if (busy) return busy;
      busy = (async function (){
        const before = await version();
        if (!before) return { ok: false, error: dTr('yt-dlp.exe nie znaleziony obok aplikacji') };
        updateUi();
        let r;
        try { r = execOut(await run(q(YTDLP) + ' -U', 240000)); }
        catch (e){ return { ok: false, before: before, error: String((e && e.message) || e) }; }
        pingCache = null;
        try { localStorage.setItem(K_CHECK, String(Date.now())); } catch (e){}
        const after = await version();
        const txt = r.raw + '\n' + r.stderr;
        const upToDate = /up to date|up-to-date/i.test(txt);
        const ok = !!after && (after !== before || upToDate);
        const last = (r.stderr || r.raw).split('\n').map(function (l){ return l.trim(); }).filter(Boolean).pop() || '';
        return { ok: ok, before: before, after: after, changed: !!after && after !== before, error: ok ? '' : (last.slice(0, 240) || dTr('nieznany błąd')) };
      })();
      const p = busy;
      p.then(function (){ busy = null; updateUi(); }, function (){ busy = null; updateUi(); });
      return p;
    }
    async function manual(){
      dToast(dTr('Sprawdzam aktualizację yt-dlp…'));
      const r = await update();
      if (!r.ok) dToast(dTr('Aktualizacja yt-dlp nie powiodła się: ') + r.error);
      else if (r.changed) dToast(dTr('yt-dlp zaktualizowany: ') + r.before + ' → ' + r.after);
      else dToast(dTr('yt-dlp jest aktualny (') + r.after + ')');
    }
    async function autoCheck(){
      if (!autoOn()) { version(); return; }
      let last = 0; try { last = +localStorage.getItem(K_CHECK) || 0; } catch (e){}
      const cur = await version();
      if (!cur || Date.now() - last < 24 * 3600 * 1000) return;
      try { localStorage.setItem(K_CHECK, String(Date.now())); } catch (e){}
      const lat = await latest();
      if (!lat || !newer(lat, cur)) return;
      const r = await update();
      if (r.ok && r.changed) dToast(dTr('yt-dlp zaktualizowany: ') + r.before + ' → ' + r.after);
    }
    async function autoFix(){
      if (triedFix || !autoOn()) return false;
      triedFix = true;
      const r = await update();
      if (r.ok && r.changed){ dToast(dTr('yt-dlp zaktualizowany: ') + r.before + ' → ' + r.after); return true; }
      return false;
    }
    function updateUi(){
      const b = document.getElementById('smYtdlpBtn');
      if (b){
        b.disabled = !!busy;
        b.textContent = busy ? dTr('Aktualizuję yt-dlp…') : dTr('Aktualizuj yt-dlp') + (curVer ? ' (' + curVer + ')' : '');
      }
      const a = document.getElementById('smYtdlpAuto'); if (a) a.checked = autoOn();
    }
    onReadyDom(function (){
      const b = document.getElementById('smYtdlpBtn'); if (b) b.addEventListener('click', manual);
      const a = document.getElementById('smYtdlpAuto');
      if (a) a.addEventListener('change', function (){ try { localStorage.setItem(K_AUTO, a.checked ? '1' : '0'); } catch (e){} if (a.checked) autoCheck(); });
      document.addEventListener('pulsar:lang', updateUi);
      updateUi();
      setTimeout(autoCheck, 6000); // po starcie, żeby nie spowalniać otwierania okna
    });
    return { update: update, manual: manual, autoFix: autoFix, version: version, autoCheck: autoCheck, newer: newer };
  })();

  /* ================= Obserwowany folder =================
   * Nowe pliki audio z wybranego folderu (z podfolderami) same trafiają do biblioteki.
   * Nic nie jest usuwane; plik raz zauważony nie wraca, jeśli usuniesz go z biblioteki.
   */
  const watchFolder = (function (){
    const K_DIR = 'pulsarWatchDir', K_SEEN = 'pulsarWatchSeen';
    const AUDIO = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;
    const SIDE = ['.png', '.jpg', '.jpeg', '.lrc'];
    const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm', webm: 'audio/webm',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', lrc: 'text/plain' };
    const BATCH = 20;
    let dir = '', seen = {}, watcherId = null, scanning = false, again = false, timer = 0, lastAdded = 0;

    function norm(p){ return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
    function key(p){ return norm(p).toLowerCase(); }
    function loadPrefs(){
      try { dir = norm(localStorage.getItem(K_DIR) || ''); } catch (e){ dir = ''; }
      try { const s = JSON.parse(localStorage.getItem(K_SEEN) || 'null'); seen = (s && s.dir === key(dir) && s.map) ? s.map : {}; } catch (e){ seen = {}; }
    }
    function saveSeen(){ try { localStorage.setItem(K_SEEN, JSON.stringify({ dir: key(dir), map: seen })); } catch (e){} }
    function relOf(p){ const base = dir.split('/').pop() || 'Folder'; return base + '/' + norm(p).slice(dir.length + 1); }
    function extOf(p){ const m = /\.([a-z0-9]+)$/i.exec(String(p)); return m ? m[1].toLowerCase() : ''; }
    function sleep(ms){ return new Promise(function (r){ setTimeout(r, ms); }); }

    async function makeFile(p){
      const buf = await Neutralino.filesystem.readBinaryFile(p);
      const name = norm(p).split('/').pop();
      let mt = Date.now(); try { const st = await Neutralino.filesystem.getStats(p); if (st && st.modifiedAt) mt = st.modifiedAt; } catch (e){}
      const f = new File([buf], name, { type: MIME[extOf(p)] || '', lastModified: mt });
      try { Object.defineProperty(f, 'webkitRelativePath', { value: relOf(p) }); } catch (e){}
      f.__srcPath = norm(p);
      return f;
    }

    async function scan(){
      if (!dir) return;
      if (scanning){ again = true; return; }
      const h = dHost();
      if (!h || !h.importFiles){ setTimeout(scan, 1500); return; }
      scanning = true; again = false;
      let added = 0, fresh = 0;
      try {
        let entries;
        try { entries = await Neutralino.filesystem.readDirectory(dir, { recursive: true }); }
        catch (e){ updateUi(dTr('Folder niedostępny')); return; }
        const all = new Set();
        const files = (entries || []).filter(function (e){ return e && e.type === 'FILE'; }).map(function (e){
          const p = norm(e.path || joinPath(dir, e.entry)); all.add(p.toLowerCase()); return p;
        });
        const libPaths = h.libraryPaths ? h.libraryPaths() : new Set();
        const todo = [];
        for (const p of files){
          if (!AUDIO.test(p)) continue;
          const k = p.toLowerCase();
          if (seen[k]) continue;
          if (libPaths.has(k)){ seen[k] = 1; continue; }
          todo.push(p);
        }
        if (!todo.length) return;
        todo.sort(function (a, b){ return a.localeCompare(b, 'pl'); });
        for (let i = 0; i < todo.length; i += BATCH){
          const part = todo.slice(i, i + BATCH);
          const batch = [];
          for (const p of part){
            try {
              const st = await Neutralino.filesystem.getStats(p);
              // plik jeszcze się kopiuje/pobiera → wróć do niego za chwilę
              const age = st && st.modifiedAt ? Date.now() - st.modifiedAt : 1e9;
              if (age >= 0 && age < 2500){ again = true; continue; }
              // utwór dodany kiedyś ręcznie z tego samego folderu → tylko zapamiętaj ścieżkę (bez czytania pliku)
              if (h.adoptPath && st && h.adoptPath(relOf(p), st.size, p)){ seen[p.toLowerCase()] = 1; continue; }
              batch.push(await makeFile(p));
              const stem = p.slice(0, p.lastIndexOf('.'));
              for (const ext of SIDE){
                const hit = [stem + ext, stem + ext.toUpperCase()].find(function (c){ return all.has(c.toLowerCase()); });
                if (hit){ try { batch.push(await makeFile(files.find(function (f){ return f.toLowerCase() === hit.toLowerCase(); }))); } catch (e){} }
              }
              seen[p.toLowerCase()] = 1; fresh++;
            } catch (e){ /* plik zablokowany lub zniknął — spróbujemy przy następnym skanie */ }
          }
          if (batch.length){ try { added += h.importFiles(batch) || 0; } catch (e){} }
          saveSeen();
          updateUi(dTr('Dodaję z folderu… ') + Math.min(i + BATCH, todo.length) + ' / ' + todo.length);
          await sleep(30);
        }
      } finally {
        saveSeen();
        scanning = false;
        if (added){ lastAdded = added; dToast(dTr('Obserwowany folder: dodano utworów: ') + added); }
        updateUi();
        if (again) schedule(3000);
      }
      return { added: added, read: fresh };
    }
    function schedule(ms){ clearTimeout(timer); timer = setTimeout(scan, ms || 2000); }

    async function startWatcher(){
      await stopWatcher();
      if (!dir) return;
      try { watcherId = await Neutralino.filesystem.createWatcher(dir); } catch (e){ watcherId = null; }
    }
    async function stopWatcher(){
      if (watcherId == null) return;
      try { await Neutralino.filesystem.removeWatcher(watcherId); } catch (e){}
      watcherId = null;
    }
    function onWatch(e){
      const d = (e && e.detail) || {};
      if (watcherId == null || (d.id != null && d.id !== watcherId)) return;
      if (d.action === 'delete') return;
      if (d.filename && !AUDIO.test(d.filename) && !/\.(png|jpe?g|lrc)$/i.test(d.filename) && d.filename.indexOf('.') > -1) return;
      schedule(2500);
    }

    async function choose(){
      let picked = '';
      try { picked = await Neutralino.os.showFolderDialog(dTr('Wybierz folder z muzyką do obserwowania'), dir ? { defaultPath: dir.replace(/\//g, '\\') } : {}); } catch (e){}
      if (!picked) return;
      dir = norm(picked); seen = {};
      try { localStorage.setItem(K_DIR, dir); } catch (e){}
      saveSeen();
      await startWatcher();
      updateUi();
      dToast(dTr('Obserwuję folder: ') + dir.replace(/\//g, '\\'));
      scan();
    }
    async function disable(){
      await stopWatcher();
      dir = ''; seen = {};
      try { localStorage.removeItem(K_DIR); localStorage.removeItem(K_SEEN); } catch (e){}
      updateUi();
      dToast(dTr('Obserwowanie folderu wyłączone'));
    }
    function updateUi(status){
      const lab = document.getElementById('smWatchPath');
      if (lab){
        lab.textContent = '\u200E' + (status || (dir ? dir.replace(/\//g, '\\') : dTr('nie wybrano'))) + '\u200E'; // LRM: kierunek rtl tylko do ucinania początku
        lab.title = dir ? dir.replace(/\//g, '\\') : '';
      }
      const b = document.getElementById('smWatchBtn'); if (b) b.textContent = dTr(dir ? 'Zmień folder…' : 'Wybierz folder…');
      const x = document.getElementById('smWatchOff'); if (x) x.hidden = !dir;
    }
    onReadyDom(function (){
      loadPrefs();
      const b = document.getElementById('smWatchBtn'); if (b) b.addEventListener('click', choose);
      const x = document.getElementById('smWatchOff'); if (x) x.addEventListener('click', disable);
      try { Neutralino.events.on('watchFile', onWatch); } catch (e){}
      document.addEventListener('pulsar:lang', function (){ updateUi(); });
      updateUi();
      if (dir){ startWatcher(); setTimeout(scan, 2500); } // po wczytaniu biblioteki z IndexedDB
    });
    return { choose: choose, disable: disable, scan: scan, dir: function (){ return dir; }, seen: function (){ return seen; } };
  })();

  /* ---- patch fetch: adresy mostka → desktop ---- */
  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch){
    window.fetch = function (input, init){
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const x = isBridgeUrl(url);
      if (!x) return origFetch(input, init);
      return ready.then(() => handleEndpoint(x)).catch(function (e){
        return jsonResponse({ ok: false, error: String((e && e.message) || e) }, 500);
      });
    };
  }

  /* ---- patch media src: <audio src="http://127.0.0.1:PORT/audio?id=.."> → blob URL ---- */
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (desc && desc.set){
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set(v){
          const x = (typeof v === 'string') ? isBridgeUrl(v) : null;
          if (!x || (x.pathname !== '/audio' && x.pathname !== '/mp3')){
            desc.set.call(this, v);
            return;
          }
          const el = this;
          ready.then(() => handleEndpoint(x)).then((resp) => {
            if (!resp || !resp.ok) throw new Error('stream failed');
            return resp.blob();
          }).then((blob) => {
            desc.set.call(el, URL.createObjectURL(blob));
          }).catch(() => {
            try { el.dispatchEvent(new Event('error')); } catch (e){}
          });
        },
        get: desc.get
      });
    }
  } catch (e){}

  /* ---- fullscreen: webview robi fullscreen tylko wewnątrz okna → przenieś na poziom ekranu ---- */
  try {
    if (Neutralino.window && Neutralino.window.setFullScreen &&
        typeof document !== 'undefined' && typeof Element !== 'undefined' && typeof Document !== 'undefined'){
      var winFsOn = false;
      var winFsSaved = null; // geometria okna sprzed fullscreena — cache'owana NA BIEŻĄCO
      // KLUCZOWE: nie odpytujemy okna w momencie wejścia w fullscreen (getSize zdąży zwrócić
      // wymiary pełnoekranowe → „przywrócenie" odtwarzałoby fullscreen i okno lądowało pod paskiem).
      // Zamiast tego zapisujemy geometrię ciągle, dopóki NIE jesteśmy w fullscreen.
      var winFsGuard = 0;    // do tej chwili (ms) nie zapisujemy geometrii — okno jest w trakcie wychodzenia z fullscreena
      var saveWinGeo = function (){
        if (winFsOn || Date.now() < winFsGuard) return;
        Promise.all([
          Neutralino.window.getSize ? Neutralino.window.getSize() : Promise.resolve(null),
          Neutralino.window.getPosition ? Neutralino.window.getPosition().catch(function (){ return null; }) : Promise.resolve(null),
          Neutralino.window.isMaximized ? Neutralino.window.isMaximized().catch(function (){ return false; }) : Promise.resolve(false)
        ]).then(function (r){
          // odpowiedź mogła przyjść już po wejściu w fullscreen / w trakcie wychodzenia → odrzuć
          if (winFsOn || Date.now() < winFsGuard) return;
          var size = r[0], pos = r[1], maximized = !!r[2];
          if (size && size.width > 100 && size.height > 100){
            winFsSaved = { width: size.width, height: size.height, x: pos ? pos.x : null, y: pos ? pos.y : null, maximized: maximized };
          }
        }).catch(function (){});
      };
      try { window.addEventListener('resize', function (){ setTimeout(saveWinGeo, 80); }); } catch (e){}
      setTimeout(saveWinGeo, 300);
      setTimeout(saveWinGeo, 1500);
      var fsSleep = function (ms){ return new Promise(function (r){ setTimeout(r, ms); }); };
      var fsSafe = function (fn){ try { return Promise.resolve(fn()).catch(function (){ return null; }); } catch (e){ return Promise.resolve(null); } };
      // obszar roboczy monitora (bez paska zadań) w pikselach fizycznych — tak jak getSize/getPosition Neutralino
      var workArea = function (){
        try {
          var d = window.devicePixelRatio || 1, sc = window.screen;
          var l = (typeof sc.availLeft === 'number' ? sc.availLeft : 0), t = (typeof sc.availTop === 'number' ? sc.availTop : 0);
          if (!sc.availWidth || !sc.availHeight) return null;
          return { x: Math.round(l * d), y: Math.round(t * d), w: Math.round(sc.availWidth * d), h: Math.round(sc.availHeight * d) };
        } catch (e){ return null; }
      };
      // dopasuj okno do obszaru roboczego, jeśli wystaje (np. dół pod paskiem zadań)
      var fitToWorkArea = async function (){
        var wa = workArea(); if (!wa) return;
        var W = Neutralino.window;
        if (await fsSafe(function (){ return W.isMaximized(); })) return;
        var sz = await fsSafe(function (){ return W.getSize(); });
        var ps = await fsSafe(function (){ return W.getPosition(); });
        if (!sz || !ps) return;
        var B = Math.round(8 * (window.devicePixelRatio || 1)); // niewidoczna ramka Windows 10/11 (~7–8 px) — to nie jest „wystawanie”
        var w = Math.min(sz.width, wa.w + 2 * B), h = Math.min(sz.height, wa.h + B);
        var x = Math.min(Math.max(ps.x, wa.x - B), wa.x + wa.w + B - w);
        var y = Math.min(Math.max(ps.y, wa.y), wa.y + wa.h + B - h);
        if (w !== sz.width || h !== sz.height) await fsSafe(function (){ return W.setSize({ width: w, height: h }); });
        if (x !== ps.x || y !== ps.y) await fsSafe(function (){ return W.move(x, y); });
      };
      // Kolejka operacji na oknie — wejście/wyjście z fullscreena nigdy się nie przeplatają
      var fsChain = Promise.resolve();
      var fsQueue = function (fn){ fsChain = fsChain.then(fn, fn).catch(function (){}); return fsChain; };
      var winFsWasMax = false;
      var fsEnter = async function (){
        var W = Neutralino.window;
        var sv = winFsSaved;
        var isMax = !!(await fsSafe(function (){ return W.isMaximized(); }));
        winFsWasMax = isMax || !!(sv && sv.maximized);
        // KLUCZOWE: Neutralino (Windows) robi fullscreen przez podmianę stylu okna. Gdy okno jest zmaksymalizowane,
        // po wyjściu flaga WS_MAXIMIZE wraca „ręcznie” i Windows gubi stan (okno pod paskiem albo odczepione).
        // Dlatego najpierw zwykłe „przywróć” Windows — Neutralino dostaje czyste, niezmaksymalizowane okno.
        if (isMax){ await fsSafe(function (){ return W.unmaximize(); }); await fsSleep(30); }
        if (!winFsOn) return; // użytkownik zdążył już wyjść
        await fsSafe(function (){ return W.setFullScreen(); });
      };
      var fsExit = async function (sv){
        var W = Neutralino.window;
        await fsSafe(function (){ return W.exitFullScreen(); }); // przywraca zwykłe okno (sprzed fullscreena)
        await fsSleep(80);
        try {
          if (winFsWasMax){
            await fsSafe(function (){ return W.maximize(); });     // standardowa maksymalizacja → obszar roboczy nad paskiem
          } else {
            if (sv){
              await fsSafe(function (){ return W.setSize({ width: sv.width, height: sv.height }); });
              if (sv.x != null && sv.y != null) await fsSafe(function (){ return W.move(sv.x, sv.y); });
            }
            await fitToWorkArea();
          }
          // kontrola wyniku (do 3 razy) — gdyby Windows/WebView2 jeszcze coś przestawił
          for (var i = 0; i < 3 && !winFsOn; i++){
            await fsSleep(150 + i * 200);
            if (winFsOn) break;
            if (winFsWasMax){
              if (await fsSafe(function (){ return W.isMaximized(); })) break;
              await fsSafe(function (){ return W.maximize(); });
            } else { await fitToWorkArea(); }
          }
        } catch (e){}
        winFsGuard = 0;
        if (!winFsOn) setTimeout(saveWinGeo, 50);
      };
      var winFs = function (on){
        if (winFsOn === on) return;
        winFsOn = on;
        if (on){ fsQueue(fsEnter); } // geometria jest już w pamięci (zapisywana na bieżąco)
        else {
          var sv = winFsSaved; // bierzemy geometrię TERAZ, zanim zdarzenia resize ją nadpiszą
          winFsGuard = Date.now() + 4000;
          fsQueue(function (){ return fsExit(sv); });
        }
      };
      try {
        var origReq = Element.prototype.requestFullscreen;
        if (origReq){
          Element.prototype.requestFullscreen = function (){
            // w trybie mini pełny ekran nie ma sensu (główny interfejs jest schowany)
            if (document.documentElement.classList.contains('nl-mini')) return Promise.resolve();
            winFs(true);
            try { return origReq.call(this).catch(function (){}); } catch (e){ return Promise.resolve(); }
          };
        }
        var origExit = Document.prototype.exitFullscreen;
        if (origExit){
          Document.prototype.exitFullscreen = function (){
            winFs(false);
            try { return origExit.call(this).catch(function (){}); } catch (e){ return Promise.resolve(); }
          };
        }
      } catch (e){}
      // gdy webview sam wyjdzie z fullscreen (np. Esc) → zdejmij też z okna
      try {
        document.addEventListener('fullscreenchange', function (){
          if (!document.fullscreenElement) winFs(false);
        });
      } catch (e){}
    }
  } catch (e){}

  /* ================= Integracja z Windows =================
   * - ikona w zasobniku z menu (teraz gra, odtwórz/pauza, poprzedni/następny, pokaż/ukryj, tryb mini,
   *   zawsze na wierzchu, zamykanie do zasobnika, zakończ)
   * - ✕ zamyka aplikację albo (opcjonalnie) chowa okno do zasobnika — muzyka gra dalej
   * - tryb mini: małe okno z okładką i przyciskami (domyślnie zawsze na wierzchu)
   * - „zawsze na wierzchu” dla zwykłego okna
   * - tytuł okna / paska zadań = bieżący utwór
   * - opcjonalne powiadomienie o nowym utworze, gdy okno jest schowane lub nieaktywne
   * Wymaga "exitProcessOnClose": false w neutralino.config.json (inaczej ✕ od razu kończy proces).
   */
  (function windowsIntegration(){
    const TRAY_ICON = '/resources/icons/trayIcon.png';
    const MINI = { width: 480, height: 190, minWidth: 320, minHeight: 130 };
    const NORMAL = { width: 1280, height: 840, minWidth: 760, minHeight: 560 };
    const K = {
      onTop: 'pulsarOnTop', miniOnTop: 'pulsarMiniOnTop', closeToTray: 'pulsarCloseToTray', notify: 'pulsarNotify',
      mini: 'pulsarMini', miniGeo: 'pulsarMiniGeo', normalGeo: 'pulsarNormalGeo', trayHint: 'pulsarTrayHintShown', trayPanel: 'pulsarTrayPanel'
    };
    const W = Neutralino.window;

    function getB(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch (e){ return d; } }
    function setB(k, v){ try { localStorage.setItem(k, v ? '1' : '0'); } catch (e){} }
    function getJ(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e){ return null; } }
    function setJ(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e){} }
    function host(){ return window.__pulsarHost || null; }
    function tr(s){ const h = host(); try { return h && h.t ? h.t(s) : s; } catch (e){ return s; } }
    function toast(s){ const h = host(); try { if (h && h.toast) h.toast(s); } catch (e){} }
    function safe(fn){ try { return Promise.resolve(fn()).catch(function (){ return null; }); } catch (e){ return Promise.resolve(null); } }
    function sleep(ms){ return new Promise(function (r){ setTimeout(r, ms); }); }
    function onDom(fn){ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true }); else fn(); }
    function clip(s, n){ s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function menuText(s){ return String(s).replace(/&/g, '&&'); } // w menu Windows „&” to mnemonik

    let started = false, trayOk = false, hidden = false, mini = false, focused = true, quitting = false, miniBusy = false;
    let onTop = getB(K.onTop, false), miniOnTop = getB(K.miniOnTop, true);
    let baseTitle = 'Pulsar', lastTitle = '', lastTrayJson = '', lastTrackKey = null, pendingNotify = false, refreshTimer = 0;

    function effectiveOnTop(){ return mini ? miniOnTop : onTop; }
    function applyOnTop(){ return safe(function (){ return W.setAlwaysOnTop(effectiveOnTop()); }); }

    /* ---- tytuł okna + zasobnik + powiadomienia (z opóźnieniem, żeby zgrupować zdarzenia) ---- */
    function scheduleRefresh(){
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 120);
    }
    function nowPlaying(){
      const h = host();
      try { return h && h.nowPlaying ? h.nowPlaying() : null; } catch (e){ return null; }
    }
    function refresh(){
      const np = nowPlaying();
      // tytuł okna (widoczny też po najechaniu na ikonę na pasku zadań)
      let title = baseTitle;
      if (np && np.hasTrack && np.title) title = (np.playing ? '▶ ' : '') + np.title + (np.artist ? ' — ' + np.artist : '') + ' · Pulsar';
      if (title !== lastTitle){ lastTitle = title; safe(function (){ return W.setTitle(title); }); }
      // powiadomienie o nowym utworze
      const key = np && np.hasTrack ? (np.title + '\u0000' + np.artist) : '';
      if (key !== lastTrackKey){
        const first = lastTrackKey === null;
        lastTrackKey = key;
        pendingNotify = !first && !!key;
      }
      if (pendingNotify && np && np.playing){
        pendingNotify = false;
        if (getB(K.notify, false) && trayOk && (hidden || !focused)){
          safe(function (){ return Neutralino.os.showNotification(clip(np.title, 60), clip(np.artist || 'Pulsar', 80), 'INFO'); });
        }
      }
      buildTray(np);
    }
    function buildTray(np){
      if (!started) return;
      if (helperActive()){ if (helper.ready) sendHelperState(np); return; } // własny panel zamiast menu Win32
      const can = !!(np && np.hasTracks);
      const label = np && np.hasTrack && np.title ? '♪  ' + clip(np.title + (np.artist ? ' — ' + np.artist : ''), 60) : tr('Nic nie gra');
      const items = [
        { id: 'np', text: menuText(label), isDisabled: true },
        { text: '-' },
        { id: 'toggle', text: menuText(tr(np && np.playing ? 'Pauza' : 'Odtwórz')), isDisabled: !can },
        { id: 'prev', text: menuText(tr('Poprzedni')), isDisabled: !can },
        { id: 'next', text: menuText(tr('Następny')), isDisabled: !can },
        { text: '-' },
        { id: 'show', text: menuText(tr(hidden ? 'Pokaż okno' : 'Ukryj okno')) },
        { id: 'mini', text: menuText(tr('Tryb mini')), isChecked: mini },
        { id: 'ontop', text: menuText(tr('Zawsze na wierzchu')), isChecked: effectiveOnTop() },
        { id: 'closetray', text: menuText(tr('Zamykaj do zasobnika')), isChecked: getB(K.closeToTray, false) },
        { text: '-' },
        { id: 'quit', text: menuText(tr('Zakończ')) }
      ];
      const json = JSON.stringify(items);
      if (json === lastTrayJson && trayOk) return;
      lastTrayJson = json;
      safe(function (){ return Neutralino.os.setTray({ icon: TRAY_ICON, menuItems: items }); }).then(function (r){
        // setTray zwraca obiekt przy sukcesie; bez działającej ikony nie wolno chować okna (nie byłoby jak wrócić)
        if (r !== null) trayOk = true; else if (!trayOk) lastTrayJson = '';
      });
    }

    /* ---- własny panel zasobnika (Windows) ----
     * Neutralino ma w zasobniku tylko surowe menu Win32 (bez stylu i bez zdarzenia kliknięcia ikony), więc ikonę
     * i panel w stylu Pulsara pokazuje mały pomocnik: tray/pulsar-tray.ps1 + PulsarTray.cs (WinForms, Windows PowerShell).
     * Rozmowa przez stdin/stdout procesu (os.spawnProcess) — bez sieci. Gdy pomocnik nie wystartuje (np. zablokowany
     * PowerShell) albo padnie, wracamy do zwykłego menu Neutralino. Wyłączane w Ustawienia → Okno. */
    const TRAY_DIR = joinPath(APP_DIR, 'tray');
    const helper = { proc: null, ready: false, failed: false, buf: '', last: '', coverUrl: null, coverPath: '', coverKey: '', coverN: 0, timer: 0 };
    function isWindows(){ return (typeof NL_OS === 'string' && NL_OS === 'Windows') || !!window.__pulsarTrayForce; }
    function helperWanted(){ return isWindows() && getB(K.trayPanel, true); }
    function helperActive(){ return helperWanted() && !helper.failed; }
    function wpath(p){ return String(p).replace(/\//g, '\\'); }
    function helperWrite(line){
      if (!helper.proc) return Promise.resolve(null);
      return safe(function (){ return Neutralino.os.updateSpawnedProcess(helper.proc.id, 'stdIn', line + '\n'); });
    }
    async function startHelper(){
      if (!helperWanted() || helper.proc) return;
      try {
        try { await Neutralino.filesystem.createDirectory(TRAY_DIR); } catch (e){}
        const files = [['PulsarTray.cs', '/tray/PulsarTray.cs'], ['pulsar-tray.ps1', '/tray/pulsar-tray.ps1']];
        for (const f of files){
          const r = await fetch(f[1], { cache: 'no-store' });
          if (!r.ok) throw new Error(f[1] + ' ' + r.status);
          await Neutralino.filesystem.writeFile(joinPath(TRAY_DIR, f[0]), await r.text());
        }
        try { const ic = await fetch('/icons/trayIcon.png'); if (ic.ok) await Neutralino.filesystem.writeBinaryFile(joinPath(TRAY_DIR, 'tray-icon.png'), await ic.arrayBuffer()); } catch (e){}
        const dir = wpath(TRAY_DIR);
        const cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -InputFormat None -WindowStyle Hidden -File "' + dir + '\\pulsar-tray.ps1" -Dir "' + dir + '" -ParentPid ' + (Number(window.NL_PID) || 0);
        helper.proc = await Neutralino.os.spawnProcess(cmd, { cwd: dir });
        if (!helper.proc || helper.proc.id == null) throw new Error('spawn');
        // pierwsza kompilacja C# trwa kilka sekund; potem DLL jest zapamiętany
        helper.timer = setTimeout(function (){ if (!helper.ready) helperFail('timeout'); }, 25000);
      } catch (e){ helperFail(e && e.message); }
    }
    function helperFail(reason){
      if (helper.failed) return;
      helper.failed = true; helper.ready = false;
      clearTimeout(helper.timer);
      try { console.warn('Pulsar: panel zasobnika niedostępny (' + (reason || '?') + ') — zwykłe menu'); } catch (e){}
      const p = helper.proc; helper.proc = null;
      if (p) safe(function (){ return Neutralino.os.updateSpawnedProcess(p.id, 'exit'); });
      lastTrayJson = ''; trayOk = false;
      scheduleRefresh(); // → natywne menu Neutralino
    }
    function onHelperLine(line){
      line = String(line).replace(/\r$/, '');
      if (!line) return;
      if (line === 'ready'){
        helper.ready = true; clearTimeout(helper.timer); trayOk = true; helper.last = '';
        scheduleRefresh();
      } else if (line.indexOf('cmd:') === 0){
        onTrayClick({ detail: { id: line.slice(4) } });
      } else if (line === 'panel:open'){
        helper.last = ''; refresh(); // świeża pozycja utworu
      } else if (line.indexOf('error:') === 0){
        helperFail(line.slice(6));
      }
    }
    function onHelperEvent(evt){
      const d = evt && evt.detail;
      if (!d || !helper.proc || d.id !== helper.proc.id) return;
      if (d.action === 'stdOut'){
        helper.buf += String(d.data || '');
        let i;
        while ((i = helper.buf.indexOf('\n')) >= 0){ const l = helper.buf.slice(0, i); helper.buf = helper.buf.slice(i + 1); onHelperLine(l); }
      } else if (d.action === 'exit'){
        helper.proc = null;
        if (!quitting) helperFail('exit ' + d.data);
      }
    }
    function coverToFile(url){
      // okładka dla panelu: mały JPEG w folderze tray (na zmianę 2 nazwy — pomocnik nie czyta pliku w trakcie zapisu)
      return new Promise(function (resolve){
        const img = new Image();
        img.onload = function (){
          try {
            const n = 144, c = document.createElement('canvas'); c.width = n; c.height = n;
            const g = c.getContext('2d');
            const sc = Math.max(n / img.naturalWidth, n / img.naturalHeight);
            const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
            g.drawImage(img, (n - w) / 2, (n - h) / 2, w, h);
            c.toBlob(function (b){
              if (!b){ resolve(''); return; }
              b.arrayBuffer().then(function (buf){
                helper.coverN = (helper.coverN + 1) % 2;
                const path = joinPath(TRAY_DIR, 'cover-' + helper.coverN + '.jpg');
                return Neutralino.filesystem.writeBinaryFile(path, buf).then(function (){ resolve(wpath(path)); });
              }).catch(function (){ resolve(''); });
            }, 'image/jpeg', 0.88);
          } catch (e){ resolve(''); } // obraz z innej domeny bez CORS — panel pokaże zastępczą okładkę
        };
        img.onerror = function (){ resolve(''); };
        img.src = url;
      });
    }
    function sendHelperState(np){
      const cov = (np && np.hasTrack && np.cover) || '';
      if (cov !== helper.coverUrl){
        helper.coverUrl = cov;
        if (!cov){ helper.coverPath = ''; helper.coverKey = ''; }
        else coverToFile(cov).then(function (p){
          if (helper.coverUrl !== cov) return;
          helper.coverPath = p; helper.coverKey = p ? String(Date.now()) : '';
          helper.last = ''; scheduleRefresh();
        });
      }
      const f = {
        title: np && np.hasTrack ? (np.title || '') : '',
        artist: np && np.hasTrack ? (np.artist || '') : '',
        playing: np && np.playing ? 1 : 0, hasTracks: np && np.hasTracks ? 1 : 0,
        hidden: hidden ? 1 : 0, mini: mini ? 1 : 0, onTop: effectiveOnTop() ? 1 : 0, closeToTray: getB(K.closeToTray, false) ? 1 : 0,
        pos: np && np.pos ? (+np.pos).toFixed(2) : 0, dur: np && np.dur ? (+np.dur).toFixed(2) : 0,
        accent: (np && np.accent) || '', cover: helper.coverPath, coverKey: helper.coverKey,
        l_nothing: tr('Nic nie gra'), l_show: tr('Pokaż okno'), l_hide: tr('Ukryj okno'), l_mini: tr('Tryb mini'),
        l_ontop: tr('Zawsze na wierzchu'), l_closetray: tr('Zamykaj do zasobnika'), l_quit: tr('Zakończ'),
        l_play: tr('Odtwórz'), l_pause: tr('Pauza'), l_prev: tr('Poprzedni'), l_next: tr('Następny')
      };
      const line = 'state|' + Object.keys(f).map(function (k){ return k + '=' + String(f[k]).replace(/[\r\n\x1f]/g, ' '); }).join('\x1f');
      if (line === helper.last) return;
      helper.last = line;
      helperWrite(line);
    }
    function setTrayPanel(on){
      setB(K.trayPanel, !!on);
      if (!isWindows()) return;
      if (on){
        if (!helper.proc){ helper.failed = false; helper.ready = false; startHelper(); }
      } else {
        const p = helper.proc; helper.proc = null; helper.ready = false; helper.failed = true;
        if (p){ Neutralino.os.updateSpawnedProcess(p.id, 'stdIn', 'quit\n').catch(function (){}); }
        lastTrayJson = ''; trayOk = false; scheduleRefresh();
      }
      toast(tr('Zmiana wyglądu zasobnika zadziała w pełni po ponownym uruchomieniu Pulsara'));
    }

    /* ---- pokaż / ukryj / zakończ ---- */
    function hideWindow(){
      if (!trayOk){ quit(); return; }
      hidden = true;
      safe(function (){ return W.hide(); });
      if (!getB(K.trayHint, false)){
        setB(K.trayHint, true);
        safe(function (){ return Neutralino.os.showNotification(tr('Pulsar działa w tle'), tr('Muzyka gra dalej. Okno przywrócisz z menu ikony w zasobniku (Pokaż okno).'), 'INFO'); });
      }
      scheduleRefresh();
    }
    function showWindow(){
      hidden = false;
      safe(function (){ return W.show(); })
        .then(function (){ return safe(function (){ return W.unminimize(); }); })
        .then(function (){ return safe(function (){ return W.focus(); }); });
      scheduleRefresh();
    }
    function quit(){
      if (quitting) return;
      quitting = true;
      try { const h = host(); if (h && h.saveState) h.saveState(); } catch (e){}
      const exit = function (){ try { Neutralino.app.exit(); } catch (e){} };
      if (helper.proc){ Promise.race([helperWrite('quit'), sleep(400)]).then(exit, exit); }
      else exit();
    }

    /* ---- zawsze na wierzchu ---- */
    function setOnTop(v, silent){
      if (mini){ miniOnTop = !!v; setB(K.miniOnTop, miniOnTop); }
      else { onTop = !!v; setB(K.onTop, onTop); }
      applyOnTop();
      if (!silent) toast(tr(effectiveOnTop() ? 'Zawsze na wierzchu: wł.' : 'Zawsze na wierzchu: wył.'));
      syncSettingsUI(); scheduleRefresh();
      try { const h = host(); if (h && h.miniSync) h.miniSync(); } catch (e){}
    }
    function toggleOnTop(){ setOnTop(!effectiveOnTop()); }

    /* ---- tryb mini ---- */
    async function readGeo(){
      const r = await Promise.all([
        safe(function (){ return W.getSize(); }),
        safe(function (){ return W.getPosition(); }),
        safe(function (){ return W.isMaximized(); })
      ]);
      const size = r[0], pos = r[1];
      if (!size || !(size.width > 50)) return null;
      return { width: size.width, height: size.height, x: pos ? pos.x : null, y: pos ? pos.y : null, maximized: !!r[2] };
    }
    async function setMini(on, opts){
      opts = opts || {};
      if (typeof on !== 'boolean') on = !mini;
      if (on === mini || miniBusy) return;
      miniBusy = true;
      try {
        if (on){
          if (document.fullscreenElement){ try { await document.exitFullscreen(); } catch (e){} await sleep(350); }
          if (!opts.startup){
            const g = await readGeo();
            if (g && g.width >= NORMAL.minWidth - 10) setJ(K.normalGeo, g);
            if (g && g.maximized) await safe(function (){ return W.unmaximize(); });
          }
          mini = true; setB(K.mini, true);
          document.documentElement.classList.add('nl-mini');
          const mg = getJ(K.miniGeo) || {};
          await safe(function (){ return W.setSize({ width: mg.width || MINI.width, height: mg.height || MINI.height, minWidth: MINI.minWidth, minHeight: MINI.minHeight }); });
          if (mg.x != null && mg.y != null) await safe(function (){ return W.move(mg.x, mg.y); });
        } else {
          const g = await readGeo();
          if (g) setJ(K.miniGeo, { width: g.width, height: g.height, x: g.x, y: g.y });
          mini = false; setB(K.mini, false);
          document.documentElement.classList.remove('nl-mini');
          const n = getJ(K.normalGeo) || {};
          await safe(function (){ return W.setSize({
            width: Math.max(NORMAL.minWidth, n.width || NORMAL.width), height: Math.max(NORMAL.minHeight, n.height || NORMAL.height),
            minWidth: NORMAL.minWidth, minHeight: NORMAL.minHeight
          }); });
          if (n.x != null && n.y != null) await safe(function (){ return W.move(n.x, n.y); });
          else await safe(function (){ return W.center(); });
          if (n.maximized) await safe(function (){ return W.maximize(); });
        }
        await applyOnTop();
      } finally {
        miniBusy = false;
      }
      try { document.dispatchEvent(new CustomEvent('pulsar:mini', { detail: { on: mini } })); } catch (e){}
      try { window.dispatchEvent(new Event('resize')); } catch (e){} // przelicz płótna/wizualizacje
      syncSettingsUI(); scheduleRefresh();
    }

    /* ---- menu ustawień (sekcja „Windows” w index.html) ---- */
    function syncSettingsUI(){
      const a = document.getElementById('smOnTop'); if (a) a.checked = onTop;
      const b = document.getElementById('smCloseToTray'); if (b) b.checked = getB(K.closeToTray, false);
      const c = document.getElementById('smNotify'); if (c) c.checked = getB(K.notify, false);
      const tp = document.getElementById('smTrayPanel'); if (tp) tp.checked = getB(K.trayPanel, true);
    }
    function wireSettingsUI(){
      const miniBtn = document.getElementById('smMiniBtn');
      if (miniBtn) miniBtn.addEventListener('click', function (){
        const menu = document.getElementById('settingsMenu'); if (menu) menu.hidden = true;
        setMini(true);
      });
      const a = document.getElementById('smOnTop');
      if (a) a.addEventListener('change', function (){ onTop = a.checked; setB(K.onTop, onTop); if (!mini) applyOnTop(); toast(tr(onTop ? 'Zawsze na wierzchu: wł.' : 'Zawsze na wierzchu: wył.')); scheduleRefresh(); });
      const b = document.getElementById('smCloseToTray');
      if (b) b.addEventListener('change', function (){ setB(K.closeToTray, b.checked); scheduleRefresh(); });
      const c = document.getElementById('smNotify');
      if (c) c.addEventListener('change', function (){ setB(K.notify, c.checked); });
      const tp = document.getElementById('smTrayPanel');
      if (tp) tp.addEventListener('change', function (){ setTrayPanel(tp.checked); });
      syncSettingsUI();
    }

    /* ---- zdarzenia natywne ---- */
    function onTrayClick(evt){
      const id = evt && evt.detail && evt.detail.id;
      const h = host();
      switch (id){
        case 'toggle': if (h) h.toggle(); break;
        case 'prev': if (h) h.prev(); break;
        case 'next': if (h) h.next(); break;
        case 'show': if (hidden) showWindow(); else hideWindow(); break;
        case 'mini': if (hidden) showWindow(); setMini(!mini); break;
        case 'ontop': toggleOnTop(); break;
        case 'closetray': setB(K.closeToTray, !getB(K.closeToTray, false)); syncSettingsUI(); scheduleRefresh(); break;
        case 'quit': quit(); break;
      }
      setTimeout(scheduleRefresh, 250);
    }

    // Rejestrujemy od razu (przed połączeniem), żeby ✕ zawsze miał obsługę.
    try {
      Neutralino.events.on('windowClose', function (){
        if (!quitting && getB(K.closeToTray, false) && trayOk) hideWindow();
        else quit();
      });
      Neutralino.events.on('trayMenuItemClicked', onTrayClick);
      Neutralino.events.on('spawnedProcess', onHelperEvent);
      Neutralino.events.on('windowFocus', function (){ focused = true; });
      Neutralino.events.on('windowBlur', function (){ focused = false; });
      Neutralino.events.on('ready', function (){
        if (started) return;
        onDom(async function (){
          started = true;
          document.documentElement.classList.add('nl-desktop');
          window.__pulsarDesktop = {
            setMini: setMini,
            isMini: function (){ return mini; },
            toggleOnTop: toggleOnTop,
            isOnTop: effectiveOnTop,
            show: showWindow,
            hide: hideWindow,
            quit: quit,
            trayHelper: function (){ return { ready: helper.ready, failed: helper.failed, running: !!helper.proc, last: helper.last }; }
          };
          const bt = await safe(function (){ return W.getTitle(); });
          if (bt) baseTitle = bt;
          wireSettingsUI();
          document.addEventListener('pulsar:state', scheduleRefresh);
          document.addEventListener('pulsar:lang', function (){ lastTrayJson = ''; scheduleRefresh(); });
          await applyOnTop();
          if (getB(K.mini, false)) await setMini(true, { startup: true });
          if (helperWanted()) startHelper();
          refresh();
        });
      });
    } catch (e){}
  })();

  /* ================= OBS: dźwięk + overlay przez źródło „Przeglądarka” =================
   * Dlaczego: WebView2 odtwarza dźwięk w osobnym procesie msedgewebview2.exe, poza drzewem procesu pulsar.exe,
   * więc „Przechwytywanie dźwięku aplikacji” w OBS nic nie słyszy (obsproject/obs-studio#9838).
   * Jak: AudioWorklet odczepia gotowy sygnał (po EQ/efektach) → Web Worker → app.broadcast przez lokalny
   * serwer Neutralino (tylko 127.0.0.1) → strona obs/pulsar-obs.html w OBS odtwarza go, a OBS przechwytuje
   * dźwięk swojego źródła przeglądarki natywnie. PCM 16-bit bez kompresji, bufor ~0,12 s.
   * Strona OBS dostaje tylko „connect token” (odbiór zdarzeń) — bez tokenu dostępu nie wywoła API systemowego.
   */
  (function obsBridge(){
    const PREF = 'pulsarObs';
    const OBS_DIR = joinPath(APP_DIR, 'obs');
    const FILES = { overlay: 'pulsar-obs.html', audio: 'pulsar-obs-audio.html', conn: 'connection.js' };
    const FRAMES = 2048; // ~43 ms przy 48 kHz

    function getOn(){ try { return localStorage.getItem(PREF) === '1'; } catch (e){ return false; } }
    /* motyw overlayu: style card|bar|cover|minimal|vinyl|neon|pill, pos bl|br|tl|tr|bc, accent 'auto' | '#rrggbb', viz,
     * scale 50–200 %, bg (krycie tła) 0–100 %, margin px, font sans|condensed|serif|mono, anim slide|fade|zoom|none,
     * autohide s (0 = nie chowaj), cover/progress/label (pokazuj), art (rozmyta okładka w tle), marquee (przewijany tytuł),
     * text 'auto' | '#rrggbb', tsize 50–200 %, radius -1 (z motywu) | px, cshape auto|square|rounded|circle, vizStyle bars|wave|mirror */
    const THEME_KEY = 'pulsarObsTheme';
    const THEME_DEF = { style: 'card', pos: 'bl', accent: 'auto', viz: true, scale: 100, bg: 100, margin: 24, font: 'sans', anim: 'slide',
      autohide: 0, cover: true, progress: true, label: true, art: false, marquee: false,
      text: 'auto', tsize: 100, radius: -1, cshape: 'auto', vizStyle: 'bars' };
    function getTheme(){
      let t = null; try { t = JSON.parse(localStorage.getItem(THEME_KEY) || 'null'); } catch (e){}
      return Object.assign({}, THEME_DEF, (t && typeof t === 'object') ? t : {});
    }
    function setTheme(t){ try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch (e){} }
    function hexToRgb(h){
      const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return '';
      const n = parseInt(m[1], 16); return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
    }
    function themeWire(t){
      return { style: t.style, pos: t.pos, viz: t.viz !== false, accent: t.accent === 'auto' ? '' : hexToRgb(t.accent),
        scale: +t.scale || 100, bg: t.bg == null ? 100 : +t.bg, margin: t.margin == null ? 24 : +t.margin, font: t.font, anim: t.anim,
        autohide: +t.autohide || 0, cover: t.cover !== false, progress: t.progress !== false, label: t.label !== false, art: !!t.art, marquee: !!t.marquee,
        text: t.text && t.text !== 'auto' ? hexToRgb(t.text) : '', tsize: +t.tsize || 100, radius: t.radius == null ? -1 : +t.radius, cshape: t.cshape || 'auto', vizStyle: t.vizStyle || 'bars' };
    }
    function setOn(v){ try { localStorage.setItem(PREF, v ? '1' : '0'); } catch (e){} }
    function host(){ return window.__pulsarHost || null; }
    function tr(s){ const h = host(); try { return h && h.t ? h.t(s) : s; } catch (e){ return s; } }
    function toast(s){ const h = host(); try { if (h && h.toast) h.toast(s); } catch (e){} }
    function token(){ try { return window.NL_TOKEN || sessionStorage.getItem('NL_TOKEN') || ''; } catch (e){ return window.NL_TOKEN || ''; } }
    function port(){ return Number(window.NL_PORT || location.port || 0); }
    function winPath(p){ return String(p).replace(/\//g, '\\'); }

    let on = getOn(), started = false;
    let tap = null;            // { ctx, node, worklet, sink, worker }
    let workerOpen = false, clientCount = 0, obsClients = 0;
    let metaTimer = 0, lastCoverUrl = null, lastCoverId = '', lastCoverData = null, lastCoverSent = 0;
    let filesOk = null;

    /* ---- pliki dla OBS (w folderze aplikacji; connection.js nadpisywany przy każdym starcie — nowy token) ---- */
    async function writeFiles(){
      filesOk = null;
      try {
        try { await Neutralino.filesystem.createDirectory(OBS_DIR); } catch (e){}
        const conn = on
          ? 'window.PULSAR_OBS = ' + JSON.stringify({ port: port(), connectToken: (token().split('.')[1] || ''), app: 'Pulsar', ts: Date.now() }) + ';\n'
          : 'window.PULSAR_OBS = null; // połączenie z OBS wyłączone w Pulsarze\n';
        await Neutralino.filesystem.writeFile(joinPath(OBS_DIR, FILES.conn), conn);
        if (on){
          const r = await fetch('/obs/overlay.html', { cache: 'no-store' });
          if (!r.ok) throw new Error('overlay ' + r.status);
          const th = getTheme();
          const html = (await r.text()).replace(/data-style="[a-z]+" data-pos="[a-z]+" data-viz="[01]"/,
            'data-style="' + th.style + '" data-pos="' + th.pos + '" data-viz="' + (th.viz !== false ? '1' : '0') + '"')
            .replace('/*PULSAR_THEME*/null', JSON.stringify(themeWire(th)).replace(/</g, '\\u003c'));
          await Neutralino.filesystem.writeFile(joinPath(OBS_DIR, FILES.overlay), html);
          await Neutralino.filesystem.writeFile(joinPath(OBS_DIR, FILES.audio), html.replace('data-mode="overlay"', 'data-mode="audio"'));
        }
        filesOk = true;
      } catch (e){
        filesOk = false;
        if (on) toast(tr('Nie udało się zapisać plików dla OBS'));
      }
    }

    /* ---- odczep dźwięku: AudioWorklet → Worker → WebSocket (poza głównym wątkiem) ---- */
    const WORKLET_SRC = [
      "class PulsarObsTap extends AudioWorkletProcessor {",
      "  constructor(){ super(); this.F = " + FRAMES + "; this.b = new Float32Array(this.F * 2); this.n = 0; this.out = null;",
      "    this.port.onmessage = (e) => { if (e.data && e.data.port) this.out = e.data.port; }; }",
      "  process(inputs){",
      "    const i = inputs[0]; if (!i || !i.length || !this.out) return true;",
      "    const L = i[0], R = i[1] || i[0];",
      "    for (let k = 0; k < L.length; k++){",
      "      this.b[this.n * 2] = L[k]; this.b[this.n * 2 + 1] = R[k];",
      "      if (++this.n === this.F){ this.out.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(this.F * 2); this.n = 0; }",
      "    }",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('pulsar-obs-tap', PulsarObsTap);"
    ].join('\n');
    const WORKER_SRC = [
      "var ws = null, tok = '', port = 0, sr = 48000, seq = 0, silent = 0, stopped = false;",
      "onmessage = function (e){",
      "  var d = e.data || {};",
      "  if (d.type === 'init'){ tok = d.token; port = d.port; sr = d.sr || 48000; e.ports[0].onmessage = function (ev){ chunk(ev.data); }; connect(); }",
      "  else if (d.type === 'stop'){ stopped = true; try { ws && ws.close(); } catch (x){} close(); }",
      "};",
      "function connect(){",
      "  if (stopped) return;",
      "  try { ws = new WebSocket('ws://127.0.0.1:' + port + '/?connectToken=' + (tok.split('.')[1] || '')); } catch (x){ setTimeout(connect, 2000); return; }",
      "  ws.onopen = function (){ postMessage({ type: 'open' }); };",
      "  ws.onclose = function (){ postMessage({ type: 'close' }); ws = null; setTimeout(connect, 2000); };",
      "  ws.onmessage = function (){};",
      "}",
      "function b64(u8){ var s = '', C = 0x8000; for (var i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C)); return btoa(s); }",
      "function chunk(f){",
      "  if (!ws || ws.readyState !== 1) return;",
      "  var peak = 0, n = f.length, i;",
      "  for (i = 0; i < n; i += 4){ var a = f[i] < 0 ? -f[i] : f[i]; if (a > peak) peak = a; }",
      "  if (peak < 1e-5){ if (++silent > 12) return; } else silent = 0;", // ~0,5 s ciszy → przestań wysyłać (pauza)
      "  if (ws.bufferedAmount > 1048576) return;",                          // zator — lepiej zgubić paczkę niż rosnąć
      "  var pcm = new Int16Array(n);",
      "  for (i = 0; i < n; i++){ var v = f[i]; v = v > 1 ? 1 : (v < -1 ? -1 : v); pcm[i] = v < 0 ? v * 32768 : v * 32767; }",
      "  ws.send(JSON.stringify({ id: 'obs-' + seq, method: 'app.broadcast', accessToken: tok,",
      "    data: { event: 'pulsarObsAudio', data: { sr: sr, ch: 2, seq: seq++, pcm: b64(new Uint8Array(pcm.buffer)) } } }));",
      "}"
    ].join('\n');

    async function attach(){
      if (!on || tap) return;
      const h = host();
      const t = h && h.audioTap ? h.audioTap() : null;
      if (!t || !t.ctx || !t.node || !t.ctx.audioWorklet) return;
      const ctx = t.ctx;
      tap = { ctx: ctx, node: t.node, pending: true };
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        if (!on){ tap = null; return; }
        const worklet = new AudioWorkletNode(ctx, 'pulsar-obs-tap', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelCountInterpretation: 'speakers'
        });
        const sink = ctx.createGain(); sink.gain.value = 0; // węzeł musi być „ciągnięty” przez graf
        t.node.connect(worklet); worklet.connect(sink); sink.connect(ctx.destination);
        const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' })));
        const mc = new MessageChannel();
        worklet.port.postMessage({ port: mc.port1 }, [mc.port1]);
        worker.postMessage({ type: 'init', token: token(), port: port(), sr: ctx.sampleRate }, [mc.port2]);
        worker.onmessage = function (e){
          const d = e.data || {};
          if (d.type === 'open'){ workerOpen = true; recount(); }
          else if (d.type === 'close'){ workerOpen = false; recount(); }
        };
        tap = { ctx: ctx, node: t.node, worklet: worklet, sink: sink, worker: worker };
      } catch (e){
        tap = null;
        console.warn('OBS: nie udało się podłączyć odczepu dźwięku', e);
      }
    }
    function detach(){
      if (!tap) return;
      try { tap.node.disconnect(tap.worklet); } catch (e){}
      try { tap.worklet && tap.worklet.disconnect(); } catch (e){}
      try { tap.sink && tap.sink.disconnect(); } catch (e){}
      try { tap.worker && tap.worker.postMessage({ type: 'stop' }); } catch (e){}
      tap = null; workerOpen = false; recount();
    }

    /* ---- metadane + okładka ---- */
    function broadcast(ev, data){ try { return Neutralino.app.broadcast(ev, data).catch(function (){}); } catch (e){ return null; } }
    function coverToJpeg(url){
      return new Promise(function (resolve){
        const img = new Image();
        img.onload = function (){
          try {
            const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S;
            const g = c.getContext('2d');
            const s = Math.min(img.naturalWidth, img.naturalHeight) || 1;
            g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, S, S);
            resolve(c.toDataURL('image/jpeg', 0.85));
          } catch (e){ resolve(null); }
        };
        img.onerror = function (){ resolve(null); };
        img.src = url;
      });
    }
    async function sendMeta(){
      if (!on) return;
      const h = host();
      const np = h && h.nowPlaying ? h.nowPlaying() : null;
      if (!np) return;
      let lang = 'pl'; try { lang = h.lang(); } catch (e){}
      if (np.cover !== lastCoverUrl){
        lastCoverUrl = np.cover;
        lastCoverData = np.cover ? await coverToJpeg(np.cover) : null;
        lastCoverId = lastCoverData ? ('c' + Date.now().toString(36)) : '';
        lastCoverSent = 0;
      }
      broadcast('pulsarObsMeta', {
        title: np.title, artist: np.artist, playing: np.playing, hasTrack: np.hasTrack,
        pos: Math.round(np.pos * 100) / 100, dur: Math.round(np.dur * 100) / 100,
        accent: np.accent || '', lang: lang, coverId: lastCoverId, theme: themeWire(getTheme())
      });
      // okładkę wysyłamy przy zmianie i co 10 s (gdy źródło w OBS zostanie przeładowane)
      if (lastCoverId && Date.now() - lastCoverSent > 10000){
        lastCoverSent = Date.now();
        broadcast('pulsarObsCover', { id: lastCoverId, data: lastCoverData });
      }
    }
    function startMeta(){ stopMeta(); metaTimer = setInterval(sendMeta, 1000); sendMeta(); }
    function stopMeta(){ clearInterval(metaTimer); metaTimer = 0; }

    /* ---- licznik podłączonych źródeł OBS (klienci aplikacji poza oknem Pulsara i workerem) ---- */
    function recount(){
      obsClients = Math.max(0, clientCount - 1 - (workerOpen ? 1 : 0));
      updateUi();
    }

    /* ---- włącz / wyłącz ---- */
    async function setEnabled(v, silent){
      on = !!v; setOn(on);
      await writeFiles();
      if (on){ await attach(); startMeta(); }
      else { detach(); stopMeta(); }
      updateUi();
      if (!silent) toast(tr(on ? 'Połączenie z OBS: wł.' : 'Połączenie z OBS: wył.'));
    }

    /* ---- UI: ustawienia + okno z instrukcją ---- */
    function statusText(){
      if (!on) return tr('Wyłączone');
      if (obsClients > 0) return tr('Podłączone źródła OBS: ') + obsClients;
      return tr('Czekam na OBS…');
    }
    function updateUi(){
      const sw = document.getElementById('smObs'); if (sw) sw.checked = on;
      const btn = document.getElementById('smObsHelp');
      if (btn) btn.textContent = tr('Jak podłączyć OBS…') + (on ? ' (' + statusText() + ')' : '');
      const st = document.getElementById('obsStatusTxt');
      if (st) st.textContent = statusText();
      const dot = document.getElementById('obsStatusDot');
      if (dot) dot.className = 'obs-dot' + (on ? (obsClients > 0 ? ' on' : ' wait') : '');
      const tg = document.getElementById('obsModalToggle');
      if (tg) tg.textContent = tr(on ? 'Wyłącz nadawanie' : 'Włącz nadawanie');
    }
    function copy(text){
      const done = function (){ toast(tr('Skopiowano ścieżkę')); };
      try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e){ fallback(); }
      function fallback(){
        try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch (e){}
      }
    }
    function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function openHelp(){
      const h = host(); if (!h || !h.modal) return;
      const menu = document.getElementById('settingsMenu'); if (menu) menu.hidden = true;
      h.modal({
        title: tr('Pulsar w OBS'),
        buildBody: function (body){
          const box = el('div', 'obs-help');
          const st = el('div', 'obs-status');
          const dot = el('span', 'obs-dot'); dot.id = 'obsStatusDot';
          const stt = el('span', null, ''); stt.id = 'obsStatusTxt';
          st.appendChild(dot); st.appendChild(stt); box.appendChild(st);
          const act0 = el('div', 'obs-actions');
          const tg = el('button', null, ''); tg.type = 'button'; tg.id = 'obsModalToggle';
          tg.addEventListener('click', function (){ setEnabled(!on); });
          act0.appendChild(tg); box.appendChild(act0);

          box.appendChild(el('h4', null, tr('Dźwięk (i overlay)')));
          box.appendChild(el('p', null, tr('1. W OBS dodaj źródło „Przeglądarka” (Browser).')));
          box.appendChild(el('p', null, tr('2. Zaznacz „Plik lokalny” i wybierz jeden z plików:')));
          [[FILES.overlay, 'overlay z okładką, tytułem i wizualizacją + dźwięk'], [FILES.audio, 'sam dźwięk (bez obrazu)']].forEach(function (f){
            const fb = el('div', 'obs-file');
            fb.appendChild(el('code', null, winPath(joinPath(OBS_DIR, f[0]))));
            fb.appendChild(el('span', null, tr(f[1])));
            box.appendChild(fb);
          });
          const act = el('div', 'obs-actions');
          const b1 = el('button', null, tr('Kopiuj ścieżkę')); b1.type = 'button';
          b1.addEventListener('click', function (){ copy(winPath(joinPath(OBS_DIR, FILES.overlay))); });
          const b2 = el('button', null, tr('Otwórz folder')); b2.type = 'button';
          b2.addEventListener('click', function (){ try { Neutralino.os.execCommand('explorer "' + winPath(OBS_DIR) + '"', { background: true }); } catch (e){} });
          act.appendChild(b1); act.appendChild(b2); box.appendChild(act);
          box.appendChild(el('p', null, tr('3. Zaznacz „Steruj dźwiękiem przez OBS” (Control audio via OBS) — bez tego OBS nie złapie dźwięku.')));
          box.appendChild(el('p', null, tr('4. Dla overlayu ustaw rozmiar np. 800 × 200. Źródło samo połączy się ponownie po restarcie Pulsara.')));

          box.appendChild(buildThemeUi());
          box.appendChild(el('h4', null, tr('Obraz okna Pulsara')));
          box.appendChild(el('p', null, tr('Dodaj „Przechwytywanie okna”, wybierz Pulsar i ustaw metodę przechwytywania „Windows 10 (1903 i nowsze)” — inaczej obraz może być czarny.')));
          box.appendChild(el('p', 'obs-note', tr('Dźwięk w OBS jest ok. 0,15 s za obrazem okna. Dla idealnej synchronizacji dodaj do przechwytywania okna filtr „Opóźnienie renderowania” 150 ms.')));
          box.appendChild(el('p', 'obs-note', tr('„Przechwytywanie dźwięku aplikacji” nie zadziała z Pulsarem: dźwięk gra w procesie WebView2, którego OBS nie widzi. Dlatego jest to rozwiązanie.')));
          body.appendChild(box);
          updateUi();
        }
      });
    }
    /* ---- wygląd overlayu: wybór + podgląd na żywo (ten sam overlay.html w ramce) ---- */
    let previewFrame = null;
    function sendPreview(){
      if (!previewFrame || !previewFrame.contentWindow) return;
      const h = host(); const np = (h && h.nowPlaying) ? h.nowPlaying() : null;
      let lang = 'pl'; try { lang = h.lang(); } catch (e){}
      const title = (np && np.title) || tr('Tytuł utworu');
      const artist = (np && np.hasTrack) ? np.artist : tr('Wykonawca');
      const dur = (np && np.dur) || 215, pos = (np && np.hasTrack) ? np.pos : 83;
      const cover = (np && np.cover) || null;
      const send = function (data){
        try {
          previewFrame.contentWindow.postMessage({ pulsarObsPreview: { title: title, artist: artist, playing: !!(np && np.playing), hasTrack: true,
            pos: pos, dur: dur, accent: (np && np.accent) || '', lang: lang, coverId: data ? 'p' : '', theme: themeWire(getTheme()) }, cover: data }, '*');
        } catch (e){}
      };
      if (cover && cover.indexOf('blob:') === 0) coverToJpeg(cover).then(send, function (){ send(null); }); else send(cover);
    }
    function buildThemeUi(){
      const wrap = el('div', 'obs-theme');
      wrap.appendChild(el('h4', null, tr('Wygląd overlayu')));
      const th = getTheme();
      const grid = el('div', 'obs-theme-grid');
      const sel = function (label, key, opts){
        const l = el('label', 'obs-theme-field'); l.appendChild(el('span', null, tr(label)));
        const s = el('select', 'sm-select');
        opts.forEach(function (o){ const op = el('option', null, tr(o[1])); op.value = o[0]; s.appendChild(op); });
        s.value = th[key];
        s.addEventListener('change', function (){ const t = getTheme(); t[key] = s.value; setTheme(t); applyThemeNow(); });
        l.appendChild(s); grid.appendChild(l); return s;
      };
      sel('Styl', 'style', [['card', 'Karta'], ['bar', 'Pasek (cała szerokość)'], ['cover', 'Duża okładka'], ['minimal', 'Minimalny (sam tekst)'],
        ['vinyl', 'Winyl (obracająca się płyta)'], ['neon', 'Neon'], ['pill', 'Pastylka (mała)'],
        ['glass', 'Szkło (jasna tafla)'], ['terminal', 'Terminal (retro konsola)'], ['tv', 'Belka TV']]);
      sel('Pozycja', 'pos', [['bl', 'Lewy dół'], ['bc', 'Środek dół'], ['br', 'Prawy dół'], ['tl', 'Lewa góra'], ['tr', 'Prawa góra']]);
      const al = el('label', 'obs-theme-field'); al.appendChild(el('span', null, tr('Kolor akcentu')));
      const arow = el('span', 'obs-theme-acc');
      const as = el('select', 'sm-select');
      [['auto', 'Z okładki (automatycznie)'], ['custom', 'Własny']].forEach(function (o){ const op = el('option', null, tr(o[1])); op.value = o[0]; as.appendChild(op); });
      const col = el('input'); col.type = 'color'; col.value = th.accent !== 'auto' ? th.accent : '#a06bff';
      as.value = th.accent === 'auto' ? 'auto' : 'custom'; col.hidden = as.value === 'auto';
      const saveAcc = function (){ const t = getTheme(); t.accent = as.value === 'auto' ? 'auto' : col.value; setTheme(t); col.hidden = as.value === 'auto'; applyThemeNow(); };
      as.addEventListener('change', saveAcc); col.addEventListener('input', saveAcc);
      arow.appendChild(as); arow.appendChild(col); al.appendChild(arow); grid.appendChild(al);
      const vl = el('label', 'obs-theme-check');
      const vc = el('input'); vc.type = 'checkbox'; vc.checked = th.viz !== false;
      vc.addEventListener('change', function (){ const t = getTheme(); t.viz = vc.checked; setTheme(t); applyThemeNow(); });
      vl.appendChild(vc); vl.appendChild(el('span', null, tr('Wizualizacja (słupki)'))); grid.appendChild(vl);
      wrap.appendChild(grid);
      // --- więcej opcji ---
      const more = el('div', 'obs-theme-grid obs-theme-more');
      const range = function (label, key, min, max, step, unit){
        const l = el('label', 'obs-theme-field obs-theme-range');
        const cap = el('span'); const val = el('b');
        cap.appendChild(document.createTextNode(tr(label) + ' ')); cap.appendChild(val); l.appendChild(cap);
        const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = th[key];
        const show = function (){ val.textContent = r.value + unit; };
        r.addEventListener('input', function (){ show(); const t = getTheme(); t[key] = +r.value; setTheme(t); applyThemeNow(); });
        show(); l.appendChild(r); more.appendChild(l); return r;
      };
      range('Rozmiar', 'scale', 50, 200, 5, '%');
      range('Krycie tła', 'bg', 0, 100, 5, '%');
      range('Odstęp od krawędzi', 'margin', 0, 120, 2, ' px');
      range('Wielkość tytułu', 'tsize', 60, 160, 5, '%');
      const sel2 = function (label, key, opts){
        const l = el('label', 'obs-theme-field'); l.appendChild(el('span', null, tr(label)));
        const s = el('select', 'sm-select');
        opts.forEach(function (o){ const op = el('option', null, tr(o[1])); op.value = o[0]; s.appendChild(op); });
        s.value = String(th[key]);
        s.dataset.key = key;
        s.addEventListener('change', function (){ const t = getTheme(); t[key] = /^-?\d+$/.test(s.value) ? +s.value : s.value; setTheme(t); applyThemeNow(); });
        l.appendChild(s); more.appendChild(l); return s;
      };
      sel2('Czcionka', 'font', [['sans', 'Segoe UI (domyślna)'], ['condensed', 'Wąska (Bahnschrift)'], ['serif', 'Szeryfowa (Georgia)'], ['mono', 'Stała szerokość (Consolas)']]);
      sel2('Animacja', 'anim', [['slide', 'Wysunięcie'], ['fade', 'Przenikanie'], ['zoom', 'Powiększenie'], ['none', 'Bez animacji']]);
      sel2('Rogi', 'radius', [['-1', 'Jak w stylu'], ['0', 'Ostre'], ['6', 'Lekko zaokrąglone'], ['14', 'Zaokrąglone'], ['26', 'Mocno zaokrąglone'], ['999', 'Kapsułka']]);
      sel2('Kształt okładki', 'cshape', [['auto', 'Jak w stylu'], ['square', 'Kwadrat'], ['rounded', 'Zaokrąglona'], ['circle', 'Koło']]);
      sel2('Styl wizualizacji', 'vizStyle', [['bars', 'Słupki'], ['wave', 'Fala'], ['mirror', 'Lustro (od środka)']]);
      // kolor tekstu: automatyczny (z motywu) lub własny
      const tl = el('label', 'obs-theme-field'); tl.appendChild(el('span', null, tr('Kolor tekstu')));
      const trow = el('span', 'obs-theme-acc');
      const ts = el('select', 'sm-select'); ts.dataset.key = 'text';
      [['auto', 'Jak w stylu'], ['custom', 'Własny']].forEach(function (o){ const op = el('option', null, tr(o[1])); op.value = o[0]; ts.appendChild(op); });
      const tc = el('input'); tc.type = 'color'; tc.value = th.text && th.text !== 'auto' ? th.text : '#ffffff';
      ts.value = th.text && th.text !== 'auto' ? 'custom' : 'auto'; tc.hidden = ts.value === 'auto';
      const saveTxt = function (){ const t = getTheme(); t.text = ts.value === 'auto' ? 'auto' : tc.value; setTheme(t); tc.hidden = ts.value === 'auto'; applyThemeNow(); };
      ts.addEventListener('change', saveTxt); tc.addEventListener('input', saveTxt);
      trow.appendChild(ts); trow.appendChild(tc); tl.appendChild(trow); more.appendChild(tl);
      sel2('Chowaj automatycznie', 'autohide', [['0', 'Nigdy'], ['8', 'Po 8 s od zmiany utworu'], ['15', 'Po 15 s od zmiany utworu'], ['30', 'Po 30 s od zmiany utworu']]);
      const checks = el('div', 'obs-theme-checks');
      const chk = function (label, key){
        const l = el('label', 'obs-theme-check');
        const c = el('input'); c.type = 'checkbox'; c.dataset.key = key; c.checked = key === 'art' || key === 'marquee' ? !!th[key] : th[key] !== false;
        c.addEventListener('change', function (){ const t = getTheme(); t[key] = c.checked; setTheme(t); applyThemeNow(); });
        l.appendChild(c); l.appendChild(el('span', null, tr(label))); checks.appendChild(l);
      };
      chk('Okładka', 'cover'); chk('Pasek postępu i czas', 'progress'); chk('Napis „Teraz gra”', 'label');
      chk('Rozmyta okładka w tle', 'art'); chk('Przewijaj długi tytuł', 'marquee');
      more.appendChild(checks);
      const reset = el('button', 'obs-theme-reset', tr('Przywróć domyślny wygląd')); reset.type = 'button';
      reset.addEventListener('click', function (){
        setTheme(Object.assign({}, THEME_DEF)); applyThemeNow();
        const nw = buildThemeUi(); wrap.replaceWith(nw);
      });
      more.appendChild(reset);
      const det = el('details', 'obs-theme-details');
      const sum = el('summary', null, tr('Więcej opcji wyglądu')); det.appendChild(sum); det.appendChild(more);
      try { det.open = sessionStorage.getItem('pulsarObsMore') === '1'; } catch (e){}
      det.addEventListener('toggle', function (){ try { sessionStorage.setItem('pulsarObsMore', det.open ? '1' : '0'); } catch (e){} });
      wrap.appendChild(det);
      const pv = el('div', 'obs-preview');
      const fr = el('iframe'); fr.src = '/obs/overlay.html?preview=1'; fr.setAttribute('tabindex', '-1'); fr.title = tr('Podgląd');
      fr.addEventListener('load', function (){ previewFrame = fr; sendPreview(); });
      pv.appendChild(fr); wrap.appendChild(pv);
      const fit = function (){ const w = pv.clientWidth; if (w) pv.style.setProperty('--k', String(w / 800)); };
      try { new ResizeObserver(fit).observe(pv); } catch (e){ setTimeout(fit, 50); }
      wrap.appendChild(el('p', 'obs-note', tr('Podgląd przy rozmiarze źródła 800 × 360. Zmiany trafiają do OBS od razu.')));
      return wrap;
    }
    let themeWriteTimer = 0;
    function applyThemeNow(){
      sendPreview(); if (on) sendMeta();
      clearTimeout(themeWriteTimer); themeWriteTimer = setTimeout(writeFiles, 700); // plik dla OBS też z nowym motywem (na wypadek przeładowania źródła)
    }
    window.addEventListener('message', function (ev){ if (ev.data && ev.data.pulsarObsPreviewReady && previewFrame) sendPreview(); });

    function wireUi(){
      const sw = document.getElementById('smObs');
      if (sw) sw.addEventListener('change', function (){ setEnabled(sw.checked); });
      const btn = document.getElementById('smObsHelp');
      if (btn) btn.addEventListener('click', openHelp);
      updateUi();
    }

    try {
      Neutralino.events.on('appClientConnect', function (e){ clientCount = +(e && e.detail) || 0; recount(); });
      Neutralino.events.on('appClientDisconnect', function (e){ clientCount = +(e && e.detail) || 0; recount(); });
      Neutralino.events.on('ready', function (){
        if (started) return;
        started = true;
        const init = async function (){
          wireUi();
          document.addEventListener('pulsar:audiograph', function (){ if (on) attach(); });
          document.addEventListener('pulsar:state', function (){ if (on){ attach(); sendMeta(); } });
          document.addEventListener('pulsar:lang', updateUi);
          await writeFiles(); // także przy wyłączonym: unieważnia stary token w connection.js
          if (on){ attach(); startMeta(); }
          if (window.__pulsarDesktop) window.__pulsarDesktop.obs = { enabled: function (){ return on; }, set: setEnabled, clients: function (){ return obsClients; }, help: openHelp, files: function (){ return filesOk; } };
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
      });
    } catch (e){}
  })();

  /* ---- okno: domknięcie zamyka proces ---- */
  try {
    window.addEventListener('beforeunload', () => { try { Neutralino.app.exit(); } catch (e){} });
  } catch (e){}

  // pomocnik do testów poza webviewem (node): mapowanie wpisów yt-dlp
  window.__desktopBridge = { http: httpGet, mapEntry: mapEntry, isBridgeUrl: isBridgeUrl, mp4Embed: mp4EmbedBytes, ytdlp: ytdlpUpdater, watch: watchFolder };
})();
