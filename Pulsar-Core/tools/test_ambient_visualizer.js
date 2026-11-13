#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const platform of ['Linux', 'Windows']) {
  const html = fs.readFileSync(path.join(__dirname, '..', platform, 'resources', 'index.html'), 'utf8');
  assert.match(html, /'uniform vec2 uOrigin;'/, `${platform}: shader exposes an album-origin uniform`);
  assert.match(html, /vec2 p = \(uv - uOrigin\) \* vec2\(aspect, 1\.0\) \* 2\.5/, `${platform}: shader coordinates radiate from the supplied origin`);
  assert.match(html, /vec2 wq = \(uv - uOrigin\) \* vec2\(aspect, 1\.0\)/, `${platform}: wave mode is anchored to the album too`);
  assert.match(html, /length\(\(uv - uOrigin\) \* vec2\(aspect, 1\.0\)/, `${platform}: vignette follows the album center`);
  assert.match(html, /float shellRadius = 0\.83 \+ petals \* 0\.105/, `${platform}: the new default scene forms an irregular album halo, not a circular equalizer`);
  assert.match(html, /float silk = exp\(-abs\(folds\) \* 10\.0\) \* exp\(-abs\(shellDelta\) \* 3\.2\);/, `${platform}: layered silk folds add moving depth behind the artwork`);
  assert.match(html, /float pulseWarp = 0\.12 \* sin\(a \* 3\.0 \+ field \* 3\.0\)/, `${platform}: outward pulses follow the organic halo instead of perfect circles`);
  assert.match(html, /float sourceBloom = exp\(-sourceR \* 2\.5\);/, `${platform}: the old universal hard pulse ring is removed`);
  assert.match(html, /const visualRevision = Number\(localStorage\.getItem\('ambientVisualRevision'\) \|\| 0\);/, `${platform}: existing users are switched to the redesigned visualizer once`);
  assert.match(html, /localStorage\.setItem\('ambientVisualMode', '0'\)/, `${platform}: the redesign becomes the selected style on upgrade`);
  assert.match(html, /vec3 lifted = c \/ max\(m, 0\.28\) \* 0\.82;/, `${platform}: extracted cover colors keep their natural saturation`);
  assert.match(html, /const coverRect=coverWrap\.getBoundingClientRect\(\)/, `${platform}: origin follows the live album-cover position`);
  assert.match(html, /originX\+=\(targetOriginX-originX\)\*originEase/, `${platform}: the origin follows cover motion smoothly`);
  assert.match(html, /gl\.uniform2f\(U\.uOrigin, originX, originY\)/, `${platform}: cover center is sent to the GPU each frame`);
  console.log(`${platform}: album-centered visualizer checks passed`);
}
