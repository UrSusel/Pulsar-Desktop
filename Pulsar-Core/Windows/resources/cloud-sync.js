/* Pulsar — warstwa synchronizacji dla Windows i Linuksa (Neutralino).
 *
 * Rejestruje window.__pulsarSyncAdapter, czyli ten sam kontrakt, którego na
 * Androidzie używa PulsarFolderPlugin: odczyt wszystkich plików biblioteki
 * z folderu i zapis wyłącznie własnego (`pulsar-library-windows.json`,
 * `pulsar-library-linux.json`…).
 *
 * Każde urządzenie pisze tylko swój plik, więc żadne nie może nadpisać
 * biblioteki drugiego — nawet gdy Drive przez chwilę nie pokaże zawartości
 * folderu. Biblioteka jest sumą tych plików, czytaną przez wszystkie platformy
 * (Android czyta pulsar-library-android.json i pliki komputerów).
 *
 * Neutralino nie ma gniazd sieciowych, więc logowanie OAuth (które wymaga
 * przekierowania na localhost) nie jest tu dostępne; adapter zgłasza to jako
 * supportsGoogle: false, a panel chowa kartę Google.
 */
(function () {
  'use strict';

  if (typeof Neutralino === 'undefined') return;

  var FILE_NAME = 'pulsar-library.json';
  var FILE_PREFIX = 'pulsar-library';
  var MAX_FILES = 8;
  var KEY_PATH = 'pulsarSyncFolder';
  var KEY_ERROR = 'pulsarSyncFolderError';

  function isLibraryFile(name) {
    var text = String(name || '');
    return text.indexOf(FILE_PREFIX) === 0 && text.slice(-5) === '.json';
  }

  /** Nazwa z żądania, ale wyłącznie w obrębie wzorca plików biblioteki. */
  function safeName(name) {
    var cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (cleaned.indexOf(FILE_PREFIX) !== 0 || cleaned.slice(-5) !== '.json') return FILE_NAME;
    return cleaned;
  }

  function store(key) {
    try { return localStorage.getItem(key) || ''; } catch (error) { return ''; }
  }

  function keep(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (error) {}
  }

  function join(dir, name) {
    return String(dir).replace(/[\\/]+$/, '') + '/' + name;
  }

  function remember(error) {
    var message = error && error.message ? error.message : String(error || '');
    keep(KEY_ERROR, message);
    return message;
  }

  function clearError() {
    keep(KEY_ERROR, '');
  }

  async function exists(path) {
    try {
      await Neutralino.filesystem.getStats(path);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function folderStats(dir) {
    if (!dir) return null;
    try {
      return await Neutralino.filesystem.getStats(dir);
    } catch (error) {
      return null;
    }
  }

  var adapter = {
    /** Desktop nie ma logowania Google w aplikacji — panel to respektuje. */
    supportsGoogle: false,
    desktop: true,

    async status() {
      var dir = store(KEY_PATH);
      if (!dir) {
        return { picked: false, label: '', file: FILE_NAME, fileReady: false, lastError: store(KEY_ERROR) };
      }
      var stats = await folderStats(dir);
      if (!stats || (stats.isDirectory === false)) {
        return { picked: false, label: '', file: FILE_NAME, fileReady: false, lastError: store(KEY_ERROR) };
      }
      var ready = false;
      try {
        var entries = await Neutralino.filesystem.readDirectory(dir);
        ready = (entries || []).some(function (entry) { return isLibraryFile(entry && entry.entry); });
      } catch (error) {
        ready = false;
      }
      return { picked: true, label: dir, file: FILE_NAME, fileReady: ready, lastError: store(KEY_ERROR) };
    },

    async pickFolder() {
      try {
        var dir = await Neutralino.os.showFolderDialog('Wybierz folder biblioteki');
        if (!dir) return adapter.status();
        keep(KEY_PATH, String(dir));
        clearError();
        return adapter.status();
      } catch (error) {
        remember(error);
        return adapter.status();
      }
    },

    async forget() {
      keep(KEY_PATH, '');
      clearError();
      return adapter.status();
    },

    async read() {
      var dir = store(KEY_PATH);
      if (!dir) throw new Error('Nie wskazano folderu.');
      var file = join(dir, FILE_NAME);
      if (!(await exists(file))) return { manifest: null, modifiedTime: 0 };
      try {
        var text = await Neutralino.filesystem.readFile(file);
        clearError();
        var stats = await folderStats(file);
        return { manifest: text, modifiedTime: stats && stats.modifiedAt ? stats.modifiedAt : Date.now() };
      } catch (error) {
        throw new Error(remember(error) || 'Nie można odczytać pliku biblioteki.');
      }
    },

    /** Wszystkie pliki biblioteki w folderze — jedno czytanie katalogu. */
    async list() {
      var dir = store(KEY_PATH);
      if (!dir) throw new Error('Nie wskazano folderu.');
      var entries;
      try {
        entries = await Neutralino.filesystem.readDirectory(dir);
      } catch (error) {
        throw new Error(remember(error) || 'Nie można odczytać folderu biblioteki.');
      }
      var files = [];
      for (var i = 0; i < (entries || []).length; i++) {
        if (files.length >= MAX_FILES) break;
        var name = String((entries[i] && entries[i].entry) || '');
        if (!isLibraryFile(name)) continue;
        var path = join(dir, name);
        try {
          var text = await Neutralino.filesystem.readFile(path);
          var info = await folderStats(path);
          files.push({
            name: name,
            manifest: text,
            modifiedTime: info && info.modifiedAt ? info.modifiedAt : Date.now()
          });
        } catch (error) {
          // Pojedynczy plik bywa w trakcie pobierania — reszta i tak się przyda.
          remember(error);
        }
      }
      return files;
    },

    async write(payload) {
      var dir = store(KEY_PATH);
      if (!dir) throw new Error('Nie wskazano folderu.');
      var name = safeName(payload && payload.name);
      try {
        if (!(await folderStats(dir))) {
          await Neutralino.filesystem.createDirectory(dir);
        }
        await Neutralino.filesystem.writeFile(join(dir, name), String(payload && payload.manifest || ''));
        clearError();
        return { file: name, modifiedTime: Date.now() };
      } catch (error) {
        throw new Error(remember(error) || 'Nie można zapisać pliku biblioteki.');
      }
    }
  };

  window.__pulsarSyncAdapter = adapter;
})();
