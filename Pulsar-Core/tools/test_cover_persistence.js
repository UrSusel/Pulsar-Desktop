#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
for (const platform of ['Linux', 'Windows']) {
  const file = path.join(root, platform, 'resources', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/^  function coverUrlOf\(t\)\s*\{[\s\S]*?^  \}/m);
  assert.ok(match, `${platform}: coverUrlOf exists`);

  let created = 0;
  const context = {
    DEFAULT_COVER: 'default-cover',
    URL: { createObjectURL(blob) { created += 1; return `blob:test-${created}-${blob.name}`; } }
  };
  vm.runInNewContext(`${match[0]}\nglobalThis.coverUrlOf = coverUrlOf;`, context);

  const track = { coverBlob: { name: 'saved-art' }, coverUrl: null };
  assert.equal(context.coverUrlOf(track), 'blob:test-1-saved-art');
  assert.equal(context.coverUrlOf(track), 'blob:test-1-saved-art', 'the generated object URL is reused');
  assert.equal(created, 1, 'a persisted cover is not replaced with the default image');

  const staleDefault = { coverBlob: { name: 'saved-art' }, coverUrl: 'default-cover' };
  assert.equal(context.coverUrlOf(staleDefault), 'blob:test-2-saved-art', 'a stale default URL does not hide an existing blob');
  assert.equal(context.coverUrlOf({ coverBlob: null, coverUrl: null }), 'default-cover');

  assert.match(html, /coverSource:\s*track\.coverSource\s*\|\|\s*''/, `${platform}: cover provenance is persisted`);
  assert.match(html, /coverSource:\s*item\.coverSource\s*\|\|\s*\(item\.coverBlob\s*\?\s*'legacy'\s*:\s*''\)/, `${platform}: legacy covers get a safe source marker on restore`);
  assert.match(html, /track\.coverSource !== 'manual' && track\.coverSource !== 'legacy'/, `${platform}: a file scan does not overwrite manually selected or legacy covers`);
  console.log(`${platform}: cover persistence regression checks passed`);
}
