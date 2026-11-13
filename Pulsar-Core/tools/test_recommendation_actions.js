#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const platform of ['Linux', 'Windows']) {
  const html = fs.readFileSync(path.join(__dirname, '..', platform, 'resources', 'index.html'), 'utf8');
  assert.match(html, /recommendation-play/, `${platform}: recommendations expose a listen control`);
  assert.match(html, /recommendation-download/, `${platform}: recommendations expose a download control`);
  assert.match(html, /play\.addEventListener\('click',function\(\)\{playRecommendation\(item,recommendationItems,itemIndex,play\);\}\)/, `${platform}: listen control starts main-player playback`);
  assert.match(html, /async function playOnlineYoutube\(/, `${platform}: online playback has a shared path`);
  const playback = html.match(/async function playOnlineYoutube\([\s\S]*?\n  function playRecommendation\(/);
  assert.ok(playback, `${platform}: shared main-player handler exists`);
  assert.match(playback[0], /audio\.src=resolved\.url/, `${platform}: YouTube streams use the main audio element`);
  assert.match(playback[0], /onlinePlaybackLoading=true;onlinePlaybackWantPlay=true[\s\S]*window\.__pulsarPendingPlay=false/, `${platform}: a new stream request invalidates pending local gesture retries`);
  assert.match(playback[0], /beginOnlinePlaybackGate\(\);[\s\S]*?await netYtStream\(id\)/, `${platform}: click activation is used synchronously before the slow stream lookup`);
  assert.match(html, /function beginOnlinePlaybackGate\(\)[\s\S]*?audio\.muted=true;audio\.loop=true;audio\.autoplay=true;audio\.src=ONLINE_PLAYBACK_GATE_SRC;audio\.load\(\);[\s\S]*?audio\.play\(\)/, `${platform}: a muted loop stops old audio and primes autoplay from the original click`);
  assert.match(playback[0], /audio\.addEventListener\('canplay',onlinePlaybackCanPlayHandler\)[\s\S]*?audio\.src=resolved\.url[\s\S]*?audio\.readyState>=3/, `${platform}: the selected stream starts only when buffered and playable`);
  assert.match(playback[0], /audio\.readyState<3/, `${platform}: premature end handling waits for the new stream to become ready`);
  assert.match(playback[0], /releaseOnlinePlaybackGate\(false,true\)[\s\S]*?audio\.src=resolved\.url/, `${platform}: gate looping stays enabled until the real stream replaces it`);
  assert.match(html, /audio\.addEventListener\('playing',[\s\S]*?onlinePlaybackStartedUrl=activeOnlineTrack\.streamUrl/, `${platform}: only a real online playing event marks the stream as started`);
  assert.match(html, /if\(onlinePlaybackLoading\)\{[\s\S]*?onlinePlaybackWantPlay=audio\.paused[\s\S]*?return;/, `${platform}: the main player button controls the pending online stream, not the silent gate`);
  assert.match(html, /audio\.addEventListener\('error',[\s\S]{0,220}if\(onlinePlaybackLoading\)return;[\s\S]{0,160}if\(activeOnlineTrack\)/, `${platform}: stream errors do not skip into or restart local tracks`);
  assert.match(html, /audio\.addEventListener\('ended',[\s\S]{0,260}if \(activeOnlineTrack\)/, `${platform}: online end handling is isolated from local repeat behavior`);
  assert.match(html, /onlinePlaybackStartedUrl!==activeOnlineTrack\.streamUrl/, `${platform}: stale gate-end events cannot be mistaken for a truncated online stream`);
  assert.match(html, /audio\.addEventListener\('timeupdate',[\s\S]*?onlinePlaybackStartedUrl=activeOnlineTrack\.streamUrl/, `${platform}: truncated-stream detection begins only after real playback advances`);
  assert.match(html, /expectedDuration>30&&audio\.currentTime<expectedDuration\*0\.75/, `${platform}: truncated YouTube streams are not looped back to the beginning`);
  assert.match(playback[0], /if\(token!==onlinePlaybackToken\)return/, `${platform}: stale play promises cannot affect a newer selection`);
  assert.match(playback[0], /currentIndex=-1/, `${platform}: online playback stays out of the local library`);
  assert.match(playback[0], /setCover\(activeOnlineTrack\.coverUrl\)/, `${platform}: online artwork is shown in the player`);
  assert.doesNotMatch(playback[0], /tracks\.push|persistTrack\(|toggleFav\(/, `${platform}: playing an online track does not save or favourite it`);
  assert.match(html, /if\(r\.provider==='youtube'\|\|r\.ytStream\)[\s\S]{0,120}playOnlineYoutube\(/, `${platform}: YouTube search uses main-player playback`);
  assert.match(html, /await netImport\(-1,download,recommendationAsNetResult\(item\)\)/, `${platform}: recommendations keep an explicit download action`);
  assert.match(html, /dataset\.act = 'download'/, `${platform}: the network plus action is now a download action`);
  assert.match(html, /async function netImport\(i, btnEl, overrideResult\)/, `${platform}: download reuses the existing importer`);
  assert.match(html, /coverAddBtn\.hidden=!!activeOnlineTrack/, `${platform}: online playback cannot be added to an album`);
  assert.match(html, /mv\.fav\.hidden = !!activeOnlineTrack/, `${platform}: online playback cannot be favourited`);
  console.log(`${platform}: For You listen/download checks passed`);
}
