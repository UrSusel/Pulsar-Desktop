/* Testy słownika i odwołań do tłumaczeń bez uruchamiania aplikacji. */
'use strict';
const fs = require('fs');
const path = require('path');
const i18n = require('../i18n.js');

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  if (!ok) failures++;
}

const entries = Object.entries(i18n.dictionary);
check('każdy polski klucz ma angielskie i hiszpańskie tłumaczenie', entries.length > 300 && entries.every(([, value]) => value.en && value.es), entries.length);
check('polski pozostaje językiem źródłowym', i18n.t('Sprawdź aktualizacje', 'pl') === 'Sprawdź aktualizacje');
check('angielski i hiszpański tłumaczą statyczne etykiety', i18n.t('Sprawdź aktualizacje', 'en') === 'Check for updates' && i18n.t('Sprawdź aktualizacje', 'es') === 'Buscar actualizaciones');
check('nowa zakładka importu ma tłumaczenia PL/EN/ES', i18n.t('Import napisów', 'pl') === 'Import napisów' && i18n.t('Import napisów', 'en') === 'Import lyrics' && i18n.t('Import napisów', 'es') === 'Importar letra');
check('komunikat łączony tłumaczy prefiks i błąd natywny', i18n.message('Dopasowanie nie powiodło się: Plik audio nie istnieje', 'en') === 'Alignment failed: Audio file does not exist' && i18n.message('Dopasowanie nie powiodło się: Plik audio nie istnieje', 'es') === 'La sincronización falló: El archivo de audio no existe');
check('wyjaśnienie Auto-DJ tłumaczy fragmenty bez zmiany BPM', i18n.message('Spokojnie · 140 BPM · spokojniejsze brzmienie', 'en') === 'Calm · 140 BPM · calmer sound');

const files = [
  'Pulsar-Editor/audio-editor.js',
  'Pulsar-Extras/app-updates.js',
  'Pulsar-Extras/auto-dj.js',
  'Pulsar-Extras/library-backup.js',
  'Pulsar-Extras/desktop-bridge.js'
];
const missing = [];
const pattern = /\btr\(((?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"))\)/g;
for (const file of files) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  for (const match of source.matchAll(pattern)) {
    let key;
    try { key = Function('return ' + match[1])(); } catch (error) { continue; }
    if (!i18n.dictionary[key]) missing.push(file + ': ' + key);
  }
}
check('wszystkie odwołania tr() mają wpisy EN i ES', missing.length === 0, missing);

// Główny runtime ma osobne słowniki, ale korzysta też ze słownika Extras.
const corePath = path.join(__dirname, '..', '..', 'Pulsar-Core', 'Windows', 'resources', 'index.html');
const coreSource = fs.readFileSync(corePath, 'utf8');
const coreKeys = new Set(Object.keys(i18n.dictionary));
for (const name of ['I18N_DICT', 'I18N_STATIC']) {
  const block = new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n  \\};').exec(coreSource);
  if (!block) { missing.push('Nie znaleziono słownika ' + name); continue; }
  for (const match of block[1].matchAll(/^\s*('(?:\\.|[^'\\])*')\s*:/gm)) {
    try { coreKeys.add(Function('return ' + match[1])()); } catch (error) {}
  }
}
const untranslated = [];
const coreCallPattern = /\bt\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*\)/g;
for (const match of coreSource.matchAll(coreCallPattern)) {
  try {
    const key = Function('return ' + match[1])();
    if (!coreKeys.has(key)) untranslated.push(key);
  } catch (error) {}
}
check('wszystkie stałe etykiety t() głównego runtime są przetłumaczone', untranslated.length === 0, untranslated);

if (failures) {
  console.error('\n' + failures + ' testów tłumaczeń nie zaliczonych');
  process.exit(1);
}
console.log('\nWszystkie testy tłumaczeń zaliczone.');
