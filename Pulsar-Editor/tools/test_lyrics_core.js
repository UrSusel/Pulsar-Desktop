'use strict';
const assert = require('assert');
const { parseLRC, parseLyricsfile, parseLyricsPlus } = require('../lyrics-core.js');
let passed = 0;
function test(name, fn){ fn(); console.log('PASS ' + name); passed++; }
const lyricsfile = `version: "1.0"
metadata:
  title: Solo tú
  artist: DUVVII
lines:
  - text: Alguna vez yo esperé, por ti
    words:
      - text: "Alguna "
        start_ms: 22113
      - text: "vez "
        start_ms: 22972
      - text: "yo "
        start_ms: 23251
      - text: "esperé, "
        start_ms: 23564
      - text: "por "
        start_ms: 26444
      - text: ti
        start_ms: 26722
    start_ms: 22113
    end_ms: 27767
  - text: "It's 'solo' #1"
    words:
      - text: "It's "
        start_ms: 33721
      - text: "'solo' "
        start_ms: 34234
      - text: '#1'
        start_ms: 35000
    start_ms: 33721
plain: |-
  Alguna vez yo esperé, por ti
`;

test('LRCLIB Lyricsfile zachowuje tekst i prawdziwe czasy słów', () => {
  const lines = parseLyricsfile(lyricsfile);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].txt, 'Alguna vez yo esperé, por ti');
  assert.strictEqual(lines[0].t, 22.113);
  assert.strictEqual(lines[0].d, 5.654);
  assert.deepStrictEqual(lines[0].words[0], { t: 22.113, txt: 'Alguna ' });
  assert.deepStrictEqual(lines[0].words[5], { t: 26.722, txt: 'ti' });
  assert.strictEqual(lines[1].txt, "It's 'solo' #1");
  assert.strictEqual(lines[1].words[2].txt, '#1');
});

test('Lyricsfile zachowuje rzeczywiste czasy trwania linii i słów', () => {
  const lines = parseLyricsfile(`version: "1.0"\nlines:\n  - text: A B\n    words:\n      - text: "A "\n        start_ms: 1000\n        end_ms: 1400\n      - text: B\n        start_ms: 1400\n        duration_ms: 600\n    start_ms: 1000\n    end_ms: 2000\n`);
  assert.strictEqual(lines[0].d, 1);
  assert.deepStrictEqual(lines[0].words, [
    { t: 1, txt: 'A ', d: 0.4 }, { t: 1.4, txt: 'B', d: 0.6 }
  ]);
});

test('Enhanced LRC rozjaśnia słowa, ale txt pozostaje czysty', () => {
  const lines = parseLRC('[00:01.00]<00:01.10>A <00:01.40>man <00:01.80>that');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].txt, 'A man that');
  assert.deepStrictEqual(lines[0].words, [
    { t: 1.1, txt: 'A ' }, { t: 1.4, txt: 'man ' }, { t: 1.8, txt: 'that' }
  ]);
});

test('zwykły LRC i wiele znaczników linii działają jak wcześniej', () => {
  const lines = parseLRC('[ar:Test]\n[00:01.00][00:03.00] Ala ma kota\n[00:05.50]Ostatnia');
  assert.deepStrictEqual(lines, [
    { t: 1, txt: 'Ala ma kota' }, { t: 3, txt: 'Ala ma kota' }, { t: 5.5, txt: 'Ostatnia' }
  ]);
});

test('puste linie i tekst bez czasu są pomijane', () => {
  assert.deepStrictEqual(parseLRC('Wstęp\n[00:01.00]\n[00:02.00]  \n[00:03.00]Dobrze'), [{ t: 3, txt: 'Dobrze' }]);
});

test('uszkodzony Lyricsfile wraca do fallbacku zamiast zgadywać', () => {
  assert.deepStrictEqual(parseLyricsfile('version: "1.0"\nlines:\n  - text: "niezamknięty\n    start_ms: 1000'), []);
  assert.deepStrictEqual(parseLyricsfile(lyricsfile.replace('version: "1.0"', 'version: "9.0"')), []);
  assert.deepStrictEqual(parseLyricsfile(lyricsfile.replace('start_ms: 22113', 'start_ms: później')), []);
});

