#!/usr/bin/env node
'use strict';
const assert = require('assert');
const updates = require('../app-updates.js');
let count = 0, failures = 0;

async function test(name, fn) {
  count++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n  ' + error.stack); }
}
function response(release, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => release });
}

(async () => {
  await test('tag vX.Y.Z jest normalizowany do wersji bez v', () => {
    assert.strictEqual(updates.parseVersion(' v0.21.0 ').text, '0.21.0');
    assert.strictEqual(updates.parseVersion('1.2.3-rc.1+build.8').text, '1.2.3-rc.1');
  });
  await test('nienumeryczny i niepełny tag nie jest wersją', () => {
    for (const tag of ['Linux', 'Release 0.21.0', '0.21', '0.21.0.1', '01.2.3', '']) assert.strictEqual(updates.parseVersion(tag), null, tag);
  });
  await test('porównanie jest numeryczne, nie leksykograficzne', () => {
    assert.strictEqual(updates.compareVersions('0.21.0', '0.22.0'), -1);
    assert.strictEqual(updates.compareVersions('0.21.0', '0.9.0'), 1);
    assert.strictEqual(updates.compareVersions('1.10.0', '1.9.9'), 1);
    assert.strictEqual(updates.compareVersions('v0.21.0', '0.21.0'), 0);
  });
  await test('wydanie stabilne jest nowsze od prerelease', () => {
    assert.strictEqual(updates.compareVersions('0.21.0-rc.1', '0.21.0'), -1);
    assert.strictEqual(updates.compareVersions('0.21.0-alpha.10', '0.21.0-alpha.2'), 1);
    assert.strictEqual(updates.compareVersions('0.21.0+local', '0.21.0'), 0);
  });
  await test('nowszy GitHub Release zwraca aktualizację i właściwy endpoint', async () => {
    let url, init;
    const result = await updates.check({
      current: '0.21.0', repo: 'UrSusel/Pulsar-Desktop',
      fetchImpl: async (u, i) => { url = u; init = i; return response({ tag_name: 'v0.22.0', html_url: 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.0' })(); }
    });
    assert.strictEqual(url, 'https://api.github.com/repos/UrSusel/Pulsar-Desktop/releases/latest');
    assert.strictEqual(init.headers.Accept, 'application/vnd.github+json');
    assert.strictEqual(result.updateAvailable, true);
    assert.strictEqual(result.latest, '0.22.0');
    assert.strictEqual(result.releaseUrl, 'https://github.com/UrSusel/Pulsar-Desktop/releases/tag/v0.22.0');
  });
  await test('ten sam i starszy release nie oferują aktualizacji', async () => {
    for (const tag of ['v0.21.0', 'v0.20.12']) {
      const result = await updates.check({ current: '0.21.0', repo: 'UrSusel/Pulsar-Desktop', fetchImpl: response({ tag_name: tag }) });
      assert.strictEqual(result.updateAvailable, false);
      assert.strictEqual(result.error, undefined);
    }
  });
  await test('stary tag Linux daje nieznaną wersję, nie fałszywy komunikat o aktualności', async () => {
    const result = await updates.check({ current: '0.21.0', repo: 'UrSusel/Pulsar-Desktop', fetchImpl: response({ tag_name: 'Linux', name: 'Release 0.20.12' }) });
    assert.strictEqual(result.error, 'invalid-tag');
    assert.strictEqual(result.latest, null);
    assert.strictEqual(result.updateAvailable, false);
  });
  await test('błąd HTTP jest wynikiem kontrolowanym, nie odrzuconym Promise', async () => {
    const result = await updates.check({ current: '0.21.0', repo: 'UrSusel/Pulsar-Desktop', fetchImpl: response({}, false, 503) });
    assert.match(result.error, /503/);
    assert.strictEqual(result.updateAvailable, false);
  });
  await test('automatyczne sprawdzanie jest domyślne i ograniczone do 12 godzin', () => {
    const now = Date.UTC(2026, 10, 1, 12);
    assert.strictEqual(updates.shouldAutoCheck(now, 0, undefined), true);
    assert.strictEqual(updates.shouldAutoCheck(now, now - updates.AUTO_INTERVAL + 1, true), false);
    assert.strictEqual(updates.shouldAutoCheck(now, now - updates.AUTO_INTERVAL, true), true);
    assert.strictEqual(updates.shouldAutoCheck(now, 0, false), false);
  });
  console.log('\n' + (count - failures) + '/' + count + ' testów aktualizacji aplikacji zaliczonych');
  process.exitCode = failures ? 1 : 0;
})();
