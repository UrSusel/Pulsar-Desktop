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

  /* ---- czyste-JS osadzanie tytułu/wykonawcy/okładki w MP4/M4A (bez ffmpeg) ---- */
  function u8str(s){ const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; }
  function u8cat(list){ let n = 0; for (const a of list) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of list){ out.set(a, o); o += a.length; } return out; }
  function u8w32(a, o, v){ a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; return a; }
  function u8w64(a, o, v){ u8w32(a, o, Math.floor(v / 4294967296)); u8w32(a, o + 4, v >>> 0); return a; }
  function u8r32(a, o){ return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0; }
  function u8type(a, o){ return String.fromCharCode(a[o], a[o + 1], a[o + 2], a[o + 3]); }

  // przejście po atomach: zwraca [{type, head, body, end}]; rzuca przy 64-bit size (rzadkie) → caller ma try/catch
  function u8atoms(a, start, end){
    const out = [];
    let off = start;
    while (off + 8 <= end){
      let size = u8r32(a, off);
      if (size === 1) throw new Error('64-bit box');
      if (size === 0) size = end - off;
      if (size < 8 || off + size > end) throw new Error('bad size');
      out.push({ type: u8type(a, off + 4), head: off, body: off + 8, end: off + size });
      off += size;
    }
    return out;
  }
  function findBox(list, type){ for (let i = 0; i < list.length; i++) if (list[i].type === type) return list[i]; return null; }

  // zbuduj atom dziecka ilst: size + '©nam' + data(size + 'data' + typ + payload)
  function ilstItem(tag, typeCode, payload){
    // data atom: size + 'data' + klasa/flagi(4) + locale(4) + payload
    return u8cat([u8w32(new Uint8Array(4), 0, 24 + payload.length), u8str(tag),
      u8w32(new Uint8Array(4), 0, 16 + payload.length), u8str('data'),
      new Uint8Array([typeCode, 0, 0, 0]), new Uint8Array(4), payload]);
  }
  function utf8(str){ try { return new TextEncoder().encode(String(str || '')); } catch (e){ return u8str(String(str || '')); } }

  // iteruj po wszystkich atomach wskazanego typu w zadanym zakresie (moof/tfhd/stco…)
  function scanBoxes(a, start, end, type, cb){
    let off = start;
    while (off + 8 <= end){
      let size = u8r32(a, off);
      if (size === 0) size = end - off;
      if (size < 8 || off + size > end) return;
      if (u8type(a, off + 4) === type) cb({ head: off, body: off + 8, end: off + size });
      off += size;
    }
  }

  // meta: { title, artist, cover: Uint8Array(jpeg)|null } → Uint8Array (oryginał, gdy nic nie wypali)
  function mp4EmbedBytes(src, meta){
    try {
      const top = u8atoms(src, 0, src.length);
      const moov = findBox(top, 'moov');
      if (!moov) return src;
      const kids = u8atoms(src, moov.body, moov.end);
      let udta = findBox(kids, 'udta');
      // --- zbierz/zbuduj ilst ---
      let ilstChildren = [];
      let ilstHead = null;
      if (udta){
        const uk = u8atoms(src, udta.body, udta.end);
        const metaB = findBox(uk, 'meta');
        if (metaB){
          const mk = u8atoms(src, metaB.body + 4, metaB.end); // meta = FullBox (+4 bajty version/flags)
          let ilst = findBox(mk, 'ilst');
          if (!ilst){ ilst = { type: 'ilst', head: metaB.end, body: metaB.end, end: metaB.end }; mk.push(ilst); } // doklej na końcu meta (nic nie ucinaj)
          ilstHead = ilst;
          ilstChildren = u8atoms(src, ilst.body, ilst.end);
        }
      }
      const keep = ['\u00a9nam', '\u00a9ART', 'covr']; // tylko te trzy podmieniamy
      const other = ilstChildren.filter(c => keep.indexOf(c.type) < 0);
      const built = [];
      const t = utf8(meta && meta.title);   if (t.length)  built.push(ilstItem('\u00a9nam', 1, t));
      const ar = utf8(meta && meta.artist); if (ar.length) built.push(ilstItem('\u00a9ART', 1, ar));
      if (meta && meta.cover && meta.cover.length) built.push(ilstItem('covr', 13, meta.cover));
      if (!built.length) return src;
      const newIlstBody = u8cat(other.map(c => src.subarray(c.head, c.end)).concat(built));
      const newIlst = u8cat([u8w32(new Uint8Array(4), 0, 8 + newIlstBody.length), u8str('ilst'), newIlstBody]);
      // --- przebuduj meta/udta/moov ---
      function rebuild(parent, childHead, childEnd, newChild){
        const before = src.subarray(parent.body, childHead);
        const after = src.subarray(childEnd, parent.end);
        const out = u8cat([src.subarray(parent.head, parent.body), before, newChild, after]);
        u8w32(out, 0, out.length); // świeży rozmiar pudełka w nagłówku
        return out;
      }
      let tail;
      if (udta){
        const uk = u8atoms(src, udta.body, udta.end);
        const metaB = findBox(uk, 'meta');
        if (metaB){
          const newMeta = rebuild(metaB, ilstHead.head, ilstHead.end, newIlst); // meta.head..body zachowane (ver/flags)
          const newUdta = rebuild(udta, metaB.head, metaB.end, newMeta);
          tail = rebuild(moov, udta.head, udta.end, newUdta);
        } else {
          const newUdta = u8cat([src.subarray(udta.head, udta.end), newIlst]);
          tail = rebuild(moov, udta.head, udta.end, newUdta);
        }
      } else {
        // brak udta: meta = ver/flags + hdlr(mdir/appl) + ilst
        const hdlrBody = new Uint8Array(25); // ver/flags + pre_defined + 'mdir' + 'appl' + 9×0
        hdlrBody.set(u8str('mdir'), 8);
        hdlrBody.set(u8str('appl'), 12);
        const hdlr = u8cat([u8w32(new Uint8Array(4), 0, 8 + hdlrBody.length), u8str('hdlr'), hdlrBody]);
        const newMeta = u8cat([u8w32(new Uint8Array(4), 0, 8 + 4 + hdlr.length + newIlst.length), u8str('meta'), new Uint8Array(4), hdlr, newIlst]);
        const newUdta = u8cat([u8w32(new Uint8Array(4), 0, 8 + newMeta.length), u8str('udta'), newMeta]);
        tail = rebuild(moov, moov.end, moov.end, newUdta); // doklej na końcu moov
      }
      const delta = tail.length - (moov.end - moov.head);
      // --- popraw offsety absolutne, jeśli coś się przesunęło ---
      if (delta !== 0){
        const mStart = moov.head;
        // stco/co64: schodź rekurencyjnie moov→trak→mdia→minf→stbl (tail = obraz moov, dzieci od (moov.body-moov.head))
        function patchChunks(bytes, from, to){
          let off = from;
          while (off + 8 <= to){
            let size = u8r32(bytes, off);
            if (size === 0) size = to - off;
            if (size < 8 || off + size > to) return;
            const ty = u8type(bytes, off + 4);
            if (ty === 'stco' || ty === 'co64'){
              const wide = ty === 'co64' ? 8 : 4;
              const n = u8r32(bytes, off + 12); // version/flags(4) → entry_count na off+12
              for (let i = 0; i < n; i++){
                const p = off + 16 + i * wide;
                const v = wide === 4 ? u8r32(bytes, p) : u8r32(bytes, p) * 4294967296 + u8r32(bytes, p + 4);
                if (v > 0 && v >= mStart){
                  if (wide === 4) u8w32(bytes, p, v + delta); else u8w64(bytes, p, v + delta);
                }
              }
            } else if (ty === 'trak' || ty === 'mdia' || ty === 'minf' || ty === 'stbl'){
              patchChunks(bytes, off + 8, off + size);
            }
            off += size;
          }
        }
        patchChunks(tail, moov.body - moov.head, tail.length);
        // tfhd base_data_offset (flags&1) we fragmentach za moov — absolutne offsety też przesuwamy
        const tailShift = tail.length - src.length; // region za moov kopiowany 1:1
        function patchTfhd(bytes, from, to){
          let off = from;
          while (off + 8 <= to){
            let size = u8r32(bytes, off);
            if (size === 0) size = to - off;
            if (size < 8 || off + size > to) return;
            const ty = u8type(bytes, off + 4);
            if (ty === 'traf') patchTfhd(bytes, off + 8, off + size);
            else if (ty === 'tfhd'){
              const flags = (bytes[off + 8 + 1] << 16) | (bytes[off + 8 + 2] << 8) | bytes[off + 8 + 3];
              if (flags & 0x1){
                const p = off + 16; // body(8)+ver/flags(4)+track_id(4) → base_data_offset
                const v = u8r32(bytes, p) * 4294967296 + u8r32(bytes, p + 4);
                if (v >= mStart) u8w64(tail, p + tailShift, v + delta);
              }
            }
            off += size;
          }
        }
        patchTfhd(src, moov.end, src.length);
      }
      return u8cat([src.subarray(0, moov.head), tail, src.subarray(moov.end)]);
    } catch (e){ return src; }
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
      var saveWinGeo = function (){
        if (winFsOn) return;
        Promise.all([
          Neutralino.window.getSize ? Neutralino.window.getSize() : Promise.resolve(null),
          Neutralino.window.getPosition ? Neutralino.window.getPosition().catch(function (){ return null; }) : Promise.resolve(null),
          Neutralino.window.isMaximized ? Neutralino.window.isMaximized().catch(function (){ return false; }) : Promise.resolve(false)
        ]).then(function (r){
          var size = r[0], pos = r[1], maximized = !!r[2];
          if (size && size.width > 100 && size.height > 100){
            winFsSaved = { width: size.width, height: size.height, x: pos ? pos.x : null, y: pos ? pos.y : null, maximized: maximized };
          }
        }).catch(function (){});
      };
      try { window.addEventListener('resize', function (){ setTimeout(saveWinGeo, 80); }); } catch (e){}
      setTimeout(saveWinGeo, 300);
      setTimeout(saveWinGeo, 1500);
      var winFsRestore = function (){
        setTimeout(function (){
          try {
            var sv = winFsSaved; winFsSaved = null;
            if (sv && sv.maximized && Neutralino.window.maximize){ Neutralino.window.maximize(); return; }
            if (sv && Neutralino.window.setSize){
              Neutralino.window.setSize({ width: sv.width, height: sv.height });
              if (Neutralino.window.move && sv.x != null && sv.y != null) Neutralino.window.move(sv.x, sv.y);
            } else if (sv && Neutralino.window.center){ Neutralino.window.center(); }
          } catch (e){}
        }, 160); // chwilę po exitFullScreen — nadpisuje wadliwy powrót runtime'u (okno pod paskiem zadań)
      };
      var winFs = function (on){
        if (winFsOn === on) return;
        winFsOn = on;
        try {
          if (on){ saveWinGeo(); Neutralino.window.setFullScreen(); }
          else { Neutralino.window.exitFullScreen(); winFsRestore(); }
        } catch (e){}
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
      mini: 'pulsarMini', miniGeo: 'pulsarMiniGeo', normalGeo: 'pulsarNormalGeo', trayHint: 'pulsarTrayHintShown'
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
      try { Neutralino.app.exit(); } catch (e){}
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
            quit: quit
          };
          const bt = await safe(function (){ return W.getTitle(); });
          if (bt) baseTitle = bt;
          wireSettingsUI();
          document.addEventListener('pulsar:state', scheduleRefresh);
          document.addEventListener('pulsar:lang', function (){ lastTrayJson = ''; scheduleRefresh(); });
          await applyOnTop();
          if (getB(K.mini, false)) await setMini(true, { startup: true });
          refresh();
        });
      });
    } catch (e){}
  })();

  /* ---- okno: domknięcie zamyka proces ---- */
  try {
    window.addEventListener('beforeunload', () => { try { Neutralino.app.exit(); } catch (e){} });
  } catch (e){}

  // pomocnik do testów poza webviewem (node): mapowanie wpisów yt-dlp
  window.__desktopBridge = { mapEntry: mapEntry, isBridgeUrl: isBridgeUrl, mp4Embed: mp4EmbedBytes };
})();
