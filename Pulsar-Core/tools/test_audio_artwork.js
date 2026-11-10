'use strict';
const assert = require('node:assert/strict');
require('../Windows/resources/tags.js');
const tags = globalThis.PulsarTags;
const jpeg = new Uint8Array(80); jpeg.set([0xff, 0xd8, 0xff, 0xe0]); jpeg.set([0xff, 0xd9], jpeg.length - 2);
const mime = Buffer.from('image/jpeg');
const u32be = n => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = n => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
function cat(...parts){ const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let p = 0; for (const part of parts){ out.set(part, p); p += part.length; } return out; }
function text(s){ return new TextEncoder().encode(s); }
function file(bytes, name){ const blob = new Blob([bytes]); Object.defineProperty(blob, 'name', { value: name }); return blob; }
function flacPicture(){ return cat(u32be(3), u32be(mime.length), mime, u32be(0), u32be(500), u32be(500), u32be(24), u32be(0), u32be(jpeg.length), jpeg); }
function id3Tag(){
  const payload = cat(Uint8Array.of(0), text('image/jpeg'), Uint8Array.of(0, 3, 0), jpeg);
  const frame = cat(text('APIC'), u32be(payload.length), Uint8Array.of(0, 0), payload);
  const size = frame.length;
  return cat(text('ID3'), Uint8Array.of(3, 0, 0, (size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127), frame);
}
function riffChunk(id, payload, bigEndian){
  const size = bigEndian ? u32be(payload.length) : u32le(payload.length);
  return cat(text(id), size, payload, payload.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
}
function flacFile(){ const pic = flacPicture(); const block = cat(Uint8Array.of(0x86, (pic.length >>> 16) & 255, (pic.length >>> 8) & 255, pic.length & 255), pic); return file(cat(text('fLaC'), block), 'cover.flac'); }
function vorbisFile(){ const payload = Buffer.from(flacPicture()).toString('base64'); return file(cat(text('OggS'), text('comment=METADATA_BLOCK_PICTURE=' + payload + '\0')), 'cover.ogg'); }
function aacFile(){ return file(id3Tag(), 'cover.aac'); }
function wavFile(){ const chunk = riffChunk('ID3 ', id3Tag(), false); const body = cat(text('WAVE'), chunk); return file(cat(text('RIFF'), u32le(body.length), body), 'cover.wav'); }
function aiffFile(){ const chunk = riffChunk('ID3 ', id3Tag(), true); const body = cat(text('AIFF'), chunk); return file(cat(text('FORM'), u32be(body.length), body), 'cover.aiff'); }
function cafFile(){ const payload = id3Tag(); const chunk = cat(text('id3 '), u32be(0), u32be(payload.length), payload); return file(cat(text('caff'), Uint8Array.of(0,1,0,0), chunk), 'cover.caf'); }
function apeFile(){
  const value = cat(text('front.jpg'), Uint8Array.of(0), jpeg);
  const item = cat(u32le(value.length), u32le(0), text('Cover Art (Front)'), Uint8Array.of(0), value);
  const footer = cat(text('APETAGEX'), u32le(2000), u32le(item.length + 32), u32le(1), u32le(0), new Uint8Array(8));
  return file(cat(text('audio'), item, footer, new Uint8Array(128)), 'cover.ape');
}
function vint(n){ if (n < 127) return Uint8Array.of(0x80 | n); throw new Error('fixture too large'); }
function ebml(id, payload){ return cat(id, vint(payload.length), payload); }
function matroskaFile(){
  const fileData = ebml(Uint8Array.of(0x46, 0x5c), jpeg);
  const attached = ebml(Uint8Array.of(0x61, 0xa7), fileData);
  return file(cat(ebml(Uint8Array.of(0x19,0x41,0xa4,0x69), attached)), 'cover.mka');
}
function wmaFile(){
  const name = Buffer.from('WM/Picture', 'utf16le');
  const mime16 = Buffer.from('image/jpeg\0', 'utf16le');
  const desc16 = Buffer.from('\0', 'utf16le');
  const wmPicture = cat(Uint8Array.of(3), u32le(jpeg.length), mime16, desc16, jpeg);
  const descriptor = cat(Uint8Array.of(name.length & 255, name.length >>> 8), name,
    Uint8Array.of(1, 0, wmPicture.length & 255, wmPicture.length >>> 8), wmPicture);
  const payload = cat(Uint8Array.of(1, 0), descriptor);
  const guid = Uint8Array.of(0x40,0xa4,0xd0,0xd2,0x07,0xe3,0xd2,0x11,0x97,0xf0,0,0xa0,0xc9,0x5e,0xa8,0x50);
  const size = payload.length + 24;
  const object = cat(guid, u32le(size), u32le(0), payload);
  return file(object, 'cover.wma');
}
async function check(f, label){
  const result = await tags.extractAudioMetadata(f);
  assert.ok(result && result.coverBlob, label + ' artwork is extracted');
  assert.equal(result.coverBlob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await result.coverBlob.arrayBuffer()), jpeg);
}
(async () => {
  await check(aacFile(), 'AAC ID3 APIC frame');
  await check(flacFile(), 'FLAC PICTURE block');
  await check(vorbisFile(), 'Vorbis METADATA_BLOCK_PICTURE comment');
  await check(wavFile(), 'WAV ID3 chunk');
  await check(aiffFile(), 'AIFF ID3 chunk');
  await check(cafFile(), 'CAF ID3 chunk');
  await check(apeFile(), 'APEv2 front cover');
  await check(matroskaFile(), 'Matroska/WebM attachment');
  await check(wmaFile(), 'WMA WM/Picture attribute');
  assert.equal(await tags.extractAudioMetadata(file(text('not audio'), 'nope.bin')), null);
  console.log('10/10 embedded audio artwork extraction checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
