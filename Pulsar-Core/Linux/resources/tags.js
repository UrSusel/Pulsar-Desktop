/* tags.js — zapis i odczyt tagów (tytuł, wykonawca, album, rok, gatunek, okładka) prosto w plikach audio, czysty JS, bez ffmpeg.
 * Używają go: edytor tagów (index.html) i zapis pobranych utworów (desktop.js).
 *   PulsarTags.detect(u8)                → 'mp3' | 'mp4' | 'flac' | 'ogg' | 'wav' | ''
 *   PulsarTags.embed(u8, meta)           → Uint8Array z nowymi tagami albo null (format bez obsługi zapisu)
 *   PulsarTags.id3Embed(u8, meta)        → MP3: ID3v2 (zachowuje inne ramki, np. teksty, album, rok)
 *   PulsarTags.mp4Embed(u8, meta)        → M4A/MP4: zapis tekstowych metadanych i covr (poprawia offsety stco/co64)
 *   PulsarTags.extractMp4Metadata(file) → odczyt tytułu, wykonawcy, albumu, roku, gatunku i okładki
 * meta = { title, artist, album, year, genre, cover: Uint8Array|null, coverMime } — podane puste pola usuwają tag.
 */
(function (root) {
  'use strict';
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
      meta = meta || {};
      const fields = [
        ['title', '\u00a9nam', 1], ['artist', '\u00a9ART', 1], ['album', '\u00a9alb', 1],
        ['year', '\u00a9day', 1], ['genre', '\u00a9gen', 1], ['cover', 'covr', 13]
      ];
      const replace = fields.filter(function (field) { return Object.prototype.hasOwnProperty.call(meta, field[0]); });
      if (!replace.length) return src;
      const keep = replace.map(function (field) { return field[1]; });
      const other = ilstChildren.filter(c => keep.indexOf(c.type) < 0);
      const built = [];
      for (const field of replace){
        const value = meta[field[0]];
        if (field[0] === 'cover'){
          if (value && value.length) built.push(ilstItem(field[1], field[2], value));
        } else {
          const text = utf8(value);
          if (text.length) built.push(ilstItem(field[1], field[2], text));
        }
      }
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
          const hdlrBody = new Uint8Array(25);
          hdlrBody.set(u8str('mdir'), 8); hdlrBody.set(u8str('appl'), 12);
          const hdlr = u8cat([u8w32(new Uint8Array(4), 0, 8 + hdlrBody.length), u8str('hdlr'), hdlrBody]);
          const newMeta = u8cat([u8w32(new Uint8Array(4), 0, 8 + 4 + hdlr.length + newIlst.length), u8str('meta'), new Uint8Array(4), hdlr, newIlst]);
          const newUdta = rebuild(udta, udta.end, udta.end, newMeta);
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


  /* ---------------- ID3v2 (MP3) ---------------- */
  function syncsafe(n){ return new Uint8Array([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]); }
  function readSyncsafe(a, o){ return ((a[o] & 0x7f) << 21) | ((a[o + 1] & 0x7f) << 14) | ((a[o + 2] & 0x7f) << 7) | (a[o + 3] & 0x7f); }
  function be32(n){ return u8w32(new Uint8Array(4), 0, n); }
  function utf16bom(str){
    const s = String(str || ''); const out = new Uint8Array(2 + s.length * 2 + 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >>> 8; }
    return out; // + terminator 00 00
  }
  function id3Frame(id, body, ver){
    const size = ver === 4 ? syncsafe(body.length) : be32(body.length);
    return u8cat([u8str(id), size, new Uint8Array(2), body]);
  }
  function id3Text(id, text, ver){
    // v2.4 → UTF-8 (kodowanie 3), v2.3 → UTF-16 z BOM (kodowanie 1) — oba czyta Windows, telefony i odtwarzacze
    const payload = ver === 4 ? u8cat([new Uint8Array([3]), utf8(text), new Uint8Array([0])]) : u8cat([new Uint8Array([1]), utf16bom(text)]);
    return id3Frame(id, payload, ver);
  }
  function id3Apic(bytes, mime, ver){
    const m = u8str(mime || 'image/jpeg');
    return id3Frame('APIC', u8cat([new Uint8Array([0]), m, new Uint8Array([0, 3, 0]), bytes]), ver); // enc=0, typ 3 = przód okładki, pusty opis
  }
  function id3Embed(src, meta){
    meta = meta || {};
    let ver = 3, audioStart = 0, oldFrames = [];
    if (src.length >= 10 && src[0] === 0x49 && src[1] === 0x44 && src[2] === 0x33){
      const major = src[3], flags = src[5];
      const tagSize = readSyncsafe(src, 6);
      audioStart = 10 + tagSize + ((major === 4 && (flags & 0x10)) ? 10 : 0);
      // zachowaj pozostałe ramki tylko gdy da się je bezpiecznie skopiować (bez unsynchronisation / rozszerzonego nagłówka)
      if ((major === 3 || major === 4) && !(flags & 0xC0)){
        ver = major;
        let o = 10; const end = Math.min(src.length, 10 + tagSize);
        while (o + 10 <= end){
          const id = String.fromCharCode(src[o], src[o + 1], src[o + 2], src[o + 3]);
          if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
          const sz = major === 4 ? readSyncsafe(src, o + 4) : u8r32(src, o + 4);
          if (sz <= 0 || o + 10 + sz > end) break;
          if (id !== 'TIT2' && id !== 'TPE1' && id !== 'APIC') oldFrames.push(src.subarray(o, o + 10 + sz));
          o += 10 + sz;
        }
      }
    }
    const frames = oldFrames.slice();
    if (meta.title) frames.push(id3Text('TIT2', meta.title, ver));
    if (meta.artist) frames.push(id3Text('TPE1', meta.artist, ver));
    if (meta.cover && meta.cover.length) frames.push(id3Apic(meta.cover, meta.coverMime, ver));
    const padding = new Uint8Array(1024); // miejsce na przyszłe zmiany innych programów
    const body = u8cat(frames.concat([padding]));
    const header = u8cat([u8str('ID3'), new Uint8Array([ver, 0, 0]), syncsafe(body.length)]);
    return u8cat([header, body, src.subarray(audioStart)]);
  }

  async function extractMp4Metadata(file){
    // Czytaj tylko nagłówki atomów i blok moov — plik audio nie jest wczytywany w całości.
    try {
      if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size) || file.size < 16) return null;
      const safeAtoms = function(bytes, start, end){
        const out = []; let off = start;
        while (off + 8 <= end){
          let size = u8r32(bytes, off), header = 8;
          if (size === 1){
            if (off + 16 > end) return [];
            const hi = u8r32(bytes, off + 8), lo = u8r32(bytes, off + 12);
            size = hi * 4294967296 + lo; header = 16;
            if (!Number.isSafeInteger(size)) return [];
          } else if (size === 0) size = end - off;
          if (size < header || off + size > end) return [];
          out.push({ type: u8type(bytes, off + 4), head: off, body: off + header, end: off + size });
          off += size;
        }
        return out;
      };
      let offset = 0, moovBytes = null, moovSize = 0;
      for (let boxesSeen = 0; boxesSeen < 4096 && offset + 8 <= file.size; boxesSeen++){
        const head = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer());
        if (head.length < 8) break;
        let size = u8r32(head, 0), header = 8;
        const type = u8type(head, 4);
        if (size === 1){
          if (head.length < 16) break;
          size = u8r32(head, 8) * 4294967296 + u8r32(head, 12); header = 16;
          if (!Number.isSafeInteger(size)) break;
        } else if (size === 0) size = file.size - offset;
        if (size < header || offset + size > file.size) break;
        if (type === 'moov'){ if (size > 32 * 1024 * 1024) return null; moovSize = size; moovBytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()); break; }
        offset += size;
      }
      // Metadata larger than this is almost certainly malformed; avoid allocating unbounded memory.
      if (!moovBytes || moovSize > 32 * 1024 * 1024) return null;
      const top = safeAtoms(moovBytes, 0, moovBytes.length);
      const moov = top.find(x => x.type === 'moov');
      if (!moov) return null;
      const moovKids = safeAtoms(moovBytes, moov.body, moov.end);
      const udta = moovKids.find(x => x.type === 'udta');
      const metadataParents = udta ? safeAtoms(moovBytes, udta.body, udta.end) : moovKids;
      const meta = metadataParents.find(x => x.type === 'meta');
      if (!meta) return null;
      const metaKids = safeAtoms(moovBytes, meta.body + 4, meta.end); // meta starts with version/flags
      const ilst = metaKids.find(x => x.type === 'ilst');
      if (!ilst) return null;
      const items = safeAtoms(moovBytes, ilst.body, ilst.end);
      const result = {};
      const textTags = {
        '\u00a9nam': 'title', '\u00a9ART': 'artist', '\u00a9alb': 'album',
        '\u00a9day': 'year', '\u00a9gen': 'genre', 'aART': 'albumArtist'
      };
      for (const item of items){
        const field = textTags[item.type];
        if (!field) continue;
        const data = safeAtoms(moovBytes, item.body, item.end).find(x => x.type === 'data');
        if (!data || data.end - data.body < 8) continue;
        const payload = moovBytes.subarray(data.body + 8, data.end);
        try {
          let text;
          if (moovBytes[data.body] === 2) text = new TextDecoder('utf-16be').decode(payload);
          else text = new TextDecoder('utf-8').decode(payload);
          text = text.replace(/\0+$/g, '').trim();
          if (text) result[field] = text;
        } catch (e) {}
      }
      const covr = items.find(x => x.type === 'covr');
      if (covr){
        for (const data of safeAtoms(moovBytes, covr.body, covr.end)){
          if (data.type !== 'data' || data.end - data.body < 58) continue;
          const image = moovBytes.subarray(data.body + 8, data.end);
          if (image.length < 50) continue;
          let mime = '';
          if (image[0] === 0xff && image[1] === 0xd8) mime = 'image/jpeg';
          else if (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) mime = 'image/png';
          else if (u8type(image, 0) === 'RIFF' && u8type(image, 8) === 'WEBP') mime = 'image/webp';
          else if (u8type(image, 0) === 'GIF8') mime = 'image/gif';
          if (mime){ result.coverBlob = new Blob([image], { type: mime }); break; }
        }
      }
      return Object.keys(result).length ? result : null;
    } catch (e){ return null; }
  }

  async function extractMp4Cover(file){
    const metadata = await extractMp4Metadata(file);
    return metadata && metadata.coverBlob || null;
  }

  function detect(a){
    if (!a || a.length < 12) return '';
    if (a[0] === 0x49 && a[1] === 0x44 && a[2] === 0x33) return 'mp3';
    if (a[0] === 0xFF && (a[1] & 0xE0) === 0xE0) return 'mp3';
    if (u8type(a, 4) === 'ftyp') return 'mp4';
    if (u8type(a, 0) === 'fLaC') return 'flac';
    if (u8type(a, 0) === 'OggS') return 'ogg';
    if (u8type(a, 0) === 'RIFF' && u8type(a, 8) === 'WAVE') return 'wav';
    return '';
  }
  function embed(a, meta){
    const k = detect(a);
    if (k === 'mp3') return id3Embed(a, meta);
    if (k === 'mp4'){
      const out = mp4EmbedBytes(a, meta);
      const requested = ['title', 'artist', 'album', 'year', 'genre', 'cover'].some(function (key) { return meta && Object.prototype.hasOwnProperty.call(meta, key); });
      return out === a && requested ? null : out; // mp4EmbedBytes zwraca oryginał, gdy się nie udało
    }
    return null;
  }

  root.PulsarTags = { detect: detect, embed: embed, id3Embed: id3Embed, mp4Embed: mp4EmbedBytes, extractMp4Metadata: extractMp4Metadata, extractMp4Cover: extractMp4Cover };
})(typeof window !== 'undefined' ? window : globalThis);
