#!/usr/bin/env node
'use strict';
const assert = require('assert');
const core = require('../editor-core.js');
let checks = 0;
function test(name, fn) {
  try { fn(); checks++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + '\n  ' + error.stack); process.exitCode = 1; }
}
function near(actual, expected, epsilon = 1e-6) { assert(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }
function bufferFrom(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    duration: channels[0].length / sampleRate,
    getChannelData(index) { return channels[index]; }
  };
}

test('normalizeCuts odrzuca błędne i scala nachodzące zakresy', () => {
  assert.deepStrictEqual(core.normalizeCuts([
    { start: 6, end: 3 }, { start: 4, end: 7 }, { start: 1, end: 2 },
    { start: 1.5, end: 3 }, { start: -2, end: 0.5 }, { start: 8, end: 20 }
  ], 10), [
    { start: 0, end: 0.5 }, { start: 1, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 10 }
  ]);
});

test('keptSegments i editedDuration zwracają dopełnienie cięć', () => {
  const cuts = [{ start: 2, end: 4 }, { start: 7, end: 8 }];
  assert.deepStrictEqual(core.keptSegments(10, cuts), [{ start: 0, end: 2 }, { start: 4, end: 7 }, { start: 8, end: 10 }]);
  near(core.editedDuration(10, cuts), 7);
});

test('mapTime zachowuje granice i usuwa czas wewnątrz wycinka', () => {
  const cuts = [{ start: 2, end: 4 }, { start: 6, end: 7 }];
  near(core.mapTime(1, cuts, 10), 1);
  assert.strictEqual(core.mapTime(2, cuts, 10), null);
  assert.strictEqual(core.mapTime(3.9, cuts, 10), null);
  near(core.mapTime(4, cuts, 10), 2);
  near(core.mapTime(8, cuts, 10), 5);
});

test('shiftLyrics nie modyfikuje źródła, opóźnia i przyspiesza tekst', () => {
  const source = [{ t: 4, txt: 'B' }, { t: 1, txt: 'A' }];
  const shifted = core.shiftLyrics(source, 0.5);
  assert.deepStrictEqual(shifted, [{ t: 1.5, txt: 'A' }, { t: 4.5, txt: 'B' }]);
  assert.strictEqual(source[0].t, 4);
  assert.deepStrictEqual(core.shiftLyrics([{ t: 0.2, txt: 'A' }], -1), [{ t: 0, txt: 'A' }]);
});

test('częściowe dopasowanie scala tylko wybrany zakres i zachowuje słowa', () => {
  const source = [
    { t: 1, txt: 'przed', words: [{ t: 1, txt: 'przed', d: 0.4 }] },
    { t: 2.5, txt: 'środek', words: [{ t: 2.5, txt: 'środek', d: 0.4 }] },
    { t: 5, txt: 'po', words: [{ t: 5, txt: 'po', d: 0.4 }] }
  ];
  assert.deepStrictEqual(core.lyricsTextsInRange(source, 2, 4, 0), ['środek']);
  const merged = core.mergeLyricsRange(source, [{ t: 3, txt: 'środek', words: [{ t: 3, txt: 'środek', d: 0.6 }] }], 2, 4, 0);
  assert.deepStrictEqual(merged.map(line => line.t), [1, 3, 5]);
  assert.strictEqual(merged[0].words[0].d, 0.4);
  assert.strictEqual(merged[2].words[0].d, 0.4);
  assert.strictEqual(source[1].t, 2.5);
});

test('szczegółowe przesunięcie zachowuje czasy słów, a pierwszy czas wybiera słowo', () => {
  const source = [{ t: 4, txt: 'B', words: [{ t: 4.2, txt: 'B', d: 0.3 }] }, { t: 1, txt: 'A' }];
  const shifted = core.shiftLyricsDetailed(source, 0.5);
  assert.strictEqual(shifted[1].words[0].t, 4.7);
  assert.strictEqual(shifted[1].words[0].d, 0.3);
  assert.strictEqual(source[0].words[0].t, 4.2);
  assert.strictEqual(core.firstLyricsTime(source), 1);
  assert.strictEqual(core.firstLyricsTime([source[0]]), 4.2);
  const preview = core.shiftLyricsDetailed([{ t: 1, txt: 'A', words: [{ t: 1.2, txt: 'A' }] }], -1.25, false);
  assert.strictEqual(preview[0].t, -0.25);
  assert.strictEqual(preview[0].words[0].t, -0.05);
});

