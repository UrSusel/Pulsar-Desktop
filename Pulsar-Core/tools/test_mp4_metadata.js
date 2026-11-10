#!/usr/bin/env node
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
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of arrays) { out.set(part, offset); offset += part.length; }
  return out;
}
function fixture() {
  const ftyp = box('ftyp', new Uint8Array(8));
  const mdat = box('mdat', new Uint8Array(64));
  const ilst = box('ilst', new Uint8Array(0));
  const meta = box('meta', concat(new Uint8Array(4), ilst));
  const moov = box('moov', box('udta', meta));
  return new Blob([ftyp, mdat, moov], { type: 'audio/mp4' });
}

(async () => {
  const source = new Uint8Array(await fixture().arrayBuffer());
  const initial = globalThis.PulsarTags.mp4Embed(source, {
    title: 'A title', artist: 'An artist', album: 'An album', year: '2024', genre: 'Jazz'
  });
  assert.ok(initial && initial !== source, 'embeds M4A/MP4 text tags');
  const decoded = await globalThis.PulsarTags.extractMp4Metadata(new Blob([initial]));
  assert.equal(decoded.title, 'A title');
  assert.equal(decoded.artist, 'An artist');
  assert.equal(decoded.album, 'An album');
  assert.equal(decoded.year, '2024');
  assert.equal(decoded.genre, 'Jazz');
  assert.equal(decoded.coverBlob, undefined);

  const titleOnly = globalThis.PulsarTags.mp4Embed(initial, { title: 'Updated title' });
  const preserved = await globalThis.PulsarTags.extractMp4Metadata(new Blob([titleOnly]));
  assert.equal(preserved.title, 'Updated title');
  assert.equal(preserved.album, 'An album', 'fields omitted from the edit are preserved');
  assert.equal(preserved.year, '2024');
  assert.equal(preserved.genre, 'Jazz');

  const albumCleared = globalThis.PulsarTags.mp4Embed(titleOnly, { album: '' });
  const cleared = await globalThis.PulsarTags.extractMp4Metadata(new Blob([albumCleared]));
  assert.equal(cleared.album, undefined, 'an explicit empty album removes that tag');
  assert.equal(cleared.title, 'Updated title');
  assert.equal(await globalThis.PulsarTags.extractMp4Metadata(new Blob(['not an M4A file'])), null);
  console.log('M4A/MP4 metadata read/write, preservation, and clearing tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
