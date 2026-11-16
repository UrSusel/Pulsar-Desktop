#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');

for (const platform of ['Linux', 'Windows']) {
  const html = fs.readFileSync(path.join(root, platform, 'resources', 'index.html'), 'utf8');
  const desktop = fs.readFileSync(path.join(root, platform, 'resources', 'desktop.js'), 'utf8');
  assert.match(html, /id="smDiscordPresenceToggle"/, `${platform}: presence is opt-in`);
  assert.doesNotMatch(html, /id="smDiscordApplicationId|id="smDiscordSaveIdBtn|id="smDiscordPortalBtn/,
    `${platform}: application ID and developer controls stay out of the settings UI`);
  assert.match(html, /pulsarDiscordPresenceEnabled/, `${platform}: preference persists locally`);
  assert.match(html, /pulsarDiscordApplicationId/, `${platform}: application ID preference remains overridable`);
  assert.ok(html.includes("||'1571647035168530442'"),
    `${platform}: Pulsar's shared public Application ID is preconfigured for all users`);
  assert.match(html, /function startDiscordPolling\(\)/,
    `${platform}: enabling presence starts its retry/update timer`);
  assert.match(html, /function stopDiscordPolling\(\)/,
    `${platform}: disabling presence clears its timers`);
  assert.equal((html.match(/function startDiscordPolling\(\)/g) || []).length, 1,
    `${platform}: there is exactly one presence polling lifecycle`);
  assert.match(html, /setInterval\(function\(\)\{if\(!discordConnected\)updateDiscordActivity\(\);\},15000\)/,
    `${platform}: polling retries only while Discord is disconnected`);
  assert.match(html, /reason==='track'[\s\S]*?clearTimeout\(discordPresenceRefreshTimer\);\s*updateDiscordActivity\(\);/,
    `${platform}: track changes immediately bypass the ordinary playback debounce`);
  assert.match(html, /audio.addEventListener\(eventName,scheduleDiscordActivity\)[\s\S]*?audioXF.addEventListener\(eventName,scheduleDiscordActivity\)/,
    `${platform}: both playback decks schedule presence updates`);
  assert.match(html, /playing: !audio.paused \|\| !audioXF.paused/,
    `${platform}: Rich Presence stays playing during crossfade handoff`);
  assert.match(html, /if\(discordPresenceInFlight\)\{discordPresenceQueued=true;return;\}/,
    `${platform}: rapid state changes are coalesced instead of queued behind stale updates`);
  assert.match(html, /clearInterval\(discordPresenceTimer\)/,
    `${platform}: the retry timer is cleared when presence is disabled`);
  const pollingDefinition = html.indexOf('function startDiscordPolling()');
  const pollingStartup = html.indexOf('if(discordPresenceEnabled&&/^');
  assert.ok(pollingDefinition >= 0 && pollingStartup > pollingDefinition,
    `${platform}: polling functions exist before saved preferences start polling`);
  for (const key of [
    'Discord Rich Presence', 'Pokaż odtwarzany utwór na Discordzie',
    'Połączono z Discordem', 'Nie znaleziono Discorda — uruchom aplikację desktopową.'
  ]) {
    assert.match(html, new RegExp(`['"]${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]\\s*:\\s*\\{\\s*en:[^,]+,\\s*es:`),
      `${platform}: PL/EN/ES translation exists for ${key}`);
  }
  assert.match(html, /api\.update\(\{appId:discordApplicationId,title:player\.title,artist:player\.artist,playing:player\.playing,position:player\.pos,duration:player\.dur\}\)/,
    `${platform}: current player metadata and position are sent only when presence is enabled`);
  assert.match(html, /window\.addEventListener\('pagehide',[\s\S]*?api\.stop\(\)/,
    `${platform}: helper is stopped when the app page closes`);
  assert.match(desktop, /discordPresence:\s*\{ update: updateDiscordPresence, clear: clearDiscordPresence, stop: stopDiscordPresence \}/,
    `${platform}: desktop layer exposes update, clear and stop actions`);
  assert.match(desktop, /os\.spawnProcess/, `${platform}: Discord IPC client runs as a native helper process`);
  assert.match(desktop, /updateSpawnedProcess\([^\n]+'stdIn'/, `${platform}: helper commands use local process stdin, not a web service`);
  assert.match(desktop, /pulsar:discord-status/, `${platform}: helper connection errors reach the settings UI`);
  assert.match(html, /\['play','playing','pause','seeked','loadedmetadata','durationchange'\]/,
    `${platform}: playback changes immediately refresh Discord presence`);
  if (platform === 'Windows') {
    assert.match(html, /last pipe error:/, 'Windows: named-pipe diagnostics are shown in settings');
    assert.match(html, /Discord wykryto, ale uzgadnianie RPC nie powiodło się:/,
      'Windows: handshake failures are distinguished from missing pipes');
  }
  assert.doesNotMatch(desktop, /discord\.com\/api|discordapp\.com\/api|Authorization:\s*Bot/i,
    `${platform}: no bot credentials or Discord web API calls are introduced`);

  const source = platform === 'Linux' ? 'discord-rpc.py' : 'discord-rpc.ps1';
  assert.ok(fs.existsSync(path.join(root, platform, 'resources', source)), `${platform}: IPC helper source is present`);
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for (let i = 0; i < inline.length; i++) {
    const result = spawnSync('node', ['--check'], { input: inline[i][1], encoding: 'utf8' });
    assert.equal(result.status, 0, `${platform}: inline script ${i} syntax: ${result.stderr}`);
  }
  const syntax = spawnSync('node', ['--check', path.join(root, platform, 'resources', 'desktop.js')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${platform}: desktop bridge syntax: ${syntax.stderr}`);
  console.log(`${platform}: Discord Rich Presence configuration, privacy and bridge checks passed`);
}