test('remapLyrics stosuje offset, skraca oś i pomija tekst z wycinka', () => {
  const lines = [{ t: 1, txt: 'przed' }, { t: 2.5, txt: 'w ciszy' }, { t: 4, txt: 'po' }, { t: 6, txt: 'koniec' }];
  const out = core.remapLyrics(lines, [{ start: 2, end: 4 }], 0.5, 8);
  assert.deepStrictEqual(out, [{ t: 1.5, txt: 'przed' }, { t: 2.5, txt: 'po' }, { t: 4.5, txt: 'koniec' }]);
  // Linia dokładnie na końcu wycinka zostaje i trafia na złączenie.
  assert.deepStrictEqual(core.remapLyrics([{ t: 4, txt: 'po' }], [{ start: 2, end: 4 }], 0, 8), [{ t: 2, txt: 'po' }]);
});

test('formatLRC zapisuje setne sekundy i znak nowej linii', () => {
  assert.strictEqual(core.formatLRC([{ t: 61.239, txt: ' test ' }]), '[01:01.24] test\n');
  assert.strictEqual(core.lrcTimestamp(0), '00:00.00');
});

test('detectSilence znajduje osobne ciche zakresy, nie ciche nuty ponad progiem', () => {
  const sr = 1000;
  const samples = new Float32Array(sr * 4);
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    samples[i] = (t < 0.5 || (t >= 1.5 && t < 2.5) || t >= 3.5) ? 0.2 : 0;
  }
  const found = core.detectSilence(bufferFrom([samples], sr), { db: -45, minDuration: 0.5, padding: 0, window: 0.02 });
  assert.strictEqual(found.length, 2);
  near(found[0].start, 0.5); near(found[0].end, 1.5);
  near(found[1].start, 2.5); near(found[1].end, 3.5);
});

test('waveformPeaks bierze maksimum wszystkich kanałów', () => {
  const buffer = bufferFrom([new Float32Array([0, .2, -.4, .1]), new Float32Array([.5, 0, .1, -.8])], 4);
  const peaks = core.waveformPeaks(buffer, 2);
  near(peaks[0], .5); near(peaks[1], .8);
});

test('renderCutWav tworzy poprawny PCM 16-bit i skleja właściwe próbki', () => {
  const sr = 1000;
  const left = new Float32Array(sr * 4);
  const right = new Float32Array(sr * 4);
  for (let i = 0; i < left.length; i++) {
    left[i] = i < 2000 ? 0.5 : -0.25;
    right[i] = 0.125;
  }
  const wav = core.renderCutWav(bufferFrom([left, right], sr), [{ start: 1, end: 2 }, { start: 3, end: 3.5 }], { fadeMs: 0 });
  const view = new DataView(wav);
  assert.strictEqual(wav.byteLength, 44 + 2500 * 2 * 2);
  assert.strictEqual(String.fromCharCode(...new Uint8Array(wav, 0, 4)), 'RIFF');
  assert.strictEqual(String.fromCharCode(...new Uint8Array(wav, 8, 4)), 'WAVE');
  assert.strictEqual(view.getUint16(22, true), 2);
  assert.strictEqual(view.getUint32(24, true), sr);
  assert.strictEqual(view.getUint32(40, true), 10000);
  assert.strictEqual(view.getInt16(44, true), 16384); // 0,5 * 32768
  assert.strictEqual(view.getInt16(46, true), 4096);  // 0,125 * 32768
  const joinedOffset = 44 + 1000 * 4; // po pierwszej zachowanej sekundzie
  assert.strictEqual(view.getInt16(joinedOffset, true), -8192); // próbka 2000: -0,25
});

