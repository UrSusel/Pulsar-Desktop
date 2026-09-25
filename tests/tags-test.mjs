// Test tags.js: zapis tagów do MP3 (ID3 v2.3/v2.4/brak) i M4A; weryfikacja w verify-tags.py (mutagen + ffmpeg)
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = { TextEncoder, Uint8Array, globalThis: {} }; ctx.window = ctx;
vm.createContext(ctx); vm.runInContext(fs.readFileSync(new URL('../app/resources/tags.js', import.meta.url), 'utf8'), ctx);
const T = ctx.PulsarTags;
const W = process.argv[2];
const cover = new Uint8Array(fs.readFileSync(W + '/cover.jpg'));
const meta = { title: 'Zażółć gęślą jaźń 🎵', artist: 'Łukasz & Ścibor', cover, coverMime: 'image/jpeg' };
{ // plik bez żadnego ID3 (wycinamy tag wstawiony przez ffmpeg)
  const a = new Uint8Array(fs.readFileSync(W + '/t_notag.mp3'));
  const sz = ((a[6] & 0x7f) << 21) | ((a[7] & 0x7f) << 14) | ((a[8] & 0x7f) << 7) | (a[9] & 0x7f);
  fs.writeFileSync(W + '/t_raw.mp3', a[0] === 0x49 ? a.subarray(10 + sz) : a);
}
for (const f of ['t_raw.mp3', 't_v23.mp3', 't_v24.mp3', 't_notag.mp3', 't.m4a', 't_fast.m4a']) {
  const src = new Uint8Array(fs.readFileSync(W + '/' + f));
  const kind = T.detect(src);
  const out = T.embed(src, meta);
  if (!out) { console.log('FAIL', f, 'embed zwrócił null'); continue; }
  fs.writeFileSync(W + '/out_' + f, out);
  console.log('ok', f, kind, src.length, '->', out.length);
}
// usunięcie okładki + zmiana tylko tytułu
const s2 = new Uint8Array(fs.readFileSync(W + '/out_t_v23.mp3'));
fs.writeFileSync(W + '/out2_t_v23.mp3', T.embed(s2, { title: 'Drugi', artist: 'Łukasz & Ścibor', cover: null }));
const m2 = new Uint8Array(fs.readFileSync(W + '/out_t.m4a'));
fs.writeFileSync(W + '/out2_t.m4a', T.embed(m2, { title: 'Drugi', artist: 'Łukasz & Ścibor', cover: null }));
console.log('flac/unknown ->', T.embed(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]), meta));
