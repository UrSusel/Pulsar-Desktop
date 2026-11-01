/* Pulsar — zaplanowane kopie, rotacja i migawki przed ryzykownymi zmianami. */
(function () {
  'use strict';
  const player = window.__player;
  const core = window.PulsarBackupCore;
  const tools = window.__pulsarDesktopTools;
  if (!player || !player.__backup || !core || typeof document === 'undefined') return;

  const KEY = 'pulsarAutoBackup';
  let config = load();
  let busy = null;
  let lastError = '';
  let ui = {};

  function load() { try { return core.settingsOf(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return core.settingsOf(); } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(config)); } catch (e) {} }
  function toast(text) { try { if (window.__pulsarHost) window.__pulsarHost.toast(text); } catch (e) {} }
  function el(id) { return document.getElementById(id); }
  function dateText(value) { try { return value ? new Date(value).toLocaleString() : 'jeszcze nie utworzono'; } catch (e) { return ''; } }
  function entryName(entry) { return String(entry && (entry.entry != null ? entry.entry : entry.name) || ''); }

  function build() {
    if (el('pulsarAutoBackup')) return;
    const oldButton = el('smBackupBtn');
    const oldCard = oldButton && oldButton.closest('.sm-card');
    if (!oldCard || !oldCard.parentNode) return;
    const card = document.createElement('section');
    card.className = 'sm-card pab-card';
    card.id = 'pulsarAutoBackup';
    card.innerHTML = `
      <h3 class="sm-cap">Automatyczne kopie i bezpieczeństwo</h3>
      <div class="sm-row"><div class="sm-txt"><span class="sm-lab">Zaplanowana kopia .pulsarlib</span><span class="sm-desc">Co tydzień, w tle; bez wysyłania danych do sieci</span></div><label class="switch"><input type="checkbox" id="pabEnabled"><span class="slider"></span></label></div>
      <div class="pab-grid"><label>Częstotliwość<select class="sm-select" id="pabInterval"><option value="1">Codziennie</option><option value="7">Co tydzień</option><option value="30">Co 30 dni</option></select></label><label>Zachowaj wersji<input class="sm-select" id="pabKeep" type="number" min="1" max="10" step="1"></label></div>
      <div class="sm-row"><div class="sm-txt"><span class="sm-lab">Migawka przed restore i większymi zmianami</span><span class="sm-desc">Także przed usunięciem jedynej kopii utworu</span></div><label class="switch"><input type="checkbox" id="pabSafety"><span class="slider"></span></label></div>
      <div class="pab-folder"><span id="pabFolder">Folder domyślny</span><div><button type="button" class="sm-mini" id="pabFolderBtn">Wybierz folder…</button><button type="button" class="sm-mini" id="pabFolderReset" title="Użyj folderu domyślnego">Domyślny</button></div></div>
      <div class="sm-btn-row"><button type="button" class="sm-btn" id="pabNow">Utwórz migawkę teraz</button></div>
      <div class="pab-status" id="pabStatus" aria-live="polite"></div>`;
    oldCard.parentNode.insertBefore(card, oldCard.nextSibling);
    ui = { enabled: el('pabEnabled'), safety: el('pabSafety'), interval: el('pabInterval'), keep: el('pabKeep'), folder: el('pabFolder'), status: el('pabStatus'), now: el('pabNow') };
    ui.enabled.addEventListener('change', function () { config.enabled = ui.enabled.checked; changed(); });
    ui.safety.addEventListener('change', function () { config.safety = ui.safety.checked; changed(); });
    ui.interval.addEventListener('change', function () { config.intervalDays = Number(ui.interval.value); changed(); });
    ui.keep.addEventListener('change', function () { config.keep = Number(ui.keep.value); changed(); });
    el('pabFolderBtn').addEventListener('click', chooseFolder);
    el('pabFolderReset').addEventListener('click', function () { config.folder = ''; changed(); });
    ui.now.addEventListener('click', function () { snapshot('manual').then(function (result) { if (result && !result.skipped) toast('Migawka zapisana: ' + result.name); }).catch(showError); });
    refresh();
    if (tools && tools.available && !config.folder) tools.defaultBackupDirectory().then(function (path) { if (ui.folder && !config.folder) ui.folder.textContent = path + ' (domyślny)'; }).catch(function () {});
  }
  function changed() { config = core.settingsOf(config); save(); refresh(); }
  function refresh() {
    if (!ui.enabled) return;
    ui.enabled.checked = config.enabled; ui.safety.checked = config.safety;
    ui.interval.value = String(config.intervalDays); ui.keep.value = String(config.keep);
    ui.folder.textContent = config.folder || ui.folder.textContent || 'Folder domyślny';
    ui.folder.title = config.lastPath || config.folder;
    ui.status.classList.toggle('pab-error', !!lastError);
    ui.status.textContent = lastError ? 'Błąd: ' + lastError : 'Ostatnia kopia: ' + dateText(config.lastRun) + (config.lastPath ? '\n' + config.lastPath : '');
    ui.now.disabled = !!busy || !(tools && tools.available);
    if (!(tools && tools.available)) ui.status.textContent = 'Automatyczne kopie wymagają wersji desktopowej Pulsara.';
  }
  async function chooseFolder() {
    if (!tools || !tools.available) return;
    try { const path = await tools.fs.folderDialog('Wybierz folder automatycznych kopii Pulsara'); if (path) { config.folder = String(path); changed(); } }
    catch (e) { showError(e); }
  }
  function showError(error) { lastError = String(error && error.message || error); refresh(); toast('Nie udało się utworzyć kopii: ' + lastError); }

  async function rotate(folder) {
    const entries = await tools.fs.list(folder);
    const names = (entries || []).filter(function (entry) { return !entry.type || entry.type === 'FILE'; }).map(entryName).filter(core.isBackupName);
    const versions = [];
    for (const name of names) {
      let modified = 0;
      try { const stat = await tools.fs.stats(tools.fs.join(folder, name)); modified = Number(stat && stat.modifiedAt) || 0; } catch (e) {}
      versions.push({ name: name, modified: modified });
    }
    versions.sort(function (a, b) { return b.modified - a.modified || b.name.localeCompare(a.name); });
    const remove = versions.slice(config.keep).map(function (item) { return item.name; });
    for (const name of remove) { try { await tools.fs.remove(tools.fs.join(folder, name)); } catch (e) {} }
    return remove;
  }
  async function writeSnapshot(reason) {
    if (!tools || !tools.available) throw new Error('natywny system plików nie jest dostępny');
    const folder = config.folder || await tools.defaultBackupDirectory();
    if (!await tools.fs.mkdir(folder)) throw new Error('nie mogę utworzyć folderu kopii');
    const backup = await player.__backup.build();
    if (!backup.tracks && !backup.albums) return { skipped: true, reason: 'empty' };
    let name = core.backupName(new Date(), reason);
    let path = tools.fs.join(folder, name);
    for (let suffix = 1; await tools.fs.exists(path); suffix++) {
      name = core.backupName(new Date(), reason).replace(/\.pulsarlib$/i, '-' + suffix + '.pulsarlib');
      path = tools.fs.join(folder, name);
    }
    try {
      await tools.fs.write(path, backup.head);
      for (const blob of backup.blobs) {
        for (let offset = 0; offset < blob.size; offset += 8388608) {
          const bytes = await blob.slice(offset, Math.min(blob.size, offset + 8388608)).arrayBuffer();
          await tools.fs.append(path, bytes);
        }
      }
      let removed = [], rotationError = '';
      try { removed = await rotate(folder); } catch (error) { rotationError = 'Kopia została zapisana, ale rotacja nie powiodła się: ' + String(error && error.message || error); }
      config.lastRun = Date.now(); config.lastPath = path; config.folder = config.folder || '';
      lastError = rotationError; save(); refresh();
      return { path: path, name: name, size: backup.total, tracks: backup.tracks, albums: backup.albums, rotated: removed.length, rotationError: rotationError };
    } catch (error) {
      try { await tools.fs.remove(path); } catch (e) {}
      throw error;
    }
  }
  function snapshot(reason) {
    if (busy) return busy;
    busy = writeSnapshot(reason || 'manual').catch(function (error) { lastError = String(error && error.message || error); refresh(); throw error; });
    refresh();
    return busy.then(function (result) { busy = null; refresh(); return result; }, function (error) { busy = null; refresh(); throw error; });
  }
  async function maybeScheduled() {
    if (!core.due(config, Date.now()) || !(tools && tools.available)) return { skipped: true };
    try { return await snapshot('scheduled'); }
    catch (error) { console.warn('Pulsar auto-backup', error); return { skipped: true, error: String(error && error.message || error) }; }
  }
  async function allowAfterSnapshot(reason) {
    if (!config.safety) return true;
    try {
      const result = await snapshot(reason);
      if (result && !result.skipped) toast('Utworzono migawkę bezpieczeństwa: ' + result.name);
      return true;
    } catch (error) {
      return window.confirm('Nie udało się utworzyć migawki bezpieczeństwa (' + String(error && error.message || error) + ').\n\nKontynuować operację mimo to?');
    }
  }
  async function uniqueTracks(removed) {
    const unique = [];
    for (const track of removed || []) {
      if (!track.srcPath) { unique.push(track); continue; }
      if (tools && tools.available) {
        try { if (!await tools.fs.exists(track.srcPath)) unique.push(track); } catch (e) { unique.push(track); }
      }
    }
    return unique;
  }
  async function beforeRemove(removed, context) {
    const unique = await uniqueTracks(removed);
    let message = 'Usunąć ' + (removed.length === 1 ? '1 utwór' : removed.length + ' utworów') + ' z biblioteki?';
    if (unique.length) {
      const names = unique.slice(0, 3).map(function (track) { return '• ' + (track.title || (track.file && track.file.name) || 'Utwór'); }).join('\n');
      message = 'UWAGA: ' + (unique.length === 1 ? 'plik tego utworu istnieje tylko w bibliotece' : 'pliki ' + unique.length + ' utworów istnieją tylko w bibliotece') + '.\nUsunięcie może bezpowrotnie skasować jedyną kopię.\n\n' + names + (unique.length > 3 ? '\n…' : '') + '\n\nCzy na pewno kontynuować?';
    }
    if (!window.confirm(message)) return false;
    const large = core.isLargeChange(removed.length, context && context.total);
    return large || unique.length ? allowAfterSnapshot(unique.length ? 'before-unique-remove' : 'before-library-change') : true;
  }
  async function beforeChange(removed, context) {
    if (!core.isLargeChange((removed || []).length, context && context.total)) return true;
    return allowAfterSnapshot(context && context.kind === 'dedupe' ? 'before-dedupe' : 'before-library-change');
  }

  window.__pulsarLibraryGuard = {
    beforeRemove: beforeRemove,
    beforeChange: beforeChange,
    beforeRestore: function () { return allowAfterSnapshot('before-restore'); }
  };
  window.PulsarBackups = {
    state: function () { return Object.assign({}, config, { busy: !!busy, error: lastError, available: !!(tools && tools.available) }); },
    set: function (value) { config = core.settingsOf(Object.assign({}, config, value)); save(); refresh(); },
    snapshot: snapshot,
    maybeScheduled: maybeScheduled,
    rotate: rotate,
    refresh: refresh
  };

  build();
  refresh();
  setTimeout(maybeScheduled, 15000);
  setInterval(maybeScheduled, 21600000);
})();