test('niezgodność słów z linią wyłącza tylko word-sync tej linii', () => {
  const broken = lyricsfile.replace('Alguna vez yo esperé, por ti\n    words:', 'Zupełnie inny tekst\n    words:');
  const lines = parseLyricsfile(broken);
  assert.strictEqual(lines[0].txt, 'Zupełnie inny tekst');
  assert.strictEqual(lines[0].words, undefined);
  assert.ok(lines[1].words.length);
});

test('limit rozmiaru chroni runtime przed ogromnym YAML', () => {
  assert.deepStrictEqual(parseLyricsfile('x'.repeat(257 * 1024)), []);
});

const lyricsPlusWord = {
  type: 'Word', metadata: { source: 'QQ Music' },
  lyrics: [{
    time: 30205, duration: 2398, text: 'I saw the fire in your eyes',
    syllabus: [
      { time: 30205, duration: 167, text: 'I ' },
      { time: 30372, duration: 209, text: 'saw ' },
      { time: 30581, duration: 198, text: 'the ' },
      { time: 30779, duration: 520, text: 'fire ' },
      { time: 31299, duration: 225, text: 'in ' },
      { time: 31524, duration: 328, text: 'your ' },
      { time: 31852, duration: 751, text: 'eyes' }
    ]
  }]
};

test('Lyrics+ konwertuje prawdziwe czasy Take My Breath z ms na sekundy', () => {
  const data = parseLyricsPlus(lyricsPlusWord);
  assert.strictEqual(data.wordSync, true);
  assert.strictEqual(data.plain, null);
  assert.strictEqual(data.synced.length, 1);
  assert.strictEqual(data.synced[0].t, 30.205);
  assert.strictEqual(data.synced[0].d, 2.398);
  assert.strictEqual(data.synced[0].txt, 'I saw the fire in your eyes');
  assert.deepStrictEqual(data.synced[0].words[0], { t: 30.205, txt: 'I ', d: 0.167 });
  assert.deepStrictEqual(data.synced[0].words[3], { t: 30.779, txt: 'fire ', d: 0.52 });
  assert.deepStrictEqual(data.synced[0].words[6], { t: 31.852, txt: 'eyes', d: 0.751 });
});

test('Lyrics+ Line pozostaje liniowy nawet przy dodatkowych polach', () => {
  const data = parseLyricsPlus({ ...lyricsPlusWord, type: 'Line' });
  assert.strictEqual(data.wordSync, false);
  assert.strictEqual(data.synced[0].words, undefined);
  assert.strictEqual(data.synced[0].t, 30.205);
});

test('Lyrics+ bez synchronizacji zwraca zwykły tekst', () => {
  assert.deepStrictEqual(parseLyricsPlus({ type: 'Static', lyrics: [{ text: 'Pierwsza' }, { text: ' ' }, { text: 'Druga' }] }), {
    synced: null, plain: ['Pierwsza', 'Druga'], wordSync: false
  });
});

test('Lyrics+ nie zgaduje brakujących czasów słów', () => {
  const data = parseLyricsPlus({ type: 'Word', lyrics: [{ time: 1000, text: 'A man', syllabus: [{ text: 'A ' }] }] });
  assert.strictEqual(data.wordSync, false);
  assert.deepStrictEqual(data.synced, [{ t: 1, txt: 'A man' }]);
  assert.strictEqual(parseLyricsPlus({ type: 'Word', lyrics: [{ text: 'Bez czasu' }] }), null);
});

test('Lyrics+ zachowuje odstęp przed głównym wokalem po chórku', () => {
  const data = parseLyricsPlus({ type: 'Word', lyrics: [{ time: 0, text: '(Yes) main', syllabus: [
    { time: 0, text: '(Yes)', isBackground: true }, { time: 100, text: 'main' }
  ] }] });
  assert.strictEqual(data.synced[0].txt, '(Yes) main');
  assert.deepStrictEqual(data.synced[0].words, [{ t: 0, txt: '(Yes) ' }, { t: 0.1, txt: 'main' }]);
});

console.log(`\n${passed}/${passed} testów parsera napisów zaliczonych.`);
