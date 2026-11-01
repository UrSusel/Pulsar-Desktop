#!/usr/bin/env node
'use strict';
const assert = require('assert');
const dj = require('../dj-core.js');
const backup = require('../backup-core.js');
let failures = 0, count = 0;
function test(name, fn) { count++; try { fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + '\n  ' + e.stack); } }
const tracks = [
  { index: 0, id: 'a', title: 'Start', artist: 'A', album: 'Ambient', bpm: 100, rms: 0.1, plays: 4 },
  { index: 1, id: 'b', title: 'Calm', artist: 'B', album: 'Ambient', bpm: 98, rms: 0.04, plays: 2 },
  { index: 2, id: 'c', title: 'Energy', artist: 'C', album: 'Rock', bpm: 150, rms: 0.24, plays: 8 },
  { index: 3, id: 'd', title: 'Twin', artist: 'A', album: 'Other', bpm: 102, rms: 0.11, plays: 0, lastPlay: 0 },
  { index: 4, id: 'e', title: 'Focus', artist: 'D', album: 'Piano', bpm: 90, rms: 0.03, plays: 0, lastPlay: 0 }
];
const context = { currentIndex: 0, queue: [0, 1, 2, 3, 4], recent: [], history: [0], tracks };

test('DJ spokojny preferuje niską energię i umiarkowane tempo', () => {
  const hit = dj.select(context, { mood: 'calm', artistDiversity: 0, genreDiversity: 0 });
  assert.strictEqual(hit.index, 1); assert.match(hit.reason, /Spokojnie/);
});
test('DJ treningowy preferuje wysoką energię', () => {
  const hit = dj.select(context, { mood: 'workout', artistDiversity: 0, genreDiversity: 0 });
  assert.strictEqual(hit.index, 2); assert.match(hit.reason, /Trening/);
});
test('Więcej podobnych premiuje wykonawcę i tempo źródła', () => {
  const hit = dj.select(context, { mood: 'balance', artistDiversity: 0, genreDiversity: 0 }, { similar: true });
  assert.strictEqual(hit.index, 3); assert.match(hit.reason, /Więcej podobnych/);
});
test('100% różnorodności wykonawców omija powtórkę, gdy są alternatywy', () => {
  const hit = dj.select(context, { mood: 'similar', artistDiversity: 100, genreDiversity: 0 });
  assert.notStrictEqual(tracks[hit.index].artist, 'A');
});
test('100% różnorodności gatunków/albumów omija ten sam album', () => {
  const hit = dj.select(context, { mood: 'calm', artistDiversity: 0, genreDiversity: 100 });
  assert.notStrictEqual(tracks[hit.index].album, 'Ambient');
});
test('DJ odkrywanie premiuje nieodtwarzane utwory', () => {
  const hit = dj.select(context, { mood: 'discovery', artistDiversity: 0, genreDiversity: 0 });
  assert.strictEqual(tracks[hit.index].plays, 0);
});
test('historia ostatnich wyborów obniża wynik świeżego kandydata', () => {
  const first = dj.select(context, { mood: 'calm', artistDiversity: 0, genreDiversity: 0 });
  const next = dj.select(Object.assign({}, context, { recent: [first.index] }), { mood: 'calm', artistDiversity: 0, genreDiversity: 0 });
  assert.notStrictEqual(next.index, first.index);
});
test('tempoDistance akceptuje połowę i podwojenie BPM', () => {
  assert.strictEqual(dj.tempoDistance(90, 180), 0);
  assert.strictEqual(dj.tempoDistance(90, 45), 0);
});
test('ustawienia DJ są ograniczone i mają bezpieczne domyślne wartości', () => {
  assert.deepStrictEqual(dj.settingsOf({ mood: 'broken', artistDiversity: 500, genreDiversity: -2 }), { mood: 'balance', artistDiversity: 100, genreDiversity: 0 });
});
test('kopie są domyślnie tygodniowe i trzy wersje', () => {
  const s = backup.settingsOf();
  assert.strictEqual(s.intervalDays, 7); assert.strictEqual(s.keep, 3); assert.strictEqual(s.enabled, true); assert.strictEqual(s.safety, true);
});
test('harmonogram kopii respektuje interwał i wyłączenie', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  assert.strictEqual(backup.due({ lastRun: now - 8 * 86400000 }, now), true);
  assert.strictEqual(backup.due({ lastRun: now - 6 * 86400000 }, now), false);
  assert.strictEqual(backup.due({ enabled: false, lastRun: 0 }, now), false);
});
test('nazwy kopii są sortowalne i mają bezpieczny powód', () => {
  assert.strictEqual(backup.backupName(new Date(2026, 9, 25, 8, 9, 10), 'Przed restore!'), 'Pulsar-auto-20261025-080910-przed-restore.pulsarlib');
});
test('rotacja zostawia najnowsze N i zwraca starsze do usunięcia', () => {
  const names = ['Pulsar-auto-20260101-000000-a.pulsarlib', 'Pulsar-auto-20260401-000000-b.pulsarlib', 'Pulsar-auto-20260301-000000-c.pulsarlib', 'Pulsar-auto-20260201-000000-d.pulsarlib', 'Pulsar-manual.pulsarlib'];
  assert.deepStrictEqual(backup.rotationTargets(names, 3), ['Pulsar-auto-20260101-000000-a.pulsarlib']);
});
test('większa zmiana biblioteki jest wykrywana progowo', () => {
  assert.strictEqual(backup.isLargeChange(10, 100), true);
  assert.strictEqual(backup.isLargeChange(3, 10), true);
  assert.strictEqual(backup.isLargeChange(1, 4), false);
});
console.log('\n' + (count - failures) + '/' + count + ' testów Auto-DJ i kopii zaliczonych');
process.exitCode = failures ? 1 : 0;
