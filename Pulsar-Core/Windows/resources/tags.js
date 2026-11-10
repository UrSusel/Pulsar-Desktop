/* tags.js — zapis i odczyt tagów (tytuł, wykonawca, album, rok, gatunek, okładka) prosto w plikach audio, czysty JS, bez ffmpeg.
 * Używają go: edytor tagów (index.html) i zapis pobranych utworów (desktop.js).
 *   PulsarTags.detect(u8)                → 'mp3' | 'mp4' | 'flac' | 'ogg' | 'wav' | ''
 *   PulsarTags.embed(u8, meta)           → Uint8Array z nowymi tagami albo null (format bez obsługi zapisu)
 *   PulsarTags.id3Embed(u8, meta)        → MP3: ID3v2 (zachowuje inne ramki, np. teksty, album, rok)
 *   PulsarTags.mp4Embed(u8, meta)        → M4A/MP4: zapis tekstowych metadanych i covr (poprawia offsety stco/co64)
 *   PulsarTags.extractMp4Metadata(file) → odczyt tagów MP4/M4A
 *   PulsarTags.extractAudioMetadata(file) → okładka z ID3, MP4, FLAC/Vorbis, APEv2, ASF/WMA, CAF i Matroska
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

  const MAX_ARTWORK_SCAN = 32 * 1024 * 1024;
  function imageMime(bytes){
    if (!bytes || bytes.length < 16) return '';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x89 && u8type(bytes, 1) === 'PNG') return 'image/png';
    if (u8type(bytes, 0) === 'RIFF' && u8type(bytes, 8) === 'WEBP') return 'image/webp';
    if (u8type(bytes, 0) === 'GIF8') return 'image/gif';
    if (u8type(bytes, 0) === 'BM') return 'image/bmp';
    if (u8type(bytes, 4) === 'ftyp' && /avif|avis/.test(u8type(bytes, 8))) return 'image/avif';
    return '';
  }
  function artworkBlob(raw, mime){
    if (!raw || raw.length < 50) return null;
    const detected = imageMime(raw);
    if (!detected) return null;
    return new Blob([raw], { type: detected || mime || 'application/octet-stream' });
  }
  function readU32LE(a, o){ return (a[o] | (a[o+1] << 8) | (a[o+2] << 16) | (a[o+3] << 24)) >>> 0; }
  function readU64LE(a, o){ return readU32LE(a, o) + readU32LE(a, o + 4) * 4294967296; }
  function readU64BE(a, o){ return readU32BE(a, o + 4) + readU32BE(a, o) * 4294967296; }
  function readU32BE(a, o){ return u8r32(a, o); }
  function parseId3Artwork(a){
    try {
      if (!a || a.length < 10 || a[0] !== 0x49 || a[1] !== 0x44 || a[2] !== 0x33) return null;
      const ver = a[3], flags = a[5];
      let end = 10 + ((a[6] & 127) << 21) + ((a[7] & 127) << 14) + ((a[8] & 127) << 7) + (a[9] & 127);
      end = Math.min(end, a.length);
      let off = 10;
      if ((flags & 0x40) && off + 4 <= end){
        const ext = ver === 4 ? (((a[off] & 127) << 21) | ((a[off+1] & 127) << 14) | ((a[off+2] & 127) << 7) | (a[off+3] & 127)) : readU32BE(a, off);
        off += ver === 4 ? Math.max(4, ext) : 4 + ext;
      }
      while (off + (ver === 2 ? 6 : 10) <= end){
        const hlen = ver === 2 ? 6 : 10;
        let id = '';
        for (let i = 0; i < (ver === 2 ? 3 : 4); i++) id += String.fromCharCode(a[off + i]);
        if (!id.trim()) break;
        let size = ver === 2 ? ((a[off+3] << 16) | (a[off+4] << 8) | a[off+5])
          : (ver === 4 ? (((a[off+4] & 127) << 21) | ((a[off+5] & 127) << 14) | ((a[off+6] & 127) << 7) | (a[off+7] & 127)) : readU32BE(a, off + 4));
        if (!size || size > end - off - hlen) break;
        if (id === 'APIC' || id === 'PIC'){
          const frame = a.subarray(off + hlen, off + hlen + size);
          let p = 1, mime = 'image/jpeg';
          if (id === 'PIC'){
            const fmt = String.fromCharCode(frame[1], frame[2], frame[3]).toUpperCase();
            mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg'; p = 4;
          } else {
            let z = p; while (z < frame.length && frame[z] !== 0) z++;
            const tagMime = new TextDecoder('latin1').decode(frame.subarray(p, z));
            if (tagMime && tagMime !== '-->') mime = tagMime;
            p = z + 1;
          }
          p++; // picture type
          const enc = frame[0];
          if (enc === 1 || enc === 2){ while (p + 1 < frame.length && !(frame[p] === 0 && frame[p+1] === 0)) p += 2; p += 2; }
          else { while (p < frame.length && frame[p] !== 0) p++; p++; }
          const blob = artworkBlob(frame.subarray(p), mime);
          if (blob) return blob;
        }
        off += hlen + size;
      }
    } catch(e){}
    return null;
  }
  function parseFlacPicture(a, start, end){
    try {
      let p = start;
      if (p + 32 > end) return null;
      const mimeLen = readU32BE(a, p + 4); p += 8 + mimeLen;
      if (p + 4 > end) return null;
      const descLen = readU32BE(a, p); p += 4 + descLen;
      if (p + 20 > end) return null;
      p += 16; // width, height, depth, indexed colors
      const imageLen = readU32BE(a, p); p += 4;
      if (!imageLen || p + imageLen > end) return null;
      const mimeText = new TextDecoder('utf-8').decode(a.subarray(start + 8, start + 8 + mimeLen));
      return artworkBlob(a.subarray(p, p + imageLen), mimeText);
    } catch(e){ return null; }
  }
  function decodeBase64(raw){
    try {
      const clean = String(raw || '').replace(/\s+/g, '');
      if (!clean || clean.length > MAX_ARTWORK_SCAN * 2) return null;
      const binary = atob(clean); const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch(e){ return null; }
  }
  function parseXiphPictureComment(bytes){
    try {
      const text = new TextDecoder('latin1').decode(bytes);
      const block = text.match(/METADATA_BLOCK_PICTURE=([^\0\r\n]+)/i);
      if (block){
        const raw = decodeBase64(block[1]);
        if (raw){ const pic = parseFlacPicture(raw, 0, raw.length); if (pic) return pic; }
      }
      const mimeMatch = text.match(/COVERARTMIME=([^\0\r\n]+)/i);
      const cover = text.match(/COVERART=([^\0\r\n]+)/i);
      if (cover){ const raw = decodeBase64(cover[1]); const pic = artworkBlob(raw, mimeMatch && mimeMatch[1]); if (pic) return pic; }
    } catch(e){}
    return null;
  }
  function parseFlac(a){
    if (u8type(a, 0) !== 'fLaC') return null;
    let p = 4;
    while (p + 4 <= a.length){
      const header = a[p], type = header & 0x7f;
      const len = (a[p+1] << 16) | (a[p+2] << 8) | a[p+3];
      p += 4;
      if (!len || p + len > a.length) break;
      if (type === 6){ const blob = parseFlacPicture(a, p, p + len); if (blob) return blob; }
      if (type === 4){ const blob = parseXiphPictureComment(a.subarray(p, p + len)); if (blob) return blob; }
      p += len;
      if (header & 0x80) break;
    }
    return null;
  }
  function findChunkArtwork(a, aiff){
    try {
      const form = aiff ? u8type(a, 0) === 'FORM' : u8type(a, 0) === 'RIFF';
      if (!form) return null;
      let p = 12;
      while (p + 8 <= a.length){
        const id = u8type(a, p);
        const len = aiff ? readU32BE(a, p + 4) : readU32LE(a, p + 4);
        const body = p + 8, end = Math.min(a.length, body + len);
        if (len > 0 && end <= a.length){
          if (/^ID3(?: |$)/i.test(id)){ const blob = parseId3Artwork(a.subarray(body, end)); if (blob) return blob; }
          if (/^LIST$/.test(id) && u8type(a, body) === 'INFO'){
            // RIFF INFO chunks can contain a binary IART/ICOP only rarely; no assumption that text is an image.
          }
        }
        if (!len || body + len > a.length) break;
        p = body + len + (len & 1);
      }
    } catch(e){}
    return null;
  }
  function parseApe(a){
    try {
      // APEv2 footer; its declared size includes item payloads and the footer.
      let footer = -1;
      for (let p = a.length - 32; p >= Math.max(0, a.length - 4096); p--){
        if (u8type(a, p) === 'APET'){ footer = p; break; }
      }
      if (footer < 0 || u8type(a, footer) !== 'APET' || u8type(a, footer + 4) !== 'AGEX') return null;
      const tagSize = readU32LE(a, footer + 12), count = readU32LE(a, footer + 16);
      if (tagSize < 32 || tagSize > a.length) return null;
      let p = a.length - tagSize;
      if (u8type(a, p) === 'APET' && u8type(a, p + 4) === 'AGEX') p += 32; // optional header
      for (let i = 0; i < Math.min(count, 10000) && p + 9 < footer; i++){
        const valueLen = readU32LE(a, p); p += 8;
        let z = p; while (z < footer && a[z] !== 0) z++;
        if (z >= footer) break;
        const key = new TextDecoder('latin1').decode(a.subarray(p, z)).toLowerCase();
        p = z + 1;
        if (valueLen > footer - p) break;
        const value = a.subarray(p, p + valueLen);
        if (key === 'cover art (front)' || key === 'cover art (back)' || key === 'cover art'){
          let imageStart = 0; while (imageStart < value.length && value[imageStart] !== 0) imageStart++;
          if (imageStart < value.length){ const blob = artworkBlob(value.subarray(imageStart + 1)); if (blob) return blob; }
        }
        p += valueLen;
      }
    } catch(e){}
    return null;
  }
  function parseWmPicture(data){
    try {
      if (data.length < 8) return null;
      const imageLen = readU32LE(data, 1);
      if (!imageLen || imageLen > data.length) return null;
      let p = 5;
      function skipUtf16(){ while (p + 1 < data.length && (data[p] !== 0 || data[p+1] !== 0)) p += 2; p += 2; }
      skipUtf16(); skipUtf16();
      if (p + imageLen > data.length) return null;
      return artworkBlob(data.subarray(p, p + imageLen));
    } catch(e){ return null; }
  }
  const ASF_EXT_GUID = [0x40,0xa4,0xd0,0xd2,0x07,0xe3,0xd2,0x11,0x97,0xf0,0x00,0xa0,0xc9,0x5e,0xa8,0x50];
  const ASF_META_GUID = [0xea,0xcb,0xf8,0xc5,0xaf,0x5b,0x77,0x48,0x84,0x67,0xaa,0x8c,0x44,0xfa,0x4c,0xca];
  function bytesMatch(a, p, pattern){ for (let i = 0; i < pattern.length; i++) if (a[p+i] !== pattern[i]) return false; return true; }
  function parseAsf(a){
    const utf16 = (bytes, start, len) => { try { return new TextDecoder('utf-16le').decode(bytes.subarray(start, start + len)).replace(/\0+$/g, ''); } catch(e){ return ''; } };
    function descriptorValue(start, size, isMetadataObject){
      let p = start, end = start + size;
      if (isMetadataObject) p += 2; // reserved
      if (p + 2 > end) return null;
      const n = a[p] | (a[p+1] << 8); p += 2;
      for (let i = 0; i < n && p + (isMetadataObject ? 10 : 6) <= end; i++){
        if (isMetadataObject) p += 4; // language index + stream number
        const nameLen = a[p] | (a[p+1] << 8); p += 2;
        if (nameLen > end - p - (isMetadataObject ? 6 : 4)) break;
        const name = utf16(a, p, nameLen).toLowerCase(); p += nameLen;
        const type = a[p] | (a[p+1] << 8);
        const valueLen = isMetadataObject ? readU32LE(a, p + 2) : (a[p+2] | (a[p+3] << 8));
        p += isMetadataObject ? 6 : 4;
        if (valueLen > end - p) break;
        if (name === 'wm/picture' && (type === 1 || type === 2)){ const blob = parseWmPicture(a.subarray(p, p + valueLen)); if (blob) return blob; }
        p += valueLen;
      }
      return null;
    }
    try {
      for (let p = 0; p + 24 <= a.length; p++){
        let guid = null;
        if (bytesMatch(a, p, ASF_EXT_GUID)) guid = 'ext';
        else if (bytesMatch(a, p, ASF_META_GUID)) guid = 'meta';
        if (!guid) continue;
        const size = readU64LE(a, p + 16);
        if (size < 26 || size > a.length - p) continue;
        const head = guid === 'ext' ? 24 : 28;
        const blob = descriptorValue(p + 24, size - 24, guid === 'meta');
        if (blob) return blob;
      }
    } catch(e){}
    return null;
  }
  function ebmlVint(a, p, keepMarker){
    if (p >= a.length || !a[p]) return null;
    let mask = 0x80, len = 1;
    while (len <= 8 && !(a[p] & mask)){ mask >>= 1; len++; }
    if (len > 8 || p + len > a.length) return null;
    let value = keepMarker ? a[p] : (a[p] & (mask - 1));
    for (let i = 1; i < len; i++) value = value * 256 + a[p+i];
    return { value, len };
  }
  function parseMatroska(a){
    try {
      for (let p = 0; p + 6 < a.length; p++){
        if (a[p] !== 0x19 || a[p+1] !== 0x41 || a[p+2] !== 0xa4 || a[p+3] !== 0x69) continue;
        const size = ebmlVint(a, p + 4, false);
        if (!size) continue;
        const end = Math.min(a.length, p + 4 + size.len + size.value);
        let q = p + 4 + size.len;
        while (q + 3 < end){
          const id = ebmlVint(a, q, true); if (!id) break;
          const sz = ebmlVint(a, q + id.len, false); if (!sz) break;
          const body = q + id.len + sz.len, childEnd = body + sz.value;
          if (childEnd > end || childEnd > a.length) break;
          if (id.value === 0x61a7){
            let r = body;
            while (r + 2 < childEnd){
              const cid = ebmlVint(a, r, true); if (!cid) break;
              const cs = ebmlVint(a, r + cid.len, false); if (!cs) break;
              const cb = r + cid.len + cs.len, ce = cb + cs.value;
              if (ce > childEnd) break;
              if (cid.value === 0x465c){ const blob = artworkBlob(a.subarray(cb, ce)); if (blob) return blob; }
              r = ce;
            }
          }
          q = childEnd;
        }
      }
    } catch(e){}
    return null;
  }
  async function extractFlacArtwork(file){
    try {
      const marker = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (u8type(marker, 0) !== 'fLaC') return null;
      let p = 4, scanned = 0;
      while (p + 4 <= file.size && scanned < MAX_ARTWORK_SCAN){
        const header = new Uint8Array(await file.slice(p, p + 4).arrayBuffer());
        const type = header[0] & 0x7f;
        const len = (header[1] << 16) | (header[2] << 8) | header[3];
        p += 4; scanned += 4;
        if (!len || len > MAX_ARTWORK_SCAN || p + len > file.size) break;
        if (type === 6 || type === 4){
          const block = new Uint8Array(await file.slice(p, p + len).arrayBuffer());
          const blob = type === 6 ? parseFlacPicture(block, 0, block.length) : parseXiphPictureComment(block);
          if (blob) return blob;
        }
        p += len; scanned += len;
        if (header[0] & 0x80) break;
      }
    } catch(e){}
    return null;
  }
  async function extractId3Chunks(file, aiff){
    try {
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (aiff ? u8type(header, 0) !== 'FORM' : u8type(header, 0) !== 'RIFF') return null;
      let p = 12, count = 0;
      while (p + 8 <= file.size && count++ < 20000){
        const chunk = new Uint8Array(await file.slice(p, p + 8).arrayBuffer());
        const id = u8type(chunk, 0), len = aiff ? readU32BE(chunk, 4) : readU32LE(chunk, 4);
        const body = p + 8;
        if (/^ID3(?: |$)/i.test(id) && len > 0 && len <= MAX_ARTWORK_SCAN){
          const blob = parseId3Artwork(new Uint8Array(await file.slice(body, body + len).arrayBuffer()));
          if (blob) return blob;
        }
        if (!len || body + len > file.size) break;
        p = body + len + (len & 1);
      }
    } catch(e){}
    return null;
  }
  async function extractCafArtwork(file){
    try {
      const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (u8type(header, 0) !== 'caff') return null;
      let p = 8, count = 0;
      while (p + 12 <= file.size && count++ < 20000){
        const chunk = new Uint8Array(await file.slice(p, p + 12).arrayBuffer());
        const id = u8type(chunk, 0), len = readU64BE(chunk, 4), body = p + 12;
        if (id.toLowerCase() === 'id3 ' && len > 0 && len <= MAX_ARTWORK_SCAN && body + len <= file.size){
          const blob = parseId3Artwork(new Uint8Array(await file.slice(body, body + len).arrayBuffer()));
          if (blob) return blob;
        }
        if (!Number.isSafeInteger(len) || !len || body + len > file.size) break;
        p = body + len;
      }
    } catch(e){}
    return null;
  }
  async function extractApeArtwork(file){
    try {
      if (file.size < 32) return null;
      const tailStart = Math.max(0, file.size - 4096);
      const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
      for (let p = tail.length - 32; p >= 0; p--){
        if (u8type(tail, p) !== 'APET' || u8type(tail, p + 4) !== 'AGEX') continue;
        const tagSize = readU32LE(tail, p + 12);
        const end = tailStart + p + 32, start = end - tagSize;
        if (tagSize < 32 || tagSize > MAX_ARTWORK_SCAN || start < 0) continue;
        const tag = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const blob = parseApe(tag);
        if (blob) return blob;
      }
    } catch(e){}
    return null;
  }
  async function extractAudioMetadata(file){
    try {
      if (!file || typeof file.slice !== 'function') return null;
      const name = String(file.name || '').toLowerCase();
      const probe = new Uint8Array(await file.slice(0, Math.min(file.size, 16)).arrayBuffer());
      // Run the MP4 parser before generic scans: its metadata may live at the end of a large file.
      if (u8type(probe, 4) === 'ftyp') return await extractMp4Metadata(file);
      if (probe[0] === 0x49 && probe[1] === 0x44 && probe[2] === 0x33){
        const size = probe.length >= 10 ? 10 + ((probe[6] & 127) << 21) + ((probe[7] & 127) << 14) + ((probe[8] & 127) << 7) + (probe[9] & 127) : 0;
        if (size > 10 && size <= MAX_ARTWORK_SCAN){
          const blob = parseId3Artwork(new Uint8Array(await file.slice(0, size).arrayBuffer()));
          if (blob) return { coverBlob: blob };
        }
      }
      let coverBlob = null;
      if (u8type(probe, 0) === 'fLaC') coverBlob = await extractFlacArtwork(file);
      else if (u8type(probe, 0) === 'RIFF') coverBlob = await extractId3Chunks(file, false);
      else if (u8type(probe, 0) === 'FORM') coverBlob = await extractId3Chunks(file, true);
      else if (u8type(probe, 0) === 'OggS' || /\.(ogg|oga|opus)$/i.test(name)){
        const data = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_ARTWORK_SCAN)).arrayBuffer());
        coverBlob = parseXiphPictureComment(data);
        if (!coverBlob){
          for (let p = 0; p + 4 < data.length; p++) if (u8type(data, p) === 'fLaC'){ coverBlob = parseFlac(data.subarray(p)); if (coverBlob) break; }
        }
      } else if (u8type(probe, 0) === 'caff' || /\.caf$/i.test(name)) coverBlob = await extractCafArtwork(file);
      else if (/\.(ape|wv|mpc)$/i.test(name)) coverBlob = await extractApeArtwork(file);
      else if (/\.(dsf|dff)$/i.test(name)){
        const tail = new Uint8Array(await file.slice(Math.max(0, file.size - MAX_ARTWORK_SCAN), file.size).arrayBuffer());
        for (let p = tail.length - 10; p >= 0; p--) if (tail[p] === 0x49 && tail[p+1] === 0x44 && tail[p+2] === 0x33){ coverBlob = parseId3Artwork(tail.subarray(p)); if (coverBlob) break; }
      } else if (/\.wma$/i.test(name) || (probe[0] === 0x30 && probe[1] === 0x26 && probe[2] === 0xb2 && probe[3] === 0x75)){
        const data = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_ARTWORK_SCAN)).arrayBuffer());
        coverBlob = parseAsf(data);
      } else if (/\.(mka|mkv|webm|weba)$/i.test(name)){
        const data = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_ARTWORK_SCAN)).arrayBuffer());
        coverBlob = parseMatroska(data) || parseXiphPictureComment(data);
      }
      if (!coverBlob) coverBlob = await extractApeArtwork(file); // APEv2 can also trail MP3/other files.
      return coverBlob ? { coverBlob } : null;
    } catch(e){ return null; }
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

  root.PulsarTags = { detect: detect, embed: embed, id3Embed: id3Embed, mp4Embed: mp4EmbedBytes, extractMp4Metadata: extractMp4Metadata, extractMp4Cover: extractMp4Cover, extractAudioMetadata: extractAudioMetadata };
})(typeof window !== 'undefined' ? window : globalThis);
