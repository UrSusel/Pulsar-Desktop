#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function test(platform) {
  const root = path.join(__dirname, '..', platform, 'resources');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const desktop = fs.readFileSync(path.join(root, 'desktop.js'), 'utf8');

  assert.match(html, /new BroadcastChannel\('pulsar-factory-reset'\)/,
    `${platform}: reset coordination channel is initialized`);
  assert.match(html, /message\.type === 'prepare'[\s\S]*?closePulsarDatabaseHandles\(\)[\s\S]*?closeForReset\(\)/,
    `${platform}: other windows close player and sync database handles before deletion`);
  assert.match(html, /message\.type === 'complete'[\s\S]*?location\.reload\(\)/,
    `${platform}: peer windows reload after the reset has completed`);
  assert.match(html, /if \(factoryResetActive \|\| factoryResetPending\) return Promise\.reject/,
    `${platform}: database handles cannot reopen during an active reset`);
  assert.match(html, /request\.onsuccess = \(\) => \{\s*if \(factoryResetActive \|\| factoryResetPending\)\{\s*request\.result\.close\(\)/,
    `${platform}: an IndexedDB open already in flight is closed if reset begins first`);
  assert.match(html, /factoryResetChannel\.postMessage\(\{ type: 'prepare', id: resetId \}\)/,
    `${platform}: reset asks other windows to release open connections first`);
  assert.match(html, /factoryResetChannel\.postMessage\(\{ type: 'complete', id: resetId \}\)/,
    `${platform}: reset completion is broadcast to peer windows`);
  assert.match(html, /request\.onblocked = \(\) => showToast/,
    `${platform}: blocked IndexedDB deletion waits rather than failing immediately`);
  assert.match(html, /\['ambient-player-library', 'pulsar-sync'\]\.map\(deleteIndexedDb\)/,
    `${platform}: reset deletes both local player and sync databases`);
  const driveSync = fs.readFileSync(path.join(__dirname, '..', '..', 'Pulsar-Sync', 'drive-sync.js'), 'utf8');
  assert.match(driveSync, /closeForReset:\s*function/,
    `${platform}: shared sync bridge exposes a reset close hook`);

  const match = html.match(/function deleteIndexedDb\(name\)\{[\s\S]*?\n  \}/);
  assert.ok(match, `${platform}: IndexedDB deletion helper exists`);
  const requests = [];
  const fakeIndexedDb = { deleteDatabase(name) { const request = { name }; requests.push(request); return request; } };
  const notices = [];
  const deleteDb = new Function('indexedDB', 'showToast', 't', `return ${match[0]};`)(
    fakeIndexedDb,
    (message) => notices.push(message),
    (message) => message
  );

  let settled = false;
  const deletion = deleteDb('ambient-player-library').then(() => { settled = true; });
  assert.equal(requests[0].name, 'ambient-player-library');
  requests[0].onblocked();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, `${platform}: a temporary blocked event does not reject or finish deletion`);
  assert.equal(notices.length, 1, `${platform}: users are told the reset is waiting for other windows`);
  requests[0].onsuccess();
  await deletion;
  assert.equal(settled, true, `${platform}: deletion finishes once peer connections close`);
}

(async () => {
  for (const platform of ['Linux', 'Windows']) await test(platform);
  console.log('Linux and Windows: factory reset coordination checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
