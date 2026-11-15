#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const platform of ['Linux', 'Windows']) {
  const html = fs.readFileSync(path.join(__dirname, '..', platform, 'resources', 'index.html'), 'utf8');
  const loadTrack = html.match(/async function loadTrack\(index, opts\)\{([\s\S]*?)\n  function nextTrack/);
  assert.ok(loadTrack, `${platform}: local track loader exists`);
  const playAt = loadTrack[1].indexOf('if (opts.autoplay) tryPlayWithGesture();');
  const metadataAt = loadTrack[1].indexOf('await ensureTrackMeta(track)');
  assert.ok(playAt >= 0 && metadataAt > playAt,
    `${platform}: local audio starts in the click activation before metadata work can consume it`);
  assert.match(loadTrack[1], /try \{ await ensureTrackMeta\(track\); \}\s*catch\(e\)/,
    `${platform}: a metadata failure does not prevent playback or reject the track load`);
  assert.match(html, /const isLinux=\/Linux\/i\.test\(navigator\.platform \|\| navigator\.userAgent \|\| ''\);/,
    `${platform}: Linux decoder failures are detected from the runtime platform`);
  assert.match(html, /Linux\/WebKit nie obsłużył pliku \(format lub kodek\)/,
    `${platform}: Linux users get an actionable WebKit/GStreamer diagnosis`);
  assert.match(html, /showToast\(detail,10000\)/,
    `${platform}: the codec diagnosis remains visible long enough to read`);
  assert.match(html, /mp3:'audio\/mpeg'[\s\S]*m4a:'audio\/mp4'/,
    `${platform}: common audio formats receive canonical MIME types`);
  assert.match(html, /file: normalizeAudioFile\(new File\(\[item\.blob\]/,
    `${platform}: older library entries are corrected by filename when restored`);
  const importFilter = html.match(/function isAppleDoubleSidecar\(fileOrPath\)\{[\s\S]*?function isImportableAudioFile\(file\)\{[\s\S]*?\n  \}/);
  assert.ok(importFilter, `${platform}: local imports identify macOS AppleDouble sidecars`);
  const importChecks = new Function('AUDIO_EXT_RE', `${importFilter[0]}; return { isAppleDoubleSidecar, isImportableAudioFile };`)(/\.(mp3|wav|flac)$/i);
  assert.equal(importChecks.isImportableAudioFile({ name: '._01 death bed.mp3' }), false,
    `${platform}: AppleDouble audio lookalikes are not imported as playable tracks`);
  assert.equal(importChecks.isImportableAudioFile({ name: '01 death bed.mp3', webkitRelativePath: 'Album/01 death bed.mp3' }), true,
    `${platform}: the real audio file beside a sidecar is still imported`);
  assert.equal(importChecks.isAppleDoubleSidecar('Album/__MACOSX/._01 death bed.mp3'), true,
    `${platform}: AppleDouble archive folders are ignored`);
  assert.match(html, /const audioFiles = files\.filter\(isImportableAudioFile\)/,
    `${platform}: library import excludes sidecars before saving them`);
  assert.match(html, /tracks = storedTracks\.filter\(item => !isAppleDoubleSidecar\(String\(item\.folder \|\| ''\) \+ '\/' \+ String\(item\.name \|\| ''\)\)\)\.map/,
    `${platform}: already-stored sidecars are hidden on restore without deleting library data`);
  assert.match(html, /Pominięto pomocnicze pliki macOS; dodaj oryginalne pliki audio, jeśli utworów brakuje\./,
    `${platform}: users are told how to restore the real tracks after sidecars are skipped`);
  assert.match(html, /files\.some\(isImportableAudioFile\)/,
    `${platform}: file-picker and drag-drop gates use the same playable-file filter`);
  const desktopJs = fs.readFileSync(path.join(__dirname, '..', platform, 'resources', 'desktop.js'), 'utf8');
  assert.match(desktopJs, /function isAppleDoublePath\(/,
    `${platform}: the native watched-folder scanner recognizes AppleDouble paths`);
  assert.match(desktopJs, platform === 'Linux' ? /if \(isAppleDoublePath\(path\)\) continue;/ : /isAppleDoublePath\(p\) \|\| !AUDIO\.test\(p\)/,
    `${platform}: the native watched-folder scanner skips AppleDouble sidecars`);
  assert.match(loadTrack[1], /URL\.createObjectURL\(normalizeAudioFile\(track\.file\)\)/,
    `${platform}: playback uses a codec-friendly Blob type`);
  assert.match(loadTrack[1], /audio\.src = sourceUrl;\s*audio\.load\(\);/,
    `${platform}: local playback explicitly reloads the media pipeline`);
  assert.match(loadTrack[1], /audio\.addEventListener\('loadedmetadata', localTrackMetadataHandler\);/,
    `${platform}: local timeline readiness follows metadata for the selected source`);
  assert.ok(loadTrack[1].indexOf('localTrackMetadataReady = true;') < loadTrack[1].indexOf('audio.currentTime = 0'),
    `${platform}: any position reset occurs only after new-source metadata`);
  assert.match(html, /audio\.duration && \(activeOnlineTrack \|\| localTrackMetadataReady\) && !seeking/,
    `${platform}: time-based controls wait for metadata from the active local source`);
  assert.doesNotMatch(loadTrack[1], /revokeObjectURL\(previousLocalAudioUrl\)/,
    `${platform}: old media Blob URLs are not revoked while WebKit may still range-read them`);
  const promote = html.match(/function promoteCrossfaded\(\)\{([\s\S]*?)\n  \}\n\n  \/\* ---- Gapless:/);
  assert.ok(promote, `${platform}: crossfade promotion handler exists`);
  assert.match(promote[1], /audio\.src = src; audio\.load\(\);/,
    `${platform}: promoted gapless source is explicitly loaded by the main player`);
  assert.match(promote[1], /\(audio\.currentSrc \|\| audio\.src\) === src && audio\.readyState >= 1/,
    `${platform}: handoff waits for metadata from the new source, not the previous track`);
  assert.match(loadTrack[1], /curTimeEl\.textContent = formatTime\(0\);[\s\S]*?durTimeEl\.textContent = '--:--'/,
    `${platform}: selecting a new song clears the previous song's seek times`);
  assert.match(html, /mediaInfo=failedTrack&&failedTrack\.file/,
    `${platform}: the Linux error includes the exact filename`);
  assert.match(html, /failedTrack\.file\.type\|\|'brak MIME'/,
    `${platform}: the Linux error includes the detected MIME type`);

  assert.match(html, /const maxPixels = 1280 \* 720;/,
    `${platform}: the GPU visualizer has a fixed pixel budget on high-DPI displays`);
  assert.match(html, /if\(now-lastFrame<1000\/30\)return;/,
    `${platform}: shader rendering is capped at 30 frames per second`);
  assert.match(html, /localStorage\.setItem\('ambientVisualMode', '0'\)/,
    `${platform}: users switch to the new visualizer after updating`);
  console.log(`${platform}: local playback and visualizer stability checks passed`);
}
