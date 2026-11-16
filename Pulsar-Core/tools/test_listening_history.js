#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const platform of ['Linux', 'Windows']) {
  const html = fs.readFileSync(path.join(__dirname, '..', platform, 'resources', 'index.html'), 'utf8');
  assert.match(html, /data-view="history"/, `${platform}: library exposes a listening-history view`);
  assert.match(html, /id="listeningStats"[\s\S]*?id="listeningTopArtists"[\s\S]*?id="listeningRecent"/,
    `${platform}: view contains summary, top artists and recent listening rows`);
  assert.match(html, /id="smListeningHistoryToggle"/, `${platform}: recording has an explicit settings opt-in`);
  assert.match(html, /id="smListeningHistoryClearBtn"/, `${platform}: user can clear collected listening data`);
  assert.match(html, /localStorage\.getItem\('pulsarListeningHistoryEnabled'\) === '1'/,
    `${platform}: collection is off unless the user explicitly enabled it`);
  assert.match(html, /localStorage\.setItem\('pulsarListeningHistoryV1'/,
    `${platform}: history is kept in local storage`);
  assert.match(html, /slice\(-1000\)/, `${platform}: history storage is bounded`);
  assert.match(html, /const minimum = session\.duration > 0 \? Math\.min\(30, session\.duration \* 0\.5\) : 30/,
    `${platform}: a play is recorded only after a meaningful listen`);
  assert.match(html, /audio\.addEventListener\('play',[\s\S]*?startListeningSession\(listeningTrack,audio\)/,
    `${platform}: history tracks actual playback rather than just selecting a track`);
  assert.match(html, /finishListeningSession\(\)[\s\S]*?persistListeningHistory\(\)[\s\S]*?renderListeningHistoryView\(\)/,
    `${platform}: completed listening sessions update saved stats and UI`);
  assert.match(html, /not synced|is not synced|no se sincroniza/i,
    `${platform}: privacy notice states the data is not synced`);
  assert.match(html, /recommendationHistory = JSON\.parse\(/, `${platform}: recommendation history remains available independently`);
  assert.match(html, /listeningHistory = JSON\.parse\(/, `${platform}: listening history has its own separate local store`);
  for (const key of [
    'Odsłuchy', 'Historia odsłuchów', 'Łączny czas słuchania', 'Utwory przesłuchane',
    'Różne utwory', 'Najczęściej słuchani wykonawcy', 'Ostatnie odsłuchy',
    'Zapisuj historię odsłuchów', 'Usuń historię odsłuchów',
    'Historia pozostaje na tym urządzeniu i nie jest synchronizowana. Liczymy odsłuch po 30 sekundach lub połowie krótszego utworu.'
  ]) {
    assert.match(html, new RegExp(`['"]${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]\\s*:\\s*\\{\\s*en:[^,]+,\\s*es:`),
      `${platform}: PL/EN/ES translation exists for ${key}`);
  }

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  assert.ok(scripts.length, `${platform}: inline runtime scripts exist`);
  for (let i = 0; i < scripts.length; i++) {
    const result = require('node:child_process').spawnSync('node', ['--check'], {
      input: scripts[i][1], encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${platform}: inline script ${i} syntax: ${result.stderr}`);
  }
  console.log(`${platform}: listening history UI, privacy and playback checks passed`);
}