test('renderCutWav wygładza wewnętrzne złączenie i odrzuca pusty wynik', () => {
  const sr = 1000;
  const samples = new Float32Array(sr * 3).fill(0.8);
  const wav = core.renderCutWav(bufferFrom([samples], sr), [{ start: 1, end: 2 }], { fadeMs: 5 });
  const view = new DataView(wav);
  const joinedOffset = 44 + 1000 * 2;
  assert.strictEqual(view.getInt16(joinedOffset, true), 0);
  assert.throws(() => core.renderCutWav(bufferFrom([samples], sr), [{ start: 0, end: 3 }]), /EMPTY_OUTPUT/);
});

test('regulowany próg i minimalna długość wpływają na wykrywanie ciszy', () => {
  const sr = 1000;
  const samples = new Float32Array(sr * 3);
  samples.fill(0.2, 0, 1000); samples.fill(0.001, 1000, 2000); samples.fill(0.2, 2000);
  assert.strictEqual(core.detectSilence(bufferFrom([samples], sr), { db: -45, minDuration: 1.1, padding: 0 }).length, 0);
  assert.strictEqual(core.detectSilence(bufferFrom([samples], sr), { db: -45, minDuration: 0.9, padding: 0 }).length, 1);
  assert.strictEqual(core.detectSilence(bufferFrom([samples], sr), { db: -100, minDuration: 0.9, padding: 0 }).length, 0);
});

test('fade-in i fade-out działają także bez wycinków', () => {
  const sr = 1000;
  const samples = new Float32Array(sr).fill(0.8);
  const wav = core.renderCutWav(bufferFrom([samples], sr), [], { fadeInMs: 100, fadeOutMs: 100, joinFadeMs: 0 });
  const view = new DataView(wav);
  assert.strictEqual(view.getInt16(44, true), 0);
  assert(view.getInt16(44 + 50 * 2, true) > 10000 && view.getInt16(44 + 50 * 2, true) < 20000);
  assert.strictEqual(view.getInt16(wav.byteLength - 2, true), 0);
});

test('FFmpeg otrzymuje segmenty, przejścia, kodek i metadane jako osobne argumenty', () => {
  const args = core.buildFfmpegArgs({ inputPath: '/tmp/wejście audio.mp3', outputPath: '/tmp/wynik.flac', format: 'flac', duration: 10, segments: [{ start: 0, end: 4 }, { start: 5, end: 10 }], fadeInMs: 100, fadeOutMs: 200, joinFadeMs: 20, title: 'Tytuł', artist: 'Artysta' });
  assert(args.includes('/tmp/wejście audio.mp3')); assert(args.includes('/tmp/wynik.flac'));
  assert(args.includes('flac')); assert(args.includes('title=Tytuł')); assert(args.includes('artist=Artysta'));
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert(filter.includes('atrim=start=0.0:end=4.0')); assert(filter.includes('concat=n=2:v=0:a=1[out]'));
  assert(filter.includes('afade=t=in:st=0:d=0.1')); assert(filter.includes('afade=t=out:st=4.8:d=0.2'));
  assert.strictEqual(core.buildFfmpegArgs({ inputPath: 'a', outputPath: 'b', format: 'mp3', duration: 1 }).includes('libmp3lame'), true);
});

test('nazwy plików są bezpieczne i obsługują WAV, MP3 oraz FLAC', () => {
  assert.strictEqual(core.editedFileName('a:b/c?.mp3'), 'a_b_c_ (edycja).wav');
  assert.strictEqual(core.editedFileName('a.wav', ' (edycja)', 'mp3'), 'a (edycja).mp3');
  assert.strictEqual(core.editedFileName('a.wav', ' (edycja)', 'flac'), 'a (edycja).flac');
  assert.strictEqual(core.safeFileName('  a  b  '), 'a b');
});

console.log(`\n${checks} testów logiki edytora zakończonych.`);
