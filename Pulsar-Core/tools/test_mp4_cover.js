'use strict';
const assert = require('node:assert/strict');
require('../Windows/resources/tags.js');

function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
function fixture(imageBytes) {
  const ftyp = box('ftyp', new Uint8Array(8));
  const mdat = box('mdat', new Uint8Array(64));
  const dataPayload = concat(new Uint8Array([13, 0, 0, 0, 0, 0, 0, 0]), imageBytes);
  const data = box('data', dataPayload);
  const covr = box('covr', data);
  const ilst = box('ilst', covr);
  const meta = box('meta', concat(new Uint8Array(4), ilst));
  const moov = box('moov', box('udta', meta));
  return new Blob([ftyp, mdat, moov], { type: 'audio/mp4' });
}

(async () => {
  const jpeg = new Uint8Array(80); jpeg.set([0xff, 0xd8, 0xff]);
  const mp4Fixture = fixture(jpeg);
  const jpegBlob = await globalThis.PulsarTags.extractMp4Cover(mp4Fixture);
  assert.ok(jpegBlob, 'extracts a cover stored in M4A/MP4 covr');
  const mp4Metadata = await globalThis.PulsarTags.extractAudioMetadata(mp4Fixture);
  assert.ok(mp4Metadata && mp4Metadata.coverBlob, 'shared audio reader also routes MP4/M4A through covr parser');
  assert.equal(jpegBlob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await jpegBlob.arrayBuffer()), jpeg);

  const png = new Uint8Array(80); png.set([0x89, 0x50, 0x4e, 0x47]);
  const pngBlob = await globalThis.PulsarTags.extractMp4Cover(fixture(png));
  assert.ok(pngBlob, 'extracts a PNG cover');
  assert.equal(pngBlob.type, 'image/png');

  assert.equal(await globalThis.PulsarTags.extractMp4Cover(new Blob(['not an audio file'])), null);
  console.log('3/3 M4A embedded-cover tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
