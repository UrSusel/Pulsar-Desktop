/**
 * Pulsar Android — synchronizacja biblioteki z Google Drive (tylko metadane).
 *
 * Co wysyłamy: lista utworów (tytuł, wykonawca, album, rok, polubienie, liczba
 * odtworzeń, identyfikator YouTube) oraz albumy (nazwa, okładka, zawartość).
 * Czego NIGDY nie wysyłamy: plików audio, okładek-blobów, ścieżek lokalnych
 * ani adresów strumieni (te wygasają po kilku godzinach i są przypisane do IP).
 *
 * Ten plik ma całą logikę: zbudowanie manifestu, scalenie dwóch manifestów
 * (ostatnia zmiana wygrywa, kasowanie wygrywa z wpisem), zastosowanie wyniku
 * w bibliotece i panel w ustawieniach. Ładowany tylko na Androidzie, przez
 * build_web_assets.py.
 *
 * Dwa transporty, ten sam silnik:
 *  - „folder” (domyślny, zero konfiguracji): użytkownik raz wskazuje folder na
 *    swoim Dysku w systemowym oknie Dokumentów (PulsarFolderPlugin) i apka
 *    trzyma tam plik pulsar-library.json. Bez Client ID i bez ekranu zgody.
 *  - „google” (opcjonalny): logowanie OAuth i Drive REST (PulsarDrivePlugin).
 *  - desktop (Windows/Linux): adapter Neutralino rejestruje
 *    window.__pulsarSyncAdapter i wskazuje folder wybrany w systemowym oknie;
 *    jeśli to folder synchronizowany z Dyskiem Google (klient Drive dla Windows
 *    albo rclone na Linuksie), plik trafia do chmury bez logowania w aplikacji.
 * Wskazanie folderu jest jednorazowe na urządzenie — dalej wszystko dzieje się
 * samo: przy starcie, po powrocie do apki i po zmianach w bibliotece.
 */
(function () {
  'use strict';

  // Ten sam plik może trafić na stronę dwa razy (np. paczka desktop już go
  // wczytuje). Drugie wejście kończy się od razu, żeby nie dublować nasłuchów.
  if (window.__pulsarDrive) return;

  var SCHEMA = 1;
  var MANIFEST_NAME = 'pulsar-library.json';
  // Każde urządzenie zapisuje WŁASNY plik — nikt nie dotyka cudzego. Dzięki temu
  // chwilowy brak jednego pliku w odczycie nie może skasować biblioteki drugiego
  // urządzenia: jego plik leży nietknięty i wystarczy przeczytać go ponownie.
  var LIBRARY_PREFIX = 'pulsar-library';
  var LEGACY_FILE = 'pulsar-library.json';
  var MAX_CLOUD_FILES = 8;
  var SYNC_DB = 'pulsar-sync';
  var SYNC_DB_VERSION = 1;
  var TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  var LANG = 'pl';
  try { LANG = String(localStorage.getItem('playerLang') || 'pl').slice(0, 2); } catch (error) {}

  var LABELS = {
    pl: {
      title: 'Chmura', tab: 'Chmura',
      intro: 'Biblioteka (utwory, albumy, polubienia) synchronizuje się przez Twoje konto Google. Pliki audio zostają na urządzeniu.',
      neverDeletes: 'Kasowanie nigdy nie rusza plików: utwory usunięte na innym urządzeniu są tylko oznaczone.',
      howCap: 'Jak synchronizować', modeLabel: 'Sposób',
      modeDesc: 'Folder: nic nie konfigurujesz. Konto Google: własny projekt w chmurze.',
      modeFolder: 'Folder na Dysku', modeGoogle: 'Konto Google',
      folderCap: 'Folder na Dysku',
      folderLab: 'Folder biblioteki', folderForgetHint: 'Zapomnienie folderu wyłącza synchronizację na tym urządzeniu.',
      chooseFolder: 'Wybierz folder', forgetFolder: 'Zapomnij folder',
      folderChosen: 'Folder: ', folderMissing: 'Nie wskazano jeszcze folderu — wybierz go raz i gotowe.',
      folderHintDesktop: 'Wskaż folder synchronizowany z Dyskiem Google (klient Drive dla Windows albo rclone/Insync na Linuksie). Aplikacja trzyma w nim plik pulsar-library.json — bez logowania i bez konfiguracji.',
      folderLabDesktop: 'Folder biblioteki (Dysk Google)',
      googleOnlyAndroid: 'Logowanie kontem Google w aplikacji działa tylko na Androidzie.',
      folderHint: 'Wskaż raz folder na swoim Dysku i ten sam folder na drugim urządzeniu. Plik pulsar-library.json pojawi się w Twoim Dysku z listą utworów, albumów i polubień — bez plików audio. Konto Google wybierasz w systemowym oknie, nie w aplikacji.',
      googleCap: 'Konto Google',
      googleHint: 'Warstwa Drive (wysyłka i odbiór manifestu) jest gotowa, ale logowania w przeglądarce nie da się już użyć na Androidzie — Google je wycofał. Obsługiwane logowanie kontem Google wymaga Play Services (Credential Manager) i jest do dopisania. Teraz działa tryb „Folder na Dysku”.',
      googleHintFields: 'Pola poniżej zostają na przyszłość (własny projekt w Google Cloud); obecnie nic nie robią.',
      googleHelp: 'Jak włączyć: w Google Cloud utwórz projekt, włącz Drive API, dodaj typ klienta OAuth „Aplikacja komputerowa”, wklej Client ID i sekret, ustaw adres przekierowania pl.ursusel.pulsar.android:/oauth2redirect i dodaj swoje konto jako testera.',
      statusCap: 'Stan',
      layers: 'Warstwy: ',
      needConfig: 'Najpierw wklej Client ID i Client secret, potem kliknij Zapisz.',
      noPlugin: 'Ta kompilacja nie ma warstwy „{name}” — zbuduj aplikację ponownie (npm run android:sync, potem Android Studio).',
      openingBrowser: 'Otwieram przeglądarkę Google…',
      signedInToast: 'Zalogowano na konto Google.',
      syncDone: 'Zsynchronizowano.',
      syncDisabled: 'Najpierw włącz „Synchronizuj automatycznie”.',
      folderReadyToast: 'Folder wybrany.',
      configSaved: 'Konfiguracja zapisana.',
      browserSignInRetired: 'Google wycofał logowanie przez przeglądarkę w aplikacjach na Androida (niestandardowe adresy przekierowania nie są już obsługiwane — błąd „Custom URI scheme is not supported”). Użyj trybu „Folder na Dysku”: działa od razu, bez konfiguracji i bez logowania w aplikacji.',
      signInLab: 'Logowanie',
      signedOut: 'Nie zalogowano na konto Google.', signedInAs: 'Zalogowano jako ',
      signIn: 'Zaloguj się kontem Google', signOut: 'Wyloguj', syncNow: 'Synchronizuj teraz',
      syncing: 'Synchronizuję…', lastSync: 'Ostatnia synchronizacja: ', never: 'nigdy',
      sent: 'Wysłane: ', received: 'Odebrane: ', inCloud: 'Tylko w chmurze: ',
      inCloudHint: ' — z innego urządzenia, możesz je pobrać niżej',
      cloudOnlyCap: 'Utwory tylko w chmurze',
      cloudOnlyHint: 'Są już w bibliotece na innym urządzeniu. Pliki audio nie podróżują przez chmurę — pobiorę je tutaj z YouTube: utwory z YouTube po identyfikatorze, a zwykłe pliki z komputera po tytule i autorze.',
      cloudOnlyMore: '…i jeszcze ', cloudOnlyMoreTail: ' w chmurze',
      downloadHere: 'Pobierz tutaj', downloading: 'Pobieram: ',
      downloaded: 'Pobrano — zaraz zsynchronizuję bibliotekę.',
      downloadNoResult: 'YouTube nie zwrócił tego utworu — nic nie pobrano.',
      downloadNoApi: 'Ta kompilacja nie ma wyszukiwarki sieciowej (__player.__net) — pobierz ten utwór ręcznie w zakładce Sieć.',
      downloadFromYoutube: 'Pobierz z YouTube',
      searchByNameHint: 'plik z innego urządzenia — szukam go na YouTube po tytule i autorze',
      searchingByTitle: ' — szukam na YouTube po tytule i autorze',
      downloadNoTitle: 'Ten wpis nie ma tytułu, więc nie ma po czym szukać go na YouTube.',
      downloadUnconfirmed: 'Import nie potwierdził się w bibliotece — sprawdź zakładkę Sieć.',
      downloadOff: 'Wyszukiwanie w sieci jest w tej chwili wyłączone — włącz je w zakładce Sieć.',
      cloudFileInfo: 'Pliki w chmurze: ', ownFileLabel: 'Twój plik: ',
      tracksWord: 'utw.', albumsWord: 'alb.',
      lastOtherWrite: 'Ostatnia zmiana z innego urządzenia: ',
      newFromCloud: 'Nowe z innego urządzenia: ',
      newFromCloudHint: ' — w Ustawieniach → Chmura możesz je pobrać na tym urządzeniu.',
      devicesInFile: 'Urządzenia w pliku: ',
      fileChanged: ' · plik zmieniony ',
      autoLab: 'Pobieraj automatycznie utwory z innego urządzenia (z YouTube)',
      autoDesc: 'Utwory z drugiego urządzenia ściągają się tu same z YouTube — te z YouTube po identyfikatorze, a pliki z komputera po tytule i autorze — po kilka na raz.',
      autoDescMetered: 'Ten sam mechanizm na telefonie jest domyślnie wyłączony, żeby nie zużywał danych z sieci komórkowej. Możesz go tu włączyć.',
      autoOn: 'Automatyczne pobieranie włączone.', autoOff: 'Automatyczne pobieranie wyłączone.',
      autoStateOn: 'Automatyczne pobieranie: włączone', autoWaiting: ' · czeka na pobranie: ',
      autoStateOff: 'Automatyczne pobieranie: wyłączone — włącz przełącznikiem wyżej',
      autoLastOk: 'Ostatnio pobrane automatycznie: ', autoLastFail: 'Ostatnie pobieranie nie udało się: ',
      refreshFiles: 'Odśwież listę plików',
      refreshFilesHint: 'Sprawdź, które pliki biblioteki widzi teraz to urządzenie.',
      filesSeen: 'Widzę pliki: ', filesNone: 'nie widzę w folderze żadnego pliku biblioteki',
      onlyOwnFile: 'W folderze widzę na razie tylko własny plik — Dysk pokazuje pliki z drugiego urządzenia z opóźnieniem. Otwórz folder w aplikacji Dysk Google (to odświeży listę) i kliknij „Odśwież listę plików”.',
      downloadAll: 'Pobierz wszystkie tutaj',
      downloadAllHint: 'Te utwory są już w bibliotece na innym urządzeniu — ściągnę je tutaj z YouTube po kolei, jednym kliknięciem: utwory z YouTube po identyfikatorze, a pliki z komputera po tytule i autorze.',
      downloadNothing: 'Nie ma teraz czego pobierać z YouTube.',
      autoDownloading: 'Automatycznie pobieram: ',
      writeBackWarning: 'Uwaga: po zapisie nie widzę swoich danych w pliku — sprawdź, czy oba urządzenia wskazują ten sam folder w tej samej chmurze.',
      cloudRestored: 'Odtworzone z pamięci (odczyt nie pokazał wszystkiego): ',
      keylessA: 'Biblioteka ma ', keylessB: ' utworów, a do chmury jedzie ',
      keylessC: ' — reszta nie ma identyfikatora utworu. Dodaj je ponownie z zakładki Sieć, żeby dostały identyfikator YouTube i mogły jechać między urządzeniami.',
      bridgeDown: 'Mostek do YouTube nie odpowiada — bez niego nic się nie ściągnie. Uruchom go w zakładce Sieć i spróbuj ponownie.',
      bridgeCheck: 'Sprawdź mostek do YouTube w zakładce Sieć — bez niego utwory z internetu się nie ściągną.',
      nothingToSend: 'Biblioteka jest pusta, a w folderze nie ma jeszcze pliku — nie ma czego wysyłać.',
      removedElsewhere: 'Usunięte na innym urządzeniu: ',
      mirror: 'Trzymaj czytelną kopię na Dysku (folder Pulsar)',
      enabled: 'Synchronizuj automatycznie',
      advanced: 'Konfiguracja (Google Cloud)', clientId: 'Client ID', clientSecret: 'Client secret',
      redirectUri: 'Adres przekierowania', save: 'Zapisz',
      missingLibrary: 'Nie widzę biblioteki aplikacji.', error: 'Błąd: ',
      noTransport: 'Ta wersja nie ma warstwy synchronizacji.'
    },
    en: {
      title: 'Cloud', tab: 'Cloud',
      intro: 'Your library (tracks, albums, favourites) syncs through your own Google account. Audio files stay on the device.',
      neverDeletes: 'Deleting never touches files: tracks removed on another device are only flagged.',
      howCap: 'How to sync', modeLabel: 'Mode',
      modeDesc: 'Folder: nothing to configure. Google account: your own cloud project.',
      modeFolder: 'Drive folder', modeGoogle: 'Google sign-in',
      folderCap: 'Drive folder',
      folderLab: 'Library folder', folderForgetHint: 'Forgetting the folder turns sync off on this device.',
      chooseFolder: 'Choose folder', forgetFolder: 'Forget folder',
      folderChosen: 'Folder: ', folderMissing: 'No folder chosen yet — pick one once and you are done.',
      folderHintDesktop: 'Point at a folder synced with Google Drive (the Drive client for Windows, or rclone/Insync on Linux). The app keeps pulsar-library.json inside it — no sign-in, no setup.',
      folderLabDesktop: 'Library folder (Google Drive)',
      googleOnlyAndroid: 'Signing in with a Google account inside the app works on Android only.',
      folderHint: 'Point once at a folder on your Drive and at the same folder on the second device. pulsar-library.json appears in your Drive with the list of tracks, albums and favourites — no audio files. The Google account is chosen in the system picker, not in the app.',
      googleCap: 'Google account',
      googleHint: 'The Drive layer (upload and download of the manifest) is ready, but browser sign-in can no longer be used on Android — Google retired it. Supported Google sign-in needs Play Services (Credential Manager) and is still to be added. For now the “Drive folder” mode works.',
      googleHintFields: 'The fields below are kept for the future (own Google Cloud project); right now they do nothing.',
      googleHelp: 'How to enable: create a Google Cloud project, enable the Drive API, add an OAuth client of type “Desktop app”, paste the Client ID and secret, set the redirect URI to pl.ursusel.pulsar.android:/oauth2redirect and add your account as a test user.',
      statusCap: 'Status',
      layers: 'Layers: ',
      needConfig: 'Paste the Client ID and secret first, then press Save.',
      noPlugin: 'This build has no “{name}” layer — rebuild the app (npm run android:sync, then Android Studio).',
      openingBrowser: 'Opening Google in the browser…',
      signedInToast: 'Signed in to Google.',
      syncDone: 'Synced.',
      syncDisabled: 'Turn on “Sync automatically” first.',
      folderReadyToast: 'Folder selected.',
      configSaved: 'Configuration saved.',
      browserSignInRetired: 'Google retired browser sign-in for Android apps (custom redirect URIs are no longer supported — the “Custom URI scheme is not supported” error). Use the “Drive folder” mode: it works right away, with no configuration and no sign-in in the app.',
      signInLab: 'Sign-in',
      notConfigured: 'Sync is not configured — paste the Client ID and Client secret from Google Cloud.',
      signedOut: 'Not signed in to Google.', signedInAs: 'Signed in as ',
      signIn: 'Sign in with Google', signOut: 'Sign out', syncNow: 'Sync now',
      syncing: 'Syncing…', lastSync: 'Last sync: ', never: 'never',
      sent: 'Sent: ', received: 'Received: ', inCloud: 'Cloud only: ',
      inCloudHint: ' — from another device; you can download them below',
      cloudOnlyCap: 'Tracks only in the cloud',
      cloudOnlyHint: 'They are already in the library on another device. Audio never travels through the cloud — I will fetch them here from YouTube: YouTube tracks by id, plain files from the computer by title and artist.',
      cloudOnlyMore: '…and ', cloudOnlyMoreTail: ' more in the cloud',
      downloadHere: 'Download here', downloading: 'Downloading: ',
      downloaded: 'Downloaded — syncing the library in a moment.',
      downloadNoResult: 'YouTube did not return this track — nothing was downloaded.',
      downloadNoApi: 'This build has no network search (__player.__net) — download this track by hand in the Network tab.',
      downloadFromYoutube: 'Download from YouTube',
      searchByNameHint: 'a file from another device — I will look it up on YouTube by title and artist',
      searchingByTitle: ' — looking it up on YouTube by title and artist',
      downloadNoTitle: 'This entry has no title, so there is nothing to look up on YouTube.',
      downloadUnconfirmed: 'The import was not confirmed in the library — check the Network tab.',
      downloadOff: 'Network search is switched off right now — switch it on in the Network tab.',
      cloudFileInfo: 'Cloud files: ', ownFileLabel: 'Your file: ',
      tracksWord: 'tracks', albumsWord: 'albums',
      lastOtherWrite: 'Last change from another device: ',
      newFromCloud: 'New from another device: ',
      newFromCloudHint: ' — open Settings → Cloud to download them on this device.',
      devicesInFile: 'Devices in the file: ',
      fileChanged: ' · file changed ',
      autoLab: 'Download tracks from another device automatically (from YouTube)',
      autoDesc: 'Tracks from the other device are fetched here on their own from YouTube — YouTube tracks by id, files from the computer by title and artist — a few at a time.',
      autoDescMetered: 'The same mechanism stays off by default on a phone so it does not use mobile data. You can switch it on here.',
      autoOn: 'Automatic download on.', autoOff: 'Automatic download off.',
      autoStateOn: 'Automatic download: on', autoWaiting: ' · waiting: ',
      autoStateOff: 'Automatic download: off — turn the switch above on',
      autoLastOk: 'Last automatic download: ', autoLastFail: 'Last download failed: ',
      refreshFiles: 'Refresh file list',
      refreshFilesHint: 'Check which library files this device can see right now.',
      filesSeen: 'Files I can see: ', filesNone: 'no library file visible in the folder',
      onlyOwnFile: 'I can only see my own file in the folder — Drive shows files from another device with a delay. Open the folder in the Google Drive app (that refreshes the listing) and click “Refresh file list”.',
      downloadAll: 'Download all here',
      downloadAllHint: 'These tracks are already in the library on another device — I will fetch them here from YouTube one by one, in one click: YouTube tracks by id, files from the computer by title and artist.',
      downloadNothing: 'There is nothing to download from YouTube right now.',
      autoDownloading: 'Downloading automatically: ',
      writeBackWarning: 'Warning: after writing I cannot see my own data in the file — check that both devices point at the same folder in the same cloud.',
      cloudRestored: 'Restored from memory (the read did not show everything): ',
      keylessA: 'The library holds ', keylessB: ' tracks and only ',
      keylessC: ' travel to the cloud — the rest have no track identifier. Add them again from the Network tab so they get a YouTube id and can travel between devices.',
      bridgeDown: 'The YouTube bridge is not responding — without it nothing downloads. Start it in the Network tab and try again.',
      bridgeCheck: 'Check the YouTube bridge in the Network tab — without it nothing downloads from the web.',
      nothingToSend: 'The library is empty and there is no file in the folder yet — there is nothing to send.',
      removedElsewhere: 'Removed on another device: ',
      mirror: 'Keep a readable copy in Drive (Pulsar folder)',
      enabled: 'Sync automatically',
      advanced: 'Setup (Google Cloud)', clientId: 'Client ID', clientSecret: 'Client secret',
      redirectUri: 'Redirect URI', save: 'Save',
      missingLibrary: 'The app library is not available.', error: 'Error: ',
      noTransport: 'This build has no sync layer.'
    }
  };

  function T(key) {
    var table = LABELS[LANG] || LABELS.en;
    return table[key] || LABELS.en[key] || key;
  }

  // --------------------------------------------------------------- narzędzia

  function nowMs() { return Date.now(); }

  /** Krótki stabilny skrót (bez crypto.subtle, żeby działał synchronicznie). */
  function hash(text) {
    var a = 0x811c9dc5;
    var b = 0x01000193;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      a = (a ^ c) * 16777619 >>> 0;
      b = ((b + c * (i + 1)) ^ (b >>> 13)) >>> 0;
    }
    return (a.toString(16) + b.toString(16)).slice(0, 16);
  }

  /**
   * Klucz utworu wspólny dla wszystkich urządzeń.
   * Preferujemy identyfikator sieciowy (`netId` = „youtube:VIDEOID”), bo jest
   * ten sam wszędzie. Dla plików lokalnych zostaje odcisk z rozmiaru i nazwy —
   * niezależny od lokalnej ścieżki i od UUID nadanego przy imporcie (te różnią
   * się między urządzeniami i nie nadają się do parowania).
   */
  function trackKey(track) {
    if (!track) return '';
    var netId = track.netId || track.syncId || '';
    if (netId) return String(netId);
    var size = track.file ? (track.file.size || 0) : (track.size || 0);
    var name = track.file ? (track.file.name || '') : (track.name || '');
    if (!name && !size) return '';
    return 'fp:' + size + ':' + hash(String(name).toLowerCase());
  }

  function albumKey(album) {
    if (!album) return '';
    if (album.syncId) return String(album.syncId);
    return 'al:' + hash(String(album.name || '').toLowerCase());
  }

  function metadataOf(track) {
    var netId = String((track && (track.netId || track.syncId)) || '');
    return {
      title: String((track && track.title) || ''),
      artist: String((track && track.artist) || ''),
      album: String((track && track.album) || ''),
      year: String((track && track.year) || ''),
      provider: netId ? netId.split(':')[0] : String((track && track.provider) || ''),
      ytId: netId.indexOf('youtube:') === 0 ? netId.slice(8) : '',
      durMs: Math.round(Number((track && track.durMs) || 0) || 0),
      fav: !!(track && track.fav),
      plays: Math.max(0, Math.round(Number((track && track.plays) || 0) || 0)),
      lastPlay: Math.max(0, Math.round(Number((track && track.lastPlay) || 0) || 0))
    };
  }

  function fingerprintOf(meta) {
    return [
      meta.title, meta.artist, meta.album, meta.year, meta.provider, meta.ytId,
      meta.durMs, meta.fav ? 1 : 0, meta.plays, meta.lastPlay
    ].join('|');
  }

  function devicesOf(manifest) {
    var list = (manifest && manifest.devices) || [];
    var out = [];
    var seen = {};
    list.forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) return;
      seen[entry.id] = true;
      out.push(entry);
    });
    return out;
  }

  /** Lista urządzeń bez duplikatów: najpierw to, co widzi plik, potem pamięć. */
  function unionDeviceLists(first, second) {
    var out = [];
    var seen = {};
    (first || []).concat(second || []).forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) return;
      seen[entry.id] = true;
      out.push(entry);
    });
    return out;
  }

  /** Pamięć chmury jest świeża, dopóki nie przeżyje własnych znaczników kasowania. */
  function cloudMemoryState(memory) {
    if (!memory) return { fresh: false };
    return { fresh: Number(memory.at || 0) > nowMs() - TOMBSTONE_TTL_MS };
  }

  /**
   * Scalenie odczytu pliku z tym, co to urządzenie już o pliku wie.
   *
   * „Nie widzę pliku" to na Androidzie (SAF odświeża listę folderu z opóźnieniem)
   * i na komputerze (klient Drive jeszcze nie pobrał pliku) zwykły stan przejściowy,
   * a nie dowód, że w chmurze nic nie ma. Wpis, który zniknął z odczytu, a nie ma
   * znacznika kasowania, wraca więc z pamięci — podobnie jak urządzenia z pliku.
   * Bez tego jedna niepełna odpowiedź Drive kasowała bibliotekę drugiego urządzenia:
   * telefon widział „brak pliku", zapisywał swoją kopię i utwory komputera
   * znikały z chmury.
   */
  function mergeCloudMemory(fresh, memory) {
    var restored = { tracks: 0, albums: 0, missing: !fresh, stale: false };
    if (!memory || !cloudMemoryState(memory).fresh) {
      restored.stale = !!memory;
      return { manifest: fresh || null, restored: restored };
    }
    var buried = {};
    ((fresh && fresh.removed) || []).forEach(function (entry) {
      if (entry && entry.key) buried[entry.key] = true;
    });
    var have = {};
    var tracks = ((fresh && fresh.tracks) || []).slice();
    var albums = ((fresh && fresh.albums) || []).slice();
    tracks.forEach(function (entry) { if (entry && entry.key) have[entry.key] = true; });
    albums.forEach(function (entry) { if (entry && entry.key) have[entry.key] = true; });
    (memory.tracks || []).forEach(function (entry) {
      if (!entry || !entry.key || have[entry.key] || buried[entry.key]) return;
      have[entry.key] = true;
      tracks.push(entry);
      restored.tracks++;
    });
    (memory.albums || []).forEach(function (entry) {
      if (!entry || !entry.key || have[entry.key] || buried[entry.key]) return;
      have[entry.key] = true;
      albums.push(entry);
      restored.albums++;
    });
    var removed = ((fresh && fresh.removed) || []).slice();
    (memory.removed || []).forEach(function (entry) {
      if (!entry || !entry.key) return;
      if (removed.some(function (item) { return item && item.key === entry.key; })) return;
      removed.push(entry);
    });
    var manifest = {
      schema: SCHEMA, app: 'pulsar', name: MANIFEST_NAME,
      updatedAt: Math.max(Number((fresh && fresh.updatedAt) || 0), Number(memory.updatedAt || 0)),
      device: (fresh && fresh.device) || memory.device || null,
      devices: unionDeviceLists(fresh && fresh.devices, memory.devices),
      tracks: tracks,
      albums: albums,
      removed: removed
    };
    return { manifest: manifest, restored: restored };
  }

  function mergeDevices(local, remote, device) {
    var out = devicesOf(remote).concat(devicesOf(local));
    var seen = {};
    var merged = [];
    out.forEach(function (entry) {
      if (!entry || !entry.id || seen[entry.id]) return;
      seen[entry.id] = true;
      merged.push(entry.id === device.id ? { id: device.id, name: device.name, platform: device.platform, at: nowMs() } : entry);
    });
    if (!seen[device.id]) merged.unshift({ id: device.id, name: device.name, platform: device.platform, at: nowMs() });
    return merged.slice(0, 12);
  }

  /**
   * Buduje manifest z bieżącego stanu biblioteki.
   * `previous` (poprzednio wypchnięty manifest) służy do wykrycia zmian: wpisy
   * o niezmienionym odcisku zachowują stary znacznik czasu, a klucze, których
   * już nie ma, zamieniają się w znaczniki kasowania.
   *
   * Pierwsza synchronizacja nie zna wieku miejscowych wpisów, więc dostają
   * znacznik 0 („wiek nieznany") i przegrywają konflikt z wpisem z chmury.
   * Inaczej urządzenie, które uruchomiło sync później, nadpisywałoby cudze
   * zmiany tylko dlatego, że ma późniejszy zegar.
   *
   * `localKeys` to klucze, które to urządzenie miało w bibliotece przy
   * poprzedniej synchronizacji. Bez tego drugie uruchomienie uznawałoby za
   * skasowane także wpisy, które nigdy tu nie były — czyli utwór dodany na
   * telefonie ginąłby z chmury przy drugiej synchronizacji komputera.
   */
  /** Czy ten klucz był w bibliotece tego urządzenia przy poprzedniej synchronizacji. */
  function wasLocalKey(localKeys, kind, key) {
    if (!localKeys || !localKeys[kind]) return false;   // brak zapisu: nic nie kasujemy
    return !!localKeys[kind][key];
  }

  /** Klucze obecne teraz lokalnie — zapisujemy je na następny raz. */
  function localKeyMap(localManifest, plan, mergedManifest) {
    var map = { tracks: {}, albums: {}, deleted: {} };
    ((localManifest && localManifest.tracks) || []).forEach(function (entry) {
      if (entry && entry.key) map.tracks[entry.key] = true;
    });
    ((localManifest && localManifest.albums) || []).forEach(function (entry) {
      if (entry && entry.key) map.albums[entry.key] = true;
    });
    // Albumy dołożone z chmury zaraz będą w bibliotece, więc też są „nasze".
    ((plan && plan.newAlbums) || []).forEach(function (entry) {
      if (entry && entry.key) map.albums[entry.key] = true;
    });
    // Żywe znaczniki kasowania — żeby kasowanie nie zniknęło przy następnym
    // starcie (wpis, którego już nie ma w bibliotece, nie chroni go inaczej).
    ((mergedManifest && mergedManifest.removed) || []).forEach(function (entry) {
      if (entry && entry.key) map.deleted[entry.key] = true;
    });
    return map;
  }

  function buildManifest(snapshot, previous, device, localKeys) {
    var firstSync = !previous;
    var previousTracks = {};
    var previousAlbums = {};
    var tombstones = {};

    if (previous) {
      (previous.tracks || []).forEach(function (entry) { if (entry && entry.key) previousTracks[entry.key] = entry; });
      (previous.albums || []).forEach(function (entry) { if (entry && entry.key) previousAlbums[entry.key] = entry; });
      // Znaczniki kasowania z poprzednich wersji mogły dotyczyć wpisów, których
      // to urządzenie nigdy nie miało (błąd: druga synchronizacja usuwała z pliku
      // utwory dodane na innym urządzeniu). Bez mapy kluczy lokalnych nie da się
      // ich odsiać, więc przy pierwszym starcie po aktualizacji je odpuszczamy —
      // scalanie przywraca wtedy wpisy z pliku, a nowe kasowania działają dalej.
      if (localKeys) {
        (previous.removed || []).forEach(function (entry) {
          if (!entry || !entry.key) return;
          // Znacznik zostaje, gdy dotyczy klucza, o którym to urządzenie wie:
          // albo miało go u siebie, albo samo go wcześniej skasowało.
          var known = (localKeys.deleted && localKeys.deleted[entry.key]) ||
            wasLocalKey(localKeys, 'tracks', entry.key) ||
            wasLocalKey(localKeys, 'albums', entry.key);
          if (!known) return;
          tombstones[entry.key] = entry;
        });
      }
    }

    var stamp = nowMs();
    var seenTracks = {};
    var tracks = [];

    (snapshot.tracks || []).forEach(function (item) {
      var key = item.key || trackKey(item);
      if (!key || seenTracks[key]) return;
      seenTracks[key] = true;
      var meta = metadataOf(item);
      var fingerprint = fingerprintOf(meta);
      var previousEntry = previousTracks[key];
      var unchanged = previousEntry && previousEntry.fingerprint === fingerprint;
      tracks.push({
        key: key,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        provider: meta.provider,
        ytId: meta.ytId,
        durMs: meta.durMs,
        fav: meta.fav,
        plays: meta.plays,
        lastPlay: meta.lastPlay,
        fingerprint: fingerprint,
        device: device.id,
        updatedAt: unchanged ? previousEntry.updatedAt : (firstSync ? 0 : stamp)
      });
      delete tombstones[key];
    });

    Object.keys(previousTracks).forEach(function (key) {
      if (seenTracks[key]) return;
      // Wpis z chmury, którego to urządzenie nigdy nie miało, to nie kasowanie.
      if (!wasLocalKey(localKeys, 'tracks', key)) return;
      var existing = tombstones[key];
      tombstones[key] = { key: key, deletedAt: existing ? existing.deletedAt : stamp, device: device.id };
    });

    var seenAlbums = {};
    var albums = [];
    (snapshot.albums || []).forEach(function (item) {
      var key = item.key || albumKey(item);
      if (!key || seenAlbums[key]) return;
      seenAlbums[key] = true;
      var trackKeys = (item.trackKeys || []).slice().sort();
      var fingerprint = [item.name || '', item.artist || '', item.cover || '', trackKeys.join(',')].join('|');
      var previousEntry = previousAlbums[key];
      var unchanged = previousEntry && previousEntry.fingerprint === fingerprint;
      albums.push({
        key: key,
        name: String(item.name || ''),
        artist: String(item.artist || ''),
        cover: String(item.cover || ''),
        trackKeys: trackKeys,
        customCover: !!item.customCover,
        createdAt: Number(item.createdAt || 0) || stamp,
        fingerprint: fingerprint,
        device: device.id,
        updatedAt: unchanged ? previousEntry.updatedAt : (firstSync ? 0 : stamp)
      });
      delete tombstones[key];
    });

    Object.keys(previousAlbums).forEach(function (key) {
      if (seenAlbums[key]) return;
      if (!wasLocalKey(localKeys, 'albums', key)) return;
      var existing = tombstones[key];
      tombstones[key] = { key: key, deletedAt: existing ? existing.deletedAt : stamp, device: device.id };
    });

    var cutoff = stamp - TOMBSTONE_TTL_MS;
    var removed = Object.keys(tombstones)
      .map(function (key) { return tombstones[key]; })
      .filter(function (entry) { return Number(entry.deletedAt || 0) > cutoff; });

    return {
      schema: SCHEMA,
      app: 'pulsar',
      name: MANIFEST_NAME,
      updatedAt: stamp,
      device: { id: device.id, name: device.name, platform: device.platform },
      devices: mergeDevices(null, previous, device),
      tracks: tracks,
      albums: albums,
      removed: removed
    };
  }

  /** Ostatnia zmiana wygrywa; przy remisie rozstrzyga identyfikator urządzenia. */
  function newer(a, b) {
    var aAt = Number((a && a.updatedAt) || 0);
    var bAt = Number((b && b.updatedAt) || 0);
    if (aAt !== bAt) return aAt > bAt ? a : b;
    var aDevice = String((a && a.device) || '');
    var bDevice = String((b && b.device) || '');
    if (aDevice === bDevice) return a;
    return aDevice > bDevice ? a : b;
  }

  function fingerprintOfRecord(record, isAlbum) {
    if (isAlbum) {
      var keys = (record.trackKeys || []).slice().sort().join(',');
      return [record.name || '', record.artist || '', record.cover || '', keys].join('|');
    }
    return fingerprintOf({
      title: record.title || '',
      artist: record.artist || '',
      album: record.album || '',
      year: record.year || '',
      provider: record.provider || '',
      ytId: record.ytId || '',
      durMs: Number(record.durMs || 0) || 0,
      fav: !!record.fav,
      plays: Number(record.plays || 0) || 0,
      lastPlay: Number(record.lastPlay || 0) || 0
    });
  }

  function unionKeys(a, b) {
    var out = [];
    (a || []).concat(b || []).forEach(function (key) {
      if (key && out.indexOf(key) === -1) out.push(key);
    });
    return out;
  }

  /**
   * Scala dwa wpisy o tym samym kluczu.
   *
   * Gdy oba znają swój wiek (mają znacznik zmiany), wygrywa nowszy wpis —
   * dzięki temu odznaczenie polubienia też się propaguje.
   *
   * Gdy wieku nie da się porównać (pierwsza synchronizacja obu urządzeń ma
   * znacznik 0, albo remis), nie udajemy, że wiemy, kto ma rację, i scalamy
   * pola po ludzku: brakujące teksty się uzupełniają, polubienie nigdy nie
   * ginie (true wygrywa), a liczniki odtworzeń biorą maksimum. Wybór przy
   * dwóch sprzecznych, niepustych tekstach jest deterministyczny (kolejność
   * urządzeń), więc każde urządzenie dojdzie do tego samego wyniku.
   */
  function mergeEntries(mine, theirs, isAlbum) {
    var knownAges = Number(mine.updatedAt || 0) > 0 && Number(theirs.updatedAt || 0) > 0;
    var winner = newer(mine, theirs);
    var out = Object.assign({}, winner);

    function text(field) {
      var a = String(mine[field] || '');
      var b = String(theirs[field] || '');
      if (a === b) return a;
      if (knownAges) return String(winner[field] || '');
      if (!a) return b;
      if (!b) return a;
      return winner === mine ? a : b;
    }

    if (isAlbum) {
      out.name = text('name');
      out.artist = text('artist');
      out.cover = text('cover');
      if (!knownAges) out.trackKeys = unionKeys(mine.trackKeys, theirs.trackKeys);
    } else {
      out.title = text('title');
      out.artist = text('artist');
      out.album = text('album');
      out.year = text('year');
      out.provider = text('provider');
      out.ytId = text('ytId');
      out.fav = knownAges ? !!winner.fav : (!!mine.fav || !!theirs.fav);
      out.plays = Math.max(Number(mine.plays || 0) || 0, Number(theirs.plays || 0) || 0);
      out.lastPlay = Math.max(Number(mine.lastPlay || 0) || 0, Number(theirs.lastPlay || 0) || 0);
      out.durMs = Number(winner.durMs || 0) || Number(mine.durMs || theirs.durMs || 0) || 0;
    }

    out.updatedAt = Math.max(Number(mine.updatedAt || 0) || 0, Number(theirs.updatedAt || 0) || 0);
    out.fingerprint = fingerprintOfRecord(out, isAlbum);
    out.device = winner.device || mine.device || '';
    return out;
  }

  function collectTombstones(local, remote) {
    var map = {};
    (local && local.removed || []).forEach(function (entry) { if (entry && entry.key) map[entry.key] = entry; });
    (remote && remote.removed || []).forEach(function (entry) {
      if (!entry || !entry.key) return;
      var existing = map[entry.key];
      if (existing && Number(existing.deletedAt || 0) >= Number(entry.deletedAt || 0)) return;
      map[entry.key] = entry;
    });
    return map;
  }

  /**
   * Scala lokalny manifest ze zdalnym. Czysta funkcja — bez zapisu.
   * Zwraca { merged, incoming, stats }:
   *   merged   — stan do wypchnięcia,
   *   incoming — pozycje, które na tym urządzeniu trzeba zastosować,
   *   stats    — liczniki dla panelu.
   * Kasowanie wygrywa z wpisem, jeśli jest nowsze — inaczej usunięty utwór
   * wracałby z drugiego urządzenia przy każdej synchronizacji.
   */
  function mergeManifests(local, remote) {
    var stats = { localOnly: 0, remoteOnly: 0, updated: 0, remoteRemoved: [], cloudRemoved: [] };
    if (!remote) return { merged: local, incoming: { tracks: [], albums: [] }, stats: stats };
    if (!local) return { merged: remote, incoming: { tracks: remote.tracks || [], albums: remote.albums || [] }, stats: stats };

    var tombstones = collectTombstones(local, remote);
    var localTracks = {};
    var localAlbums = {};
    (local.tracks || []).forEach(function (entry) { if (entry && entry.key) localTracks[entry.key] = entry; });
    (local.albums || []).forEach(function (entry) { if (entry && entry.key) localAlbums[entry.key] = entry; });

    function buried(entry) {
      var tomb = tombstones[entry.key];
      return !!tomb && Number(tomb.deletedAt || 0) >= Number(entry.updatedAt || 0);
    }

    var mergedTracks = [];
    var incomingTracks = [];
    var index = {};
    (local.tracks || []).forEach(function (entry) {
      if (!entry || !entry.key || buried(entry)) return;
      index[entry.key] = mergedTracks.length;
      mergedTracks.push(entry);
    });
    (remote.tracks || []).forEach(function (entry) {
      if (!entry || !entry.key || buried(entry)) return;
      var at = index[entry.key];
      if (at === undefined) {
        index[entry.key] = mergedTracks.length;
        mergedTracks.push(entry);
        stats.remoteOnly++;
        incomingTracks.push(entry);
        return;
      }
      var mergedEntry = mergeEntries(mergedTracks[at], entry, false);
      if (mergedEntry.fingerprint !== mergedTracks[at].fingerprint) {
        stats.updated++;
        incomingTracks.push(mergedEntry);
      }
      mergedTracks[at] = mergedEntry;
    });

    Object.keys(localTracks).forEach(function (key) {
      if (!remote.tracks || !remote.tracks.some(function (entry) { return entry && entry.key === key; })) stats.localOnly++;
      if (localTracks[key] && buried(localTracks[key]) && tombstones[key].device !== local.device.id) {
        stats.remoteRemoved.push(key);
      }
    });

    var mergedAlbums = [];
    var incomingAlbums = [];
    var albumIndex = {};
    (local.albums || []).forEach(function (entry) {
      if (!entry || !entry.key || buried(entry)) return;
      albumIndex[entry.key] = mergedAlbums.length;
      mergedAlbums.push(entry);
    });
    (remote.albums || []).forEach(function (entry) {
      if (!entry || !entry.key || buried(entry)) return;
      var at = albumIndex[entry.key];
      if (at === undefined) {
        albumIndex[entry.key] = mergedAlbums.length;
        mergedAlbums.push(entry);
        incomingAlbums.push(entry);
        return;
      }
      var mergedAlbum = mergeEntries(mergedAlbums[at], entry, true);
      if (mergedAlbum.fingerprint !== mergedAlbums[at].fingerprint) incomingAlbums.push(mergedAlbum);
      mergedAlbums[at] = mergedAlbum;
    });

    // Pozycje z chmury, których nie ma już po żadnej stronie (poza lokalnym plikiem).
    (remote.tracks || []).forEach(function (entry) {
      if (entry && entry.key && buried(entry) && !localTracks[entry.key]) stats.cloudRemoved.push(entry.key);
    });

    var merged = {
      schema: SCHEMA,
      app: 'pulsar',
      name: MANIFEST_NAME,
      updatedAt: nowMs(),
      device: local.device,
      devices: mergeDevices(local, remote, local.device),
      tracks: mergedTracks,
      albums: mergedAlbums,
      removed: Object.keys(tombstones).map(function (key) { return tombstones[key]; })
    };
    return { merged: merged, incoming: { tracks: incomingTracks, albums: incomingAlbums }, stats: stats };
  }

  /**
   * Plan zmian dla runtime: co podmienić w bibliotece w pamięci.
   * Utwory istniejące tylko w chmurze są pomijane — aplikacja gra z plików,
   * więc nie tworzymy „pustych” pozycji. Trafiają do listy „tylko w chmurze”.
   */
  function buildApplyPlan(incoming, snapshot) {
    var byKey = {};
    (snapshot.tracks || []).forEach(function (item) { if (item.key) byKey[item.key] = item; });

    var trackUpdates = [];
    (incoming.tracks || []).forEach(function (entry) {
      var local = byKey[entry.key];
      if (!local) return;
      var fields = {};
      if (entry.title && entry.title !== local.title) fields.title = entry.title;
      if (entry.artist && entry.artist !== local.artist) fields.artist = entry.artist;
      if ((entry.album || '') !== (local.album || '')) fields.album = entry.album || '';
      if ((entry.year || '') !== (local.year || '')) fields.year = entry.year || '';
      if (!!entry.fav !== !!local.fav) fields.fav = !!entry.fav;
      if (Number(entry.plays || 0) > Number(local.plays || 0)) fields.plays = Number(entry.plays || 0);
      if (Number(entry.lastPlay || 0) > Number(local.lastPlay || 0)) fields.lastPlay = Number(entry.lastPlay || 0);
      if (Object.keys(fields).length) trackUpdates.push({ key: entry.key, fields: fields });
    });

    var albumKeys = {};
    (snapshot.albums || []).forEach(function (item) { if (item.key) albumKeys[item.key] = item; });

    var albumUpdates = [];
    var newAlbums = [];
    (incoming.albums || []).forEach(function (entry) {
      var local = albumKeys[entry.key];
      if (local) {
        var before = (local.trackKeys || []).slice().sort().join(',');
        var after = (entry.trackKeys || []).slice().sort().join(',');
        if (before !== after) albumUpdates.push({ key: entry.key, trackKeys: entry.trackKeys || [] });
      } else {
        newAlbums.push({
          key: entry.key,
          name: entry.name,
          trackKeys: entry.trackKeys || [],
          createdAt: entry.createdAt || nowMs()
        });
      }
    });
    return { trackUpdates: trackUpdates, albumUpdates: albumUpdates, newAlbums: newAlbums };
  }

  /** Nazwa utworu bez ozdobników — ta sama norma, co przy dopasowaniu w runtime. */
  function normName(text) {
    return String(text || '').toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/feat\.?[^,]*/g, ' ')
      .replace(/[^a-z0-9\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c]+/g, ' ')
      .trim();
  }

  /**
   * Para „tytuł|wykonawca” — po niej ten sam utwór poznaje się nawet wtedy, gdy
   * na drugim urządzeniu ma inny klucz (plik z dysku kontra kopia z YouTube).
   */
  function namePair(entry) {
    var title = normName(entry && entry.title);
    var artist = normName(entry && entry.artist);
    if (!title || !artist) return '';
    return title + '|' + artist;
  }

  /** Zapytanie do YouTube dla utworu, który nie ma identyfikatora (plik z komputera). */
  function searchQueryOf(entry) {
    var title = String((entry && entry.title) || '').replace(/\s+/g, ' ').trim();
    if (!title) return '';
    var artist = String((entry && entry.artist) || '').replace(/\s+/g, ' ').trim();
    return (artist ? artist + ' ' : '') + title;
  }

  /** Czy da się to pobrać tutaj: po identyfikatorze YouTube albo po tytule i autorze. */
  function canFetchFromYoutube(entry) {
    return !!downloadIdOf(entry) || !!searchQueryOf(entry);
  }

  /** Wyniki, których źródłem jest YouTube — z niego ściągamy wszystko, także pliki z komputera. */
  function youtubeOnlyIndexes(results) {
    var indexes = [];
    (results || []).forEach(function (item, index) {
      if (!item) return;
      if (String(item.provider || '') === 'youtube' || item.ytStream) indexes.push(index);
    });
    return indexes;
  }

  /** Który wynik wziąć: po identyfikatorze dokładnie, po tytule — najlepiej pasujący. */
  function pickResultIndex(results, id, entry) {
    var indexes = youtubeOnlyIndexes(results);
    if (!indexes.length) return -1;
    if (id) {
      var exact = -1;
      indexes.forEach(function (index) {
        if (exact >= 0) return;
        var item = results[index] || {};
        if (String(item.ytId || item.id || '') === id) exact = index;
      });
      return exact;
    }
    var wantTitle = normName(entry && entry.title);
    var wantArtist = normName(entry && entry.artist);
    if (!wantTitle) return indexes[0];
    for (var i = 0; i < indexes.length; i++) {
      var item = results[indexes[i]] || {};
      var itemTitle = normName(item.title);
      if (!itemTitle) continue;
      if (itemTitle.indexOf(wantTitle) === -1 && wantTitle.indexOf(itemTitle) === -1) continue;
      var itemArtist = normName(item.artist);
      if (wantArtist && itemArtist && itemArtist.indexOf(wantArtist) === -1 && wantArtist.indexOf(itemArtist) === -1) continue;
      return indexes[i];
    }
    return indexes[0];
  }

  function cloudOnlyOf(merged, snapshot) {
    var local = {};
    var localNames = {};
    (snapshot.tracks || []).forEach(function (item) {
      if (item.key) local[item.key] = true;
      var pair = namePair(item);
      if (pair) localNames[pair] = true;
    });
    return (merged.tracks || []).filter(function (entry) {
      if (!entry || !entry.key) return false;
      if (local[entry.key]) return false;
      // Ten sam utwór mamy już tutaj pod innym kluczem: plik z komputera albo
      // pobrana tutaj kopia z YouTube. Wtedy nie jest już „tylko w chmurze”.
      var pair = namePair(entry);
      if (pair && localNames[pair]) return false;
      var derived = derivedTracks[entry.key];
      if (derived && local[derived.key]) return false;
      return true;
    });
  }

  // --------------------------------------------------------------- baza sync

  var dbPromise = null;

  function openSyncDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(SYNC_DB, SYNC_DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cloud')) db.createObjectStore('cloud', { keyPath: 'key' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
    return dbPromise;
  }

  function withStore(store, mode, work) {
    return openSyncDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = work(db.transaction(store, mode).objectStore(store));
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function stateGet(id) { return withStore('state', 'readonly', function (store) { return store.get(id); }); }
  function statePut(value) { return withStore('state', 'readwrite', function (store) { return store.put(value); }); }
  /** Zapomniany albo zmieniony folder: pamięć dotyczy starego pliku, więc znika. */
  function clearCloudDerived() {
    derivedTracks = {};
    return statePut({ id: 'cloudDerived', value: null, at: 0 }).catch(function () {});
  }

  function clearCloudMemory() {
    clearCloudDerived().catch(function () {});
    return statePut({ id: 'cloudMemory', value: null, at: 0 }).catch(function () {});
  }
  function cloudReplace(entries) {
    return withStore('cloud', 'readwrite', function (store) { return store.clear(); }).then(function () {
      return Promise.all((entries || []).map(function (entry) {
        return withStore('cloud', 'readwrite', function (store) { return store.put(entry); });
      }));
    });
  }

  // ------------------------------------------------------------- stan i UI

  var DRIVE_PLUGIN = 'PulsarDrive';
  var FOLDER_PLUGIN = 'PulsarFolder';

  var transport = { kind: 'folder', api: null };
  var state = {
    mode: 'folder',
    enabled: false,
    // Komputer: włączone. Telefon: wyłączone, żeby nie ciągnęło danych z sieci
    // komórkowej — przełącznik w panelu to zmienia i zapisuje wybór.
    autoDownload: !!desktopAdapter(),
    folderReady: false,
    folderLabel: '',
    googleConfigured: false,
    googleSignedIn: false,
    googleEmail: '',
    lastSyncAt: 0,
    lastError: '',
    mirror: true
  };
  var busy = false;
  var counters = { sent: 0, received: 0, cloud: 0, removed: 0 };
  // Utwory, które są w chmurze, ale nie ma ich na tym urządzeniu. Panel pokazuje
  // ich listę, a utwory z YouTube można tu pobrać jednym kliknięciem.
  var cloudEntries = [];
  // Co mówi plik w chmurze: ile ma pozycji, kiedy i na jakim urządzeniu
  // powstała ostatnia zmiana. Bez tego „czy zsynchronizowało się?" jest zgadywaniem.
  var cloudMeta = { tracks: 0, albums: 0, updatedAt: 0, device: '', fromOther: false,
    fileModifiedAt: 0, files: [], ownFile: '', ownFileAt: 0, devices: [], writeBack: '', restored: 0,
    seen: null, libraryTracks: 0, snapshotTracks: 0 };
  // Automatyczne pobieranie nowych utworów: na komputerze domyślnie włączone,
  // na telefonie wyłączone (dane komórkowe) — z przełącznikiem w panelu.
  var AUTO_MAX_PER_SYNC = 3;
  var AUTO_RETRY_MS = 6 * 60 * 60 * 1000;
  // Przerwa między partiami: bez niej każda partia kończy się synchronizacją,
  // która uruchamia kolejną — i automat ściągnąłby całą bibliotekę na raz.
  var AUTO_COOLDOWN_MS = 3 * 60 * 1000;
  var autoBatchAt = 0;
  var autoBusy = false;
  var autoTried = {};
  // Ostatnia próba pobrania (także automatyczna) — panel mówi, co się stało,
  // zamiast milczeć, gdy utwór czeka i nic się nie dzieje.
  var autoLast = null;
  // Ostatnia odpowiedź mostka YouTube (desktop): po nieudanym pobieraniu pytamy
  // go wprost, żeby panel powiedział „mostek nie odpowiada”, a nie „nie udało się”.
  // Wpisy z chmury, które udało się tu pobrać z YouTube mimo braku
  // identyfikatora (np. plik z komputera): klucz z chmury → nasz klucz utworu.
  // Bez tej pamięci taki utwór wracałby na listę „tylko w chmurze” po każdym
  // pobraniu i ściągał się w kółko.
  var derivedTracks = {};
  var downloadProbe = null;
  var downloadProbeBusy = false;
  var cloudKnownKeys = [];
  var cloudAnnounced = false;
  var MAX_CLOUD_ROWS = 25;
  // Świeżo wgrany plik bywa przez chwilę niewidoczny (lista folderu w SAF na
  // Androidzie, klient Drive na komputerze) — drugi odczyt to łapie.
  var READ_RETRY_MS = 1500;      // pierwsza przerwa, zanim znów zapytamy folder
  var READ_TRIES = 3;            // ile razy pytamy folder o listę plików
  var EXPECT_FILE_MS = 7 * 24 * 60 * 60 * 1000;  // jak długo pamiętamy, że plik tu był
  var IMPORT_WAIT_MS = 120000;  // ile czekamy, aż import pojawi się w bibliotece
  var IMPORT_POLL_MS = 1500;
  var scheduledTimer = null;
  var listenersReady = false;
  var panel = null;

  function plugins() {
    var capacitor = window.Capacitor;
    return (capacitor && capacitor.Plugins) || {};
  }

  /**
   * Dwa sposoby dotarcia do Dysku:
   *  - „folder” (domyślny): użytkownik raz wskazuje folder w systemowym oknie
   *    Dokumentów i apka pisze tam plik pulsar-library.json. Żadnego Client ID,
   *    żadnego ekranu zgody, żadnego limitu testerów.
   *  - „google”: pełne logowanie OAuth, wymaga własnego projektu w Google Cloud.
   */
  /** Adapter desktopu (Neutralino) rejestruje się sam, zanim wystartuje silnik. */
  function desktopAdapter() {
    var adapter = window.__pulsarSyncAdapter;
    return adapter && typeof adapter.read === 'function' && typeof adapter.write === 'function' ? adapter : null;
  }

  function supportsGoogle() {
    var adapter = desktopAdapter();
    if (adapter) return adapter.supportsGoogle === true;
    return !!plugins()[DRIVE_PLUGIN];
  }

  function transportFor(mode) {
    var available = plugins();
    var adapter = desktopAdapter();
    if (mode === 'google' && available[DRIVE_PLUGIN]) return { kind: 'google', api: available[DRIVE_PLUGIN] };
    if (adapter) return { kind: 'folder', api: adapter, desktop: true };
    if (available[FOLDER_PLUGIN]) return { kind: 'folder', api: available[FOLDER_PLUGIN] };
    return null;
  }

  /** Czy w bieżącym trybie jest wszystko, czego trzeba, żeby wysłać dane. */
  function readyToSync() {
    if (!transport) return false;
    return transport.kind === 'folder' ? state.folderReady : (state.googleSignedIn && state.googleConfigured);
  }

  function hostSnapshot() {
    if (typeof window.__pulsarSyncSnapshot !== 'function') return null;
    try { return window.__pulsarSyncSnapshot(); } catch (error) { return null; }
  }

  /**
   * Ile utworów ma biblioteka na tym urządzeniu. Gdy jest ich więcej niż wpisów
   * w snapshocie, reszta nie ma identyfikatora, po którym urządzenia się
   * kojarzą — i cicho nie jedzie do chmury. Panel musi to powiedzieć, bo inaczej
   * wygląda to jak „telefon nie wysyła połowy biblioteki” bez powodu.
   */
  function libraryTrackCount() {
    try {
      var player = window.__player;
      var info = player && typeof player.state === 'function' ? player.state() : null;
      var count = Math.round(Number(info && info.tracks) || 0);
      return count > 0 ? count : 0;
    } catch (error) { return 0; }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem('pulsarCloudSync');
      if (raw) {
        var parsed = JSON.parse(raw);
        state.enabled = !!parsed.enabled;
        if (typeof parsed.autoDownload === 'boolean') state.autoDownload = parsed.autoDownload;
        if (parsed.mode === 'google' || parsed.mode === 'folder') state.mode = parsed.mode;
      }
      // Desktop nie ma logowania Google: zapamiętany tryb „google" nie może
      // zostawić panelu bez działającego transportu.
      if (state.mode === 'google' && !supportsGoogle()) {
        state.mode = 'folder';
        saveSettings();
      }
    } catch (error) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem('pulsarCloudSync', JSON.stringify({
        enabled: state.enabled, mode: state.mode, autoDownload: !!state.autoDownload
      }));
    } catch (error) {}
  }

  function setMode(mode) {
    if (mode !== 'folder' && mode !== 'google') return;
    if (mode === 'google' && !supportsGoogle()) mode = 'folder';
    state.mode = mode;
    saveSettings();
    transport = transportFor(mode);
    state.lastError = '';
    renderPanelStatus();
    refreshStatus().catch(function () {});
  }

  function setStatus(patch) {
    state = Object.assign({}, state, patch || {});
    renderPanelStatus();
  }

  function deviceInfo() {
    return stateGet('device').then(function (stored) {
      var platform = devicePlatform();
      var name = deviceName();
      if (stored && stored.deviceId) {
        // Starsze wpisy mówią „android" także na komputerze — poprawiamy je.
        if (stored.platform !== platform || stored.name !== name) {
          stored.platform = platform;
          stored.name = name;
          return statePut(stored).then(function () { return stored; });
        }
        return stored;
      }
      var record = {
        id: 'device',
        deviceId: 'dev-' + hash(String(navigator.userAgent || '') + nowMs() + Math.random()),
        name: name,
        platform: platform,
        createdAt: nowMs()
      };
      return statePut(record).then(function () { return record; });
    });
  }

  function devicePlatform() {
    return desktopAdapter() ? 'desktop' : 'android';
  }

  /** System urządzenia — z tego bierze się nazwa jego pliku w chmurze. */
  function platformKey() {
    if (!desktopAdapter()) return 'android';
    var ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'desktop';
  }

  /**
   * Nazwa własnego pliku: `pulsar-library-windows.json`, `-android.json` itd.
   * Jeśli w tym pliku zapisuje już inne urządzenie (dwa komputery z tym samym
   * systemem), drugie przechodzi na nazwę z własnym identyfikatorem — plików
   * nikt nie nadpisuje poza swoim.
   */
  function ownFileName(device, files) {
    var key = platformKey();
    var base = LIBRARY_PREFIX + '-' + key + '.json';
    var holder = '';
    (files || []).forEach(function (file) {
      if (file.name !== base) return;
      var manifest = file.manifest || {};
      holder = String((manifest.device && manifest.device.id) || 'unknown');
    });
    if (holder && holder !== device.deviceId) {
      var tail = String(device.deviceId || 'dev').replace(/[^a-z0-9]/gi, '').slice(-8) || 'dev';
      return LIBRARY_PREFIX + '-' + key + '-' + tail + '.json';
    }
    return base;
  }

  /** Etykiety plików w panelu: „pulsar-library-windows.json" → „windows". */
  function fileLabel(name) {
    return String(name || '').replace(LIBRARY_PREFIX + '-', '').replace(/\.json$/, '') || String(name || '');
  }

  /** Co wnosi każdy plik po odjęciu znaczników kasowania — wiersz w panelu. */
  function cloudFilesInfo(files, union, ownFile) {
    var tomb = {};
    ((union && union.removed) || []).forEach(function (entry) {
      if (entry && entry.key) tomb[entry.key] = Math.max(tomb[entry.key] || 0, Number(entry.deletedAt || 0));
    });
    return (files || []).map(function (file) {
      var manifest = file.manifest || {};
      var live = (manifest.tracks || []).filter(function (entry) {
        if (!entry || !entry.key) return false;
        var deletedAt = tomb[entry.key];
        // Wiek nieznany (0) nie jest sam w sobie kasowaniem — liczy się tylko
        // wtedy, gdy wobec wpisu istnieje znacznik kasowania.
        if (deletedAt === undefined) return true;
        return deletedAt < Number(entry.updatedAt || 0);
      }).length;
      return {
        name: file.name,
        label: fileLabel(file.name),
        tracks: live,
        albums: (manifest.albums || []).length,
        device: String((manifest.device && manifest.device.name) || (manifest.device && manifest.device.id) || ''),
        modifiedAt: Number(file.modifiedTime || 0) || 0,
        own: file.name === ownFile
      };
    });
  }

  function deviceName() {
    var ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    if (!desktopAdapter()) {
      var match = ua.match(/Android[^;]*;\s*([^)]+?)(?:\s+Build|\))/i);
      return (match && match[1] ? match[1].trim() : 'Android').slice(0, 40);
    }
    // Desktop musi się przedstawić jako komputer — inaczej plik w chmurze
    // wygląda, jakby zapisał go telefon.
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac';
    if (/Linux|X11/i.test(ua)) return 'Linux PC';
    return 'Desktop';
  }

  function refreshStatus() {
    transport = transportFor(state.mode);
    if (!transport || !transport.api.status) return Promise.resolve(state);
    return transport.api.status().then(function (result) {
      var patch;
      if (transport.kind === 'folder') {
        patch = {
          folderReady: !!(result && result.picked),
          folderLabel: String((result && result.label) || ''),
          lastError: String((result && result.lastError) || '')
        };
      } else {
        patch = {
          googleConfigured: !!(result && result.configured),
          googleSignedIn: !!(result && result.signedIn),
          googleEmail: String((result && result.email) || ''),
          lastError: String((result && result.lastError) || '')
        };
        if (result && result.lastSyncAt) patch.lastSyncAt = Number(result.lastSyncAt) || state.lastSyncAt;
      }
      setStatus(patch);
      return state;
    }).catch(function (error) {
      setStatus({ lastError: message(error) });
      return state;
    });
  }

  function message(error) {
    return String((error && error.message) || error || '');
  }

  function scheduleSync(delayMs) {
    if (!state.enabled || busy) return;
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = setTimeout(function () {
      scheduledTimer = null;
      runSync().catch(function () {});
    }, Math.max(1000, delayMs || 20000));
  }

  /**
   * Oba transporty mają swój „odczyt" i „zapis":
   *  - folder (SAF): read()/write() na pliku w wybranym folderze,
   *  - google: pull()/push() przez Drive REST.
   * Reszta silnika nie musi wiedzieć, gdzie fizycznie leży manifest.
   */
  function parseManifest(source) {
    if (!source || !source.manifest) return null;
    try { return JSON.parse(source.manifest); } catch (error) { return null; }
  }

  /**
   * Wszystkie pliki biblioteki w folderze. Warstwa folderu ma `list()` (jedno
   * zapytanie do folderu, potem odczyt plików); starsza warstwa zwracała jeden
   * plik przez `read()` i taki wariant też obsługujemy.
   */
  function readCloudFiles() {
    var api = transport && transport.api;
    if (!api) return Promise.resolve([]);
    if (typeof api.list === 'function') {
      return Promise.resolve(api.list()).then(function (result) {
        var list = (result && result.files) || (Array.isArray(result) ? result : []);
        return list.slice(0, MAX_CLOUD_FILES).map(function (entry) {
          var manifest = null;
          try {
            manifest = entry && entry.manifest ? JSON.parse(entry.manifest) : null;
          } catch (error) { manifest = null; }
          return {
            name: String((entry && entry.name) || LEGACY_FILE),
            manifest: manifest,
            modifiedTime: Number((entry && entry.modifiedTime) || 0) || 0
          };
        }).filter(function (file) { return !!file.manifest; });
      });
    }
    if (api.read) {
      return Promise.resolve(api.read()).then(function (one) {
        var manifest = parseManifest(one);
        if (!manifest) return [];
        return [{ name: LEGACY_FILE, manifest: manifest, modifiedTime: Number((one && one.modifiedTime) || 0) || 0 }];
      });
    }
    if (api.pull) {
      return Promise.resolve(api.pull()).then(function (one) {
        var manifest = parseManifest(one);
        if (!manifest) return [];
        return [{ name: LEGACY_FILE, manifest: manifest, modifiedTime: Number((one && one.modifiedTime) || 0) || 0 }];
      });
    }
    return Promise.resolve([]);
  }

  /** Pliki, które powinny być w folderze: te, które już w nim widzieliśmy. */
  function expectedFileNames() {
    var out = [];
    var seen = cloudMeta.seen || {};
    var oldest = nowMs() - EXPECT_FILE_MS;
    Object.keys(seen).forEach(function (name) {
      if (name && Number(seen[name] || 0) > oldest) out.push(name);
    });
    // Własnego pliku tu nie ma: gdy nie widać zapisu tego urządzenia, panel
    // powie o tym osobną linią, a ponawianie odczytu niczego by nie dało.
    return out;
  }

  /** Zapamiętuje, co leży w folderze; zapomina to, czego dawno tam nie ma. */
  function rememberCloudFiles(files) {
    if (!cloudMeta.seen) cloudMeta.seen = {};
    var now = nowMs();
    (files || []).forEach(function (file) {
      if (file && file.name) cloudMeta.seen[file.name] = now;
    });
    var oldest = now - EXPECT_FILE_MS;
    Object.keys(cloudMeta.seen).forEach(function (name) {
      if (Number(cloudMeta.seen[name] || 0) < oldest) delete cloudMeta.seen[name];
    });
  }

  function missingCloudFiles(files) {
    var have = {};
    (files || []).forEach(function (file) { if (file && file.name) have[file.name] = true; });
    return expectedFileNames().filter(function (name) { return !have[name]; });
  }

  /**
   * Odczyt z ponowieniem: świeżo wgrany plik bywa przez chwilę niewidoczny
   * (SAF na Androidzie, klient Drive na komputerze). Ponawiamy nie tylko wtedy,
   * gdy folder wygląda na pusty, ale i wtedy, gdy brakuje pliku, który już
   * w nim widzieliśmy — inaczej jedno urządzenie „nie widzi” biblioteki
   * drugiego, choć oba pliki leżą w tym samym folderze.
   */
  function readCloudFilesWithRetry(memoryManifest) {
    var memoryFresh = cloudMemoryState(memoryManifest).fresh;
    function suspicious(files) {
      if (!files.length) return memoryFresh || expectedFileNames().length > 0;
      return missingCloudFiles(files).length > 0;
    }
    function attempt(files, tries) {
      if (!suspicious(files) || tries >= READ_TRIES - 1) return Promise.resolve(files);
      return new Promise(function (resolve) {
        setTimeout(function () {
          readCloudFiles().then(function (again) {
            resolve(attempt(again.length ? again : files, tries + 1));
          }, function () { resolve(files); });
        }, Math.max(0, READ_RETRY_MS * (tries + 1)));
      });
    }
    return readCloudFiles().then(function (files) {
      return attempt(files, 0);
    }).then(function (files) {
      rememberCloudFiles(files);
      return files;
    });
  }

  /** Wszystkie pliki jako jeden obraz chmury: unia wpisów, kasowania wygrywają. */
  function unionCloudFiles(files) {
    var merged = null;
    (files || []).forEach(function (file) {
      if (!file || !file.manifest) return;
      merged = merged ? mergeManifests(merged, file.manifest).merged : file.manifest;
    });
    return merged;
  }

  function pushRemote(manifest, name) {
    if (!transport || !transport.api) return Promise.reject(new Error(T('noTransport')));
    var api = transport.api;
    if (transport.kind === 'folder') {
      if (!api.write) return Promise.reject(new Error(T('noTransport')));
      return Promise.resolve(api.write({ manifest: manifest, name: name || LEGACY_FILE }));
    }
    var payload = { manifest: manifest, mirror: !!state.mirror, name: name || LEGACY_FILE };
    return Promise.resolve(api.push(payload));
  }

  /** Pełny cykl: pobierz zdalny manifest, scal, zastosuj u siebie, wypchnij wynik. */
  function runSync(options) {
    var force = !!(options && options.force);
    if (busy) return Promise.resolve({ skipped: 'busy' });
    transport = transportFor(state.mode);
    if (!transport) return Promise.resolve({ skipped: 'no-plugin' });
    // Ręczne „Synchronizuj teraz" działa też przy wyłączonym automacie —
    // użytkownik klika świadomie i chce zobaczyć wynik.
    if (!state.enabled && !force) return Promise.resolve({ skipped: 'disabled' });

    busy = true;
    renderPanelStatus();
    var mergedManifest = null;
    var skipped = null;
    // Klucze obecne lokalnie po tej synchronizacji — na następny raz, żeby
    // odróżnić kasowanie od wpisu z chmury, którego tu nigdy nie było.
    var nextLocalKeys = null;

    return refreshStatus()
      .then(function () {
        if (!readyToSync()) {
          throw new Error(transport.kind === 'folder' ? T('folderMissing') : T('signedOut'));
        }
        return deviceInfo();
      })
      .then(function (device) {
        var snapshot = hostSnapshot();
        if (!snapshot) throw new Error(T('missingLibrary'));
        cloudMeta.libraryTracks = libraryTrackCount();
        cloudMeta.snapshotTracks = (snapshot.tracks || []).length;
        return stateGet('manifest').then(function (stored) {
          var previous = stored && stored.value ? stored.value : null;
          return stateGet('localKeys').then(function (keysStored) {
          return stateGet('cloudMemory').then(function (memoryStored) {
          var wasLocal = keysStored && keysStored.value ? keysStored.value : null;
          // Ostatni znany stan pliku: chroni wpisy, których niepełny odczyt nie pokaże.
          var memoryManifest = null;
          if (memoryStored && memoryStored.value) {
            memoryManifest = memoryStored.value;
            memoryManifest.at = Number(memoryStored.at || 0) || 0;
          }
          var localManifest = buildManifest(snapshot, previous, {
            id: device.deviceId, name: device.name, platform: devicePlatform()
          }, wasLocal);
          return readCloudFilesWithRetry(memoryManifest).then(function (files) {
            // Własny plik: ten, który zapiszemy. Cudzych nie ruszamy nigdy.
            var ownFile = ownFileName(device, files);
            var fresh = unionCloudFiles(files);
            if (!fresh && !(localManifest.tracks || []).length && !(localManifest.albums || []).length) {
              // Pusty folder i pusta biblioteka: nie ma czego wysyłać.
              skipped = 'nothing-to-send';
              setStatus({ lastError: T('nothingToSend') });
              renderPanelStatus();
              return null;
            }
            // Pamięć uzupełnia to, czego odczyt nie pokazał (np. plik jeszcze
            // niewidoczny w folderze Drive) — wpisy i urządzenia, nie kasowania.
            var withMemory = mergeCloudMemory(fresh, memoryManifest);
            var remoteManifest = withMemory.manifest;
            cloudMeta.restored = withMemory.restored.tracks + withMemory.restored.albums;
            if (remoteManifest) {
              var latestOther = null;
              files.forEach(function (file) {
                var manifest = file.manifest || {};
                var id = (manifest.device && manifest.device.id) || '';
                if (!id || id === device.deviceId) return;
                if (!latestOther || Number(manifest.updatedAt || 0) > Number((latestOther.manifest || {}).updatedAt || 0)) {
                  latestOther = file;
                }
              });
              var ownEntry = null;
              files.forEach(function (file) { if (file.name === ownFile) ownEntry = file; });
              var otherWriter = (latestOther && latestOther.manifest.device) || {};
              cloudMeta = {
                tracks: (remoteManifest.tracks || []).length,
                albums: (remoteManifest.albums || []).length,
                updatedAt: latestOther ? Number(latestOther.manifest.updatedAt || 0) || 0 : 0,
                device: String(otherWriter.name || otherWriter.id || ''),
                fromOther: !!latestOther,
                fileModifiedAt: Number((latestOther && latestOther.modifiedTime) || 0) || 0,
                files: cloudFilesInfo(files, remoteManifest, ownFile),
                ownFile: ownFile,
                ownFileAt: Number((ownEntry && ownEntry.modifiedTime) || 0) || 0,
                devices: (remoteManifest.devices || []).map(function (item) {
                  return String((item && item.name) || (item && item.id) || '');
                }).filter(Boolean),
                writeBack: cloudMeta.writeBack,
                restored: cloudMeta.restored,
                seen: cloudMeta.seen,
                libraryTracks: cloudMeta.libraryTracks,
                snapshotTracks: cloudMeta.snapshotTracks
              };
              statePut({ id: 'cloudMeta', value: cloudMeta }).catch(function () {});
            }
            var merged = mergeManifests(localManifest, remoteManifest);
            mergedManifest = merged.merged;
            var plan = buildApplyPlan(merged.incoming, snapshot);
            var touched = plan.trackUpdates.length + plan.albumUpdates.length + plan.newAlbums.length;
            var applyStep = Promise.resolve({ tracks: 0, albums: 0 });
            if (touched && typeof window.__pulsarSyncApply === 'function') {
              try {
                applyStep = Promise.resolve(window.__pulsarSyncApply(plan)).catch(function () {
                  return { tracks: 0, albums: 0 };
                });
              } catch (error) {
                applyStep = Promise.resolve({ tracks: 0, albums: 0 });
              }
            }
            return applyStep.then(function () {
              cloudEntries = cloudOnlyOf(mergedManifest, snapshot);
              // „Synchronizacja nic nie zrobiła" to najczęstsze wrażenie: nowe
              // utwory z innego urządzenia ogłaszamy raz, gdy się pojawią.
              if (cloudAnnounced) {
                var fresh = cloudEntries.filter(function (entry) {
                  return cloudKnownKeys.indexOf(entry.key) < 0;
                });
                if (fresh.length) {
                  var names = fresh.slice(0, 2).map(function (entry) {
                    return '«' + String(entry.title || entry.key) + '»';
                  }).join(', ');
                  if (fresh.length > 2) names += '…';
                  toast(T('newFromCloud') + fresh.length + ' ' + names + T('newFromCloudHint'));
                }
              }
              cloudKnownKeys = cloudEntries.map(function (entry) { return entry.key; });
              cloudAnnounced = true;
              nextLocalKeys = localKeyMap(localManifest, plan, mergedManifest);
              counters = {
                sent: (mergedManifest.tracks || []).length,
                received: plan.trackUpdates.length + plan.newAlbums.length + plan.albumUpdates.length,
                cloud: cloudEntries.length,
                removed: merged.stats.remoteRemoved.length
              };
              return cloudReplace(cloudEntries).then(function () {
                renderPanelStatus();
                return pushRemote(JSON.stringify(mergedManifest), ownFile);
              }).then(function () {
                // Ręczna synchronizacja sprawdza jeszcze, czy własny zapis widać
                // w pliku: gdy urządzenia patrzą na różne pliki, to jedyny sposób,
                // żeby to zauważyć.
                if (!force || typeof transport.api.read !== 'function') return null;
                return readCloudFiles().then(function (again) {
                  var mine = null;
                  (again || []).forEach(function (file) { if (file.name === ownFile) mine = file; });
                  var mineId = (mine && mine.manifest && mine.manifest.device) ? mine.manifest.device.id : '';
                  cloudMeta.writeBack = mineId === device.deviceId ? 'ok' : 'missing';
                  renderPanelStatus();
                  return null;
                }).catch(function () { return null; });
              });
            });
          });
        });
        });
        });
      })
      .then(function () {
        // Manifest zapisujemy jako „poprzedni" dopiero po udanym wysłaniu —
        // inaczej zmiany uznane za wysłane przepadłyby przy błędzie sieci.
        if (skipped) return null;
        return statePut({ id: 'manifest', value: mergedManifest });
      })
      .then(function () {
        if (skipped) return null;
        // Pamięć chmury: to, co właśnie trafiło do pliku, wróci z tego zapisu,
        // jeśli Drive pokaże kiedyś niepełną listę.
        return statePut({ id: 'cloudMemory', value: mergedManifest, at: nowMs() });
      })
      .then(function () {
        if (skipped) return null;
        return statePut({ id: 'localKeys', value: nextLocalKeys || { tracks: {}, albums: {} } });
      })
      .then(function () {
        if (skipped) return null;
        return statePut({ id: 'counters', value: counters });
      })
      .then(function () {
        busy = false;
        if (skipped) {
          renderPanelStatus();
          return { skipped: skipped, mode: transport.kind };
        }
        setStatus({ lastError: '', lastSyncAt: nowMs() });
        // Nowe utwory z innego urządzenia dociągamy dopiero po zakończonej
        // synchronizacji, żeby nie wejść w nią w trakcie (busy).
        var pending = cloudEntries.slice();
        setTimeout(function () { autoDownloadFresh(pending).catch(function () {}); }, 400);
        return { counters: counters, mode: transport.kind };
      })
      .catch(function (error) {
        busy = false;
        setStatus({ lastError: message(error) });
        return { error: message(error) };
      });
  }

  // ---------------------------------------------------------------- panel UI

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  /**
   * Każda akcja w panelu musi dać widoczny skutek. Status na dole bywa poza
   * ekranem na telefonie, więc komunikaty idą też jako toast runtime'u —
   * dzięki temu przycisk nigdy „nic nie robi".
   */
  function toast(text) {
    if (!text) return;
    try {
      var host = window.__pulsarHost;
      if (host && typeof host.toast === 'function') host.toast(String(text));
    } catch (error) {}
  }

  function note(text) {
    toast(text);
    renderPanelStatus();
  }

  function fail(text) {
    var message = String(text || '');
    toast(message);
    setStatus({ lastError: message });
  }

  function layerMissing(name) {
    return T('noPlugin').replace('{name}', String(name));
  }

  function pluginAvailable(name) {
    if (desktopAdapter() && name === FOLDER_PLUGIN) return true;
    var capacitor = window.Capacitor;
    if (capacitor && typeof capacitor.isPluginAvailable === 'function') {
      try { return !!capacitor.isPluginAvailable(name); } catch (error) { return false; }
    }
    return !!plugins()[name];
  }

  var LAYERS = [{ name: FOLDER_PLUGIN, kind: 'folder' }, { name: DRIVE_PLUGIN, kind: 'google' }];

  /** „folder ✔ · google ✖ (PulsarDrive)”: nazwa pluginu pojawia się tylko wtedy,
   *  gdy go brakuje — wtedy właśnie trzeba ją zgłosić. */
  function layersLine() {
    if (desktopAdapter()) {
      return T('layers') + 'folder (desktop) ✔ · google ' + (supportsGoogle() ? '✔' : '✖') + ' ' + T('googleOnlyAndroid');
    }
    return T('layers') + LAYERS.map(function (layer) {
      return layer.kind + (pluginAvailable(layer.name) ? ' ✔' : ' (' + layer.name + ') ✖');
    }).join(' · ');
  }

  /** Wywołanie natywnego pluginu z jednym, przewidywalnym komunikatem błędu. */
  function pluginCall(name, method, args) {
    return new Promise(function (resolve, reject) {
      if (!pluginAvailable(name)) {
        reject(new Error(layerMissing(name)));
        return;
      }
      var adapter = desktopAdapter();
      var api = (adapter && name === FOLDER_PLUGIN) ? adapter : plugins()[name];
      if (!api || typeof api[method] !== 'function') {
        reject(new Error(layerMissing(name)));
        return;
      }
      try {
        Promise.resolve(api[method](args || {})).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Zakładka i pane ustawień budowane są tak, jak zrobił to runtime:
   *  - panele mieszkają w #smBody (nie w menu), klasy: sm-pane/sm-card/sm-row,
   *  - zakładki w .sm-nav, a aktywną stronę pokazuje klasa `active`,
   *  - wybraną zakładkę runtime zapamiętuje w localStorage (pulsarSettingsTab).
   * Trzymanie się tych samych nazw i kontenerów to warunek, żeby panel działał
   * i wyglądał jak reszta ustawień.
   */
  function showPane(id) {
    var settingsMenu = document.getElementById('settingsMenu');
    if (!settingsMenu) return;
    // Runtime trzyma smShowPane w swoim domknięciu, więc używamy go tylko jeśli
    // został wystawiony; poza tym robimy dokładnie to samo.
    if (typeof window.smShowPane === 'function') {
      try { window.smShowPane(id); } catch (error) {}
    } else {
      settingsMenu.querySelectorAll('.sm-pane').forEach(function (pane) {
        pane.classList.toggle('active', pane.dataset.pane === id);
      });
      settingsMenu.querySelectorAll('.sm-tab').forEach(function (tab) {
        var on = tab.dataset.pane === id;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-current', on ? 'page' : 'false');
      });
    }
    var body = document.getElementById('smBody');
    if (body) body.scrollTop = 0;
    if (id === 'cloud') {
      // Okno ustawień animuje się, więc mierzymy też chwilę później.
      setTimeout(ensureCloudScroll, 60);
      setTimeout(ensureCloudScroll, 420);
    }
    // Wyszukiwarka ustawień: czyścimy filtr i pozwalamy runtime'owi go przeliczyć.
    var search = document.getElementById('smSearch');
    if (search && search.value) {
      search.value = '';
      try { search.dispatchEvent(new Event('input')); } catch (error) {}
    }
    try { localStorage.setItem('pulsarSettingsTab', id); } catch (error) {}
  }

  /**
   * Przewijanie panelu chmury. Runtime trzyma panele ustawień w #smBody
   * (`overflow-y: auto`), ale gdy ten kontener nie dostanie ograniczonej
   * wysokości, treść ucieka poza ekran i nie ma jak do niej dotrzeć palcem —
   * widać tylko górę zakładki. Dlatego: (1) nie pozwalamy jednemu wpisowi
   * rozepchnąć wiersza w poziomie, (2) gdy kontener nie przewija, sam panel
   * staje się kontenerem przewijania o wysokości zmierzonej do okna ustawień,
   * (3) jeśli WebView i tego nie przewinie, przewijamy treść za palcem sami.
   */
  var CLOUD_STYLE_ID = 'pulsarCloudPanelStyles';
  var CLOUD_SCROLL_ATTR = 'data-cloud-scroll';
  var cloudTouch = { active: false, startY: 0, startTop: 0, lastTop: 0, still: 0 };

  function ensureCloudStyles() {
    if (document.getElementById(CLOUD_STYLE_ID)) return;
    var head = document.head || document.body;
    if (!head || typeof document.createElement !== 'function') return;
    var style = document.createElement('style');
    style.setAttribute('id', CLOUD_STYLE_ID);
    style.textContent = [
      '.sm-pane[data-pane="cloud"] .sm-row, .sm-pane[data-pane="cloud"] .sm-txt { min-width: 0; }',
      '.sm-pane[data-pane="cloud"] .sm-lab, .sm-pane[data-pane="cloud"] .sm-desc { overflow-wrap: anywhere; }',
      '.sm-pane[data-pane="cloud"][' + CLOUD_SCROLL_ATTR + '="self"] { overflow-y: auto; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; padding-bottom: 18px; }'
    ].join('\n');
    head.appendChild(style);
  }

  function pixels(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : 0;
  }

  /** Najbliższy przodek, który przewija (w runtime to #smBody). */
  function cloudScrollHost(pane) {
    var node = pane ? pane.parentNode : null;
    while (node && node !== document.body && node.nodeType !== 9) {
      try {
        var style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(node) : null;
        if (style && /auto|scroll/.test(String(style.overflowY || ''))) return node;
      } catch (error) { /* brak getComputedStyle — idziemy wyżej */ }
      node = node.parentNode;
    }
    return null;
  }

  /** Pomiar: czy panel jest widoczny, czy się nie mieści i czy kontener przewija. */
  function cloudScrollInfo(pane) {
    var rect = null;
    try {
      rect = pane && typeof pane.getBoundingClientRect === 'function' ? pane.getBoundingClientRect() : null;
    } catch (error) { rect = null; }
    var height = pixels(rect && rect.height);
    var top = Number(rect && rect.top) || 0;
    var host = cloudScrollHost(pane);
    var viewport = pixels(window.innerHeight);
    var hostHeight = pixels(host && host.clientHeight) || viewport;
    var content = pixels(pane && pane.scrollHeight);
    var hostScrolls = false;
    if (host) {
      try { hostScrolls = pixels(host.scrollHeight) > pixels(host.clientHeight) + 2; } catch (error) { hostScrolls = false; }
    }
    var bottom = 0;
    try {
      var dialog = pane && typeof pane.closest === 'function' ? pane.closest('.sm-dialog') : null;
      if (dialog && typeof dialog.getBoundingClientRect === 'function') {
        bottom = Number(dialog.getBoundingClientRect().bottom) || 0;
      }
    } catch (error) { bottom = 0; }
    if (!bottom) bottom = viewport || (top + height);
    if (viewport && bottom > viewport) bottom = viewport - 8;
    return {
      visible: height > 0,
      overflows: !!content && !!hostHeight && content > hostHeight + 2,
      hostScrolls: hostScrolls,
      host: !!host,
      hostHeight: hostHeight,
      content: content,
      top: Math.round(top),
      bottom: Math.round(bottom),
      room: Math.max(160, Math.round(bottom - top - 8)),
      mode: (pane && pane.getAttribute(CLOUD_SCROLL_ATTR)) || 'host'
    };
  }

  /** Panel sam się przewija, gdy kontener ustawień tego nie potrafi. */
  function ensureCloudScroll() {
    var pane = panel;
    if (!pane || typeof pane.getAttribute !== 'function') return;
    var info = cloudScrollInfo(pane);
    if (!info.visible || !info.overflows || info.hostScrolls) {
      if (pane.style && pane.style.maxHeight) pane.style.maxHeight = '';
      pane.removeAttribute(CLOUD_SCROLL_ATTR);
      return;
    }
    pane.style.maxHeight = info.room + 'px';
    pane.setAttribute(CLOUD_SCROLL_ATTR, 'self');
  }

  /** Ostatnia deska ratunku: gdy WebView nie przewinie panelu, robimy to sami. */
  function armCloudTouchScroll(pane) {
    if (!pane || pane.__pulsarCloudTouch) return;
    pane.__pulsarCloudTouch = true;
    pane.addEventListener('touchstart', function (event) {
      var touch = event.touches && event.touches[0];
      if (!touch || pane.getAttribute(CLOUD_SCROLL_ATTR) !== 'self') { cloudTouch.active = false; return; }
      cloudTouch.active = true;
      cloudTouch.still = 0;
      cloudTouch.startY = Number(touch.clientY) || 0;
      cloudTouch.startTop = Number(pane.scrollTop) || 0;
      cloudTouch.lastTop = cloudTouch.startTop;
    }, { passive: true });
    pane.addEventListener('touchmove', function (event) {
      if (!cloudTouch.active) return;
      var touch = event.touches && event.touches[0];
      if (!touch) return;
      var moved = Math.abs((Number(pane.scrollTop) || 0) - cloudTouch.lastTop) > 0.5;
      if (moved) {
        // WebView przewija sam — nie wchodzimy mu w drogę.
        cloudTouch.lastTop = Number(pane.scrollTop) || 0;
        cloudTouch.startTop = cloudTouch.lastTop;
        cloudTouch.startY = Number(touch.clientY) || 0;
        cloudTouch.still = 0;
        return;
      }
      cloudTouch.still++;
      if (cloudTouch.still < 2) return;
      var max = Math.max(0, pixels(pane.scrollHeight) - pixels(pane.clientHeight));
      var next = cloudTouch.startTop - ((Number(touch.clientY) || 0) - cloudTouch.startY);
      pane.scrollTop = Math.max(0, Math.min(max, next));
    }, { passive: true });
    pane.addEventListener('touchend', function () { cloudTouch.active = false; }, { passive: true });
    pane.addEventListener('touchcancel', function () { cloudTouch.active = false; }, { passive: true });
  }

  function panelHtml() {
    return '' +
      '<h2 class="sm-pane-title" data-cloud-text="title"></h2>' +
      '<div class="sm-card">' +
      '  <h3 class="sm-cap" data-cloud-text="howCap"></h3>' +
      '  <div class="sm-row" data-cloud-row="mode">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="modeLabel"></span>' +
      '      <span class="sm-desc" data-cloud-text="modeDesc"></span></div>' +
      '    <select class="sm-select" data-cloud="mode">' +
      '      <option value="folder" data-cloud-text="modeFolder"></option>' +
      '      <option value="google" data-cloud-text="modeGoogle"></option>' +
      '    </select>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="enabled"></span></div>' +
      '    <label class="switch"><input type="checkbox" data-cloud="enabled"><span class="slider"></span></label>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="autoLab"></span>' +
      '      <span class="sm-desc" data-cloud-text="autoDesc"></span></div>' +
      '    <label class="switch"><input type="checkbox" data-cloud="auto"><span class="slider"></span></label>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="statusCap"></span>' +
      '      <span class="sm-desc" data-cloud="status"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="sync" data-cloud-text="syncNow"></button>' +
      '  </div>' +
      '</div>' +
      '<div class="sm-card sm-hide" data-cloud-section="cloudOnly">' +
      '  <h3 class="sm-cap" data-cloud-text="cloudOnlyCap"></h3>' +
      '  <div class="sm-row"><div class="sm-txt"><span class="sm-desc" data-cloud-text="cloudOnlyHint"></span></div></div>' +
      '  <div data-cloud="cloudOnlyList"></div>' +
      '  <div class="sm-row sm-hide" data-cloud-row="downloadAll">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="downloadAllHint"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="downloadAll"></button>' +
      '  </div>' +
      '</div>' +
      '<div class="sm-card" data-cloud-section="folder">' +
      '  <h3 class="sm-cap" data-cloud-text="folderCap"></h3>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="folderLab"></span>' +
      '      <span class="sm-desc" data-cloud-text="folderHint"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="choose" data-cloud-text="chooseFolder"></button>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="folderForgetHint"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="forget" data-cloud-text="forgetFolder"></button>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="refreshFilesHint"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="refresh" data-cloud-text="refreshFiles"></button>' +
      '  </div>' +
      '</div>' +
      '<div class="sm-card" data-cloud-section="google">' +
      '  <h3 class="sm-cap" data-cloud-text="googleCap"></h3>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="googleHint"></span></div>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="signInLab"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="signin" data-cloud-text="signIn"></button>' +
      '    <button type="button" class="sm-act" data-cloud="signout" data-cloud-text="signOut"></button>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="mirror"></span></div>' +
      '    <label class="switch"><input type="checkbox" data-cloud="mirror"><span class="slider"></span></label>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="clientId"></span></div>' +
      '    <input class="sm-select" type="text" data-cloud="clientId" autocomplete="off" spellcheck="false">' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="clientSecret"></span></div>' +
      '    <input class="sm-select" type="password" data-cloud="clientSecret" autocomplete="off">' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-lab" data-cloud-text="redirectUri"></span></div>' +
      '    <input class="sm-select" type="text" data-cloud="redirectUri" autocomplete="off" spellcheck="false">' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="googleHintFields"></span></div>' +
      '  </div>' +
      '  <div class="sm-row">' +
      '    <div class="sm-txt"><span class="sm-desc" data-cloud-text="googleHelp"></span></div>' +
      '    <button type="button" class="sm-act" data-cloud="save" data-cloud-text="save"></button>' +
      '  </div>' +
      '</div>' +
      '</div>';
  }

  /** Wstawia aktualne teksty i placeholdery we wszystkie elementy panelu. */
  function applyLabels(pane) {
    var redirect = 'pl.ursusel.pulsar.android:/oauth2redirect';
    pane.querySelectorAll('[data-cloud-text]').forEach(function (element) {
      var key = element.getAttribute('data-cloud-text');
      var text = T(key);
      if (element.tagName === 'OPTION') element.textContent = text;
      else element.textContent = text;
    });
    var fields = { clientId: 'clientId', clientSecret: 'clientSecret', redirectUri: 'redirectUri' };
    Object.keys(fields).forEach(function (name) {
      var input = pane.querySelector('[data-cloud="' + name + '"]');
      if (input) input.setAttribute('placeholder', T(fields[name]));
    });
    var redirectInput = pane.querySelector('[data-cloud="redirectUri"]');
    if (redirectInput && !redirectInput.value) redirectInput.value = redirect;
    var status = pane.querySelector('[data-cloud="status"]');
    if (status) status.style.whiteSpace = 'pre-line';
    // Desktop: ten sam mechanizm folderu, ale opisy mówią o kliencie Drive,
    // bo tu nie ma systemowego okna Dokumentów z kontem Google.
    if (desktopAdapter()) {
      var hint = pane.querySelector('[data-cloud-text="folderHint"]');
      if (hint) hint.textContent = T('folderHintDesktop');
      var lab = pane.querySelector('[data-cloud-text="folderLab"]');
      if (lab) lab.textContent = T('folderLabDesktop');
      var choose = pane.querySelector('[data-cloud="choose"]');
      if (choose) choose.textContent = T('chooseFolder');
    }
    var autoDesc = pane.querySelector('[data-cloud-text="autoDesc"]');
    if (autoDesc && !desktopAdapter()) autoDesc.textContent = T('autoDescMetered');
    if (panelTab) panelTab.querySelector('[data-cloud-text="tab"]').textContent = T('tab');
  }

  var panelTab = null;

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    var settingsMenu = document.getElementById('settingsMenu');
    if (!settingsMenu) return null;

    var pane = settingsMenu.querySelector('.sm-pane[data-pane="cloud"]');
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'sm-pane';
      pane.setAttribute('data-pane', 'cloud');
      pane.innerHTML = panelHtml();

      // Panele ustawień runtime'u siedzą w #smBody (przewijanie i filtr
      // wyszukiwarki działają tylko dla tej zawartości).
      var body = document.getElementById('smBody');
      (body || settingsMenu).appendChild(pane);

      var nav = settingsMenu.querySelector('.sm-nav') ||
        (settingsMenu.querySelector('.sm-tab') ? settingsMenu.querySelector('.sm-tab').parentNode : null);
      var tab = document.createElement('button');
      tab.setAttribute('type', 'button');
      tab.className = 'sm-tab';
      tab.setAttribute('data-pane', 'cloud');
      tab.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 8.6 4.5 4.5 0 0 0 7 18z"/></svg>' +
        '<span data-cloud-text="tab"></span>';
      if (nav) nav.appendChild(tab);
      panelTab = tab;
      tab.addEventListener('click', function () { showPane('cloud'); });

      ensureCloudStyles();
      armCloudTouchScroll(pane);
      wirePanel(pane);
    } else if (!panelTab) {
      panelTab = settingsMenu.querySelector('.sm-tab[data-pane="cloud"]');
    }

    panel = pane;
    // Panel musi wisieć w kontenerze, który przewija (#smBody) — gdy trafił
    // gdzie indziej, wracamy na miejsce.
    var scrollBody = document.getElementById('smBody');
    if (scrollBody && pane.parentNode !== scrollBody) scrollBody.appendChild(pane);
    ensureCloudStyles();
    armCloudTouchScroll(pane);
    applyLabels(pane);
    renderPanelStatus();
    return pane;
  }

  function wirePanel(pane) {
    function find(name) { return pane.querySelector('[data-cloud="' + name + '"]'); }
    function field(name) { var element = find(name); return element ? String(element.value || '').trim() : ''; }

    var mode = find('mode');
    if (mode) mode.addEventListener('change', function () { setMode(String(mode.value || 'folder')); });

    var enabled = find('enabled');
    if (enabled) enabled.addEventListener('change', function () {
      state.enabled = !!enabled.checked;
      saveSettings();
      if (!state.enabled) { renderPanelStatus(); return; }
      if (!readyToSync()) {
        // Zamiast cichego nic-nie-robienia: powiedz, czego brakuje.
        fail(state.mode === 'folder' ? T('folderMissing') : T('needConfig'));
        return;
      }
      runSync().catch(function () {});
    });

    var auto = find('auto');
    if (auto) auto.addEventListener('change', function () {
      state.autoDownload = !!auto.checked;
      saveSettings();
      // Reakcja widoczna od razu — żaden przełącznik nie może być cichy.
      note(state.autoDownload ? T('autoOn') : T('autoOff'));
      renderPanelStatus();
    });

    var mirror = find('mirror');
    if (mirror) mirror.addEventListener('change', function () {
      state.mirror = !!mirror.checked;
      var api = plugins()[DRIVE_PLUGIN];
      if (api && api.setMirror) api.setMirror({ enabled: state.mirror }).catch(function () {});
    });

    var choose = find('choose');
    if (choose) choose.addEventListener('click', function () {
      pluginCall(FOLDER_PLUGIN, 'pickFolder').then(function () {
        // Nowy folder to nowa chmura: stara pamięć nie może tu nic odtwarzać
        // ani blokować pierwszego zapisu.
        return clearCloudMemory();
      }).then(refreshStatus).then(function () {
        if (!state.folderReady) return null; // np. użytkownik zamknął okno wyboru
        note(T('folderReadyToast'));
        if (state.enabled) return runSync();
        return null;
      }).catch(function (error) { fail(message(error)); });
    });

    var forget = find('forget');
    if (forget) forget.addEventListener('click', function () {
      pluginCall(FOLDER_PLUGIN, 'forget').then(function () {
        return clearCloudMemory();
      }).then(refreshStatus).catch(function (error) { fail(message(error)); });
    });

    var signin = find('signin');
    if (signin) signin.addEventListener('click', function () {
      // Nie otwieramy przeglądarki bez sensu: Google odrzuca teraz ten sposób
      // logowania w aplikacjach na Androida, więc przycisk tłumaczy sytuację
      // i wskazuje tryb, który działa. Warstwa Drive zostaje gotowa do
      // podłączenia obsługiwanego logowania (Play Services).
      fail(T('browserSignInRetired'));
    });

    var signout = find('signout');
    if (signout) signout.addEventListener('click', function () {
      pluginCall(DRIVE_PLUGIN, 'signOut').then(refreshStatus).catch(function (error) { fail(message(error)); });
    });

    var save = find('save');
    if (save) save.addEventListener('click', function () {
      pluginCall(DRIVE_PLUGIN, 'configure', {
        clientId: field('clientId'), clientSecret: field('clientSecret'), redirectUri: field('redirectUri')
      }).then(refreshStatus).then(function () {
        note(T('configSaved'));
      }).catch(function (error) { fail(message(error)); });
    });

    var all = find('downloadAll');
    if (all) all.addEventListener('click', function () {
      all.disabled = true;
      downloadAllCloudTracks().then(function () { all.disabled = false; })
        .catch(function (error) { all.disabled = false; fail(message(error)); });
    });

    var refresh = find('refresh');
    if (refresh) refresh.addEventListener('click', function () {
      refresh.disabled = true;
      refreshCloudFiles().then(function () { refresh.disabled = false; })
        .catch(function (error) { refresh.disabled = false; fail(message(error)); });
    });

    var sync = find('sync');
    if (sync) sync.addEventListener('click', function () {
      runSync({ force: true }).then(function (result) {
        result = result || {};
        if (result.skipped === 'no-plugin') { fail(T('noTransport')); return; }
        if (result.skipped === 'disabled') { fail(T('syncDisabled')); return; }
        if (result.skipped === 'nothing-to-send') { note(T('nothingToSend')); return; }
        if (result.error) { fail(result.error); return; }
        if (result.counters) {
          note(T('syncDone') + ' ' + T('sent') + result.counters.sent + ' · ' + T('received') + result.counters.received +
            (result.counters.cloud ? ' · ' + T('inCloud') + result.counters.cloud : ''));
        } else if (result.skipped === 'busy') {
          note(T('syncing'));
        }
      }).catch(function (error) { fail(message(error)); });
    });
  }

  function netApi() {
    // Runtime trzyma wyszukiwanie sieciowe pod __player.__net — to samo na
    // Androidzie i na desktopie, więc pobieranie działa na każdej platformie.
    var player = window.__player;
    var net = player && player.__net;
    if (!net || typeof net.search !== 'function' || typeof net.importIdx !== 'function') return null;
    return net;
  }

  /** Identyfikator YouTube z wpisu w chmurze (albo pusty, gdy to plik z dysku). */
  function downloadIdOf(entry) {
    if (entry && entry.provider === 'youtube' && entry.ytId) return String(entry.ytId);
    var match = /^youtube:([\w-]{6,})$/.exec(String((entry && entry.key) || ''));
    return match ? match[1] : '';
  }

  function cloudLoad() {
    return withStore('cloud', 'readonly', function (store) {
      return typeof store.getAll === 'function' ? store.getAll() : { result: [] };
    }).then(function (rows) {
      cloudEntries = Array.isArray(rows) ? rows : [];
    }).catch(function () {});
  }

  /** Import jest asynchroniczny — czekamy, aż utwór naprawdę będzie w bibliotece. */
  function waitForTrack(key, waitMs) {
    return new Promise(function (resolve) {
      var deadline = nowMs() + waitMs;
      function step() {
        var snapshot = null;
        try {
          snapshot = typeof window.__pulsarSyncSnapshot === 'function' ? window.__pulsarSyncSnapshot() : null;
        } catch (error) {
          snapshot = null;
        }
        var found = !!(snapshot && (snapshot.tracks || []).some(function (item) {
          return item && item.key === key;
        }));
        if (found) { resolve(true); return; }
        if (nowMs() >= deadline) { resolve(false); return; }
        setTimeout(step, IMPORT_POLL_MS);
      }
      step();
    });
  }

  /**
   * Dociąga utwór z YouTube na tym urządzeniu. Wyszukiwanie i zapis robi sam
   * runtime (z netId, okładką i tagami), a potem biblioteka idzie do chmury —
   * dzięki temu znika z listy „tylko w chmurze" po obu stronach.
   */
  /** Co się stało z ostatnim pobieraniem — dla panelu. */
  function stampDownload(entry, ok, errorText) {
    if (!ok && canFetchFromYoutube(entry)) probeDownloader();
    autoLast = {
      key: String((entry && entry.key) || ''),
      title: String((entry && entry.title) || (entry && entry.key) || ''),
      ok: !!ok,
      error: String(errorText || ''),
      at: nowMs()
    };
    renderPanelStatus();
    return ok;
  }

  /**
   * Importuje utwór na tym urządzeniu. `quiet` = tryb automatyczny.
   *
   * Utwór z YouTube (ma identyfikator) szukamy po identyfikatorze. Utwór, który
   * na innym urządzeniu leży jako zwykły plik, też da się tu ściągnąć: jeśli ma
   * tytuł i autora, szukamy go na YouTube i zapisujemy najlepiej pasujący wynik.
   * Dzięki temu muzyka z komputera przestaje być niedostępna na telefonie.
   */
  function importCloudTrack(entry, quiet) {
    var key = (entry && entry.key) || '';
    var id = downloadIdOf(entry);
    var query = id ? '' : searchQueryOf(entry);
    if (!id && !query) { fail(T('downloadNoTitle')); return Promise.resolve(stampDownload(entry, false, T('downloadNoTitle'))); }
    var net = netApi();
    if (!net) { fail(T('downloadNoApi')); return Promise.resolve(stampDownload(entry, false, T('downloadNoApi'))); }
    if (typeof net.enabled === 'function' && net.enabled() === false) {
      fail(T('downloadOff'));
      return Promise.resolve(stampDownload(entry, false, T('downloadOff')));
    }
    note((quiet ? T('autoDownloading') : T('downloading')) + ((entry && entry.title) || ('YouTube ' + id)) +
      (id ? '' : T('searchingByTitle')));
    // Szukanie po tytule ma trafiać w YouTube — inne źródła zostawiamy zakładce
    // Sieć; po wyszukiwaniu wracamy do ustawienia użytkownika.
    var previousProvider = '';
    if (!id && typeof net.setProvider === 'function' && typeof net.provider === 'function') {
      try {
        previousProvider = String(net.provider() || '');
        if (previousProvider && previousProvider !== 'youtube') net.setProvider('youtube');
      } catch (error) { previousProvider = ''; }
    }
    function restoreProvider() {
      if (!previousProvider) return;
      try { net.setProvider(previousProvider); } catch (error) { /* ustawienie dostawcy to nie pobieranie */ }
    }
    var importedKey = '';
    return Promise.resolve().then(function () {
      return net.search(id ? 'https://www.youtube.com/watch?v=' + id : query);
    }).then(function () {
      var results = typeof net.results === 'function' ? (net.results() || []) : [];
      var index = pickResultIndex(results, id, entry);
      if (index < 0) throw new Error(T('downloadNoResult'));
      var item = results[index] || {};
      var itemId = String(item.ytId || item.id || '');
      importedKey = itemId ? 'youtube:' + itemId : key;
      return net.importIdx(index);
    }).then(function () {
      restoreProvider();
      if (id) return waitForTrack(key, IMPORT_WAIT_MS);
      return waitForMatch(entry, importedKey, IMPORT_WAIT_MS);
    }).then(function (found) {
      if (!found) { fail(T('downloadUnconfirmed')); return stampDownload(entry, false, T('downloadUnconfirmed')); }
      if (!id) rememberDerived(entry, importedKey);
      note(T('downloaded'));
      return stampDownload(entry, true, '');
    }).catch(function (error) {
      restoreProvider();
      fail(message(error));
      return stampDownload(entry, false, message(error));
    });
  }

  /** Import jest asynchroniczny — czekamy, aż utwór naprawdę będzie w bibliotece. */
  function waitForMatch(entry, importedKey, waitMs) {
    var want = namePair(entry);
    // W testach i przy krótkim oknie czekania odpytywanie musi być gęstsze;
    // w normalnej pracy zostaje 1500 ms, żeby nie męczyć biblioteki.
    var pollMs = Math.min(IMPORT_POLL_MS, Math.max(20, Math.floor(waitMs / 4)));
    return new Promise(function (resolve) {
      var deadline = nowMs() + waitMs;
      function step() {
        var snapshot = null;
        try {
          snapshot = typeof window.__pulsarSyncSnapshot === 'function' ? window.__pulsarSyncSnapshot() : null;
        } catch (error) { snapshot = null; }
        var found = !!(snapshot && (snapshot.tracks || []).some(function (item) {
          if (!item) return false;
          if (importedKey && item.key === importedKey) return true;
          // Runtime odmawia zapisu duplikatu (ten sam tytuł i wykonawca) — to
          // też znaczy, że utwór jest już tutaj.
          return !!want && namePair(item) === want;
        }));
        if (found) { resolve(true); return; }
        if (nowMs() >= deadline) { resolve(false); return; }
        setTimeout(step, pollMs);
      }
      step();
    });
  }

  /** Pamięta, że ten wpis z chmury jest tu już jako pobrany utwór. */
  function rememberDerived(entry, importedKey) {
    if (!entry || !entry.key || !importedKey) return;
    derivedTracks[entry.key] = { key: importedKey, at: nowMs() };
    if (Object.keys(derivedTracks).length > 500) {
      Object.keys(derivedTracks).slice(0, 100).forEach(function (oldKey) { delete derivedTracks[oldKey]; });
    }
    statePut({ id: 'cloudDerived', value: derivedTracks }).catch(function () {});
  }

  /**
   * Czy pobieranie z YouTube ma z czym pracować. Na komputerze dźwięk ciągnie
   * mostek (yt-dlp) — bez niego przycisk „Pobierz tutaj” i automat kończą się
   * niczym, więc panel musi powiedzieć to wprost.
   */
  function downloaderHint() {
    var net = netApi();
    var yt = net && net.youtube;
    if (!net || !yt || typeof yt.bridge !== 'function') return '';
    var info = null;
    try { info = yt.bridge() || {}; } catch (error) { return ''; }
    var port = Number(info.port || 0) || 0;
    if (downloadProbe) {
      if (downloadProbe.ok) return '';
      return T('bridgeDown') + (downloadProbe.port ? ' (' + downloadProbe.port + ')' : '');
    }
    if (info.ok) return '';
    return T('bridgeCheck') + (port ? ' (' + port + ')' : '');
  }

  /** Pyta mostek, czy odpowiada — tylko po nieudanym pobieraniu, raz na 5 minut. */
  function probeDownloader() {
    var net = netApi();
    var yt = net && net.youtube;
    if (!yt || typeof yt.probeBridge !== 'function') return;
    if (downloadProbeBusy || (downloadProbe && nowMs() - downloadProbe.at < 5 * 60 * 1000)) return;
    downloadProbeBusy = true;
    Promise.resolve().then(function () { return yt.probeBridge(); }).then(function (ok) {
      downloadProbeBusy = false;
      var info = {};
      try { info = (typeof yt.bridge === 'function' && yt.bridge()) || {}; } catch (error) { info = {}; }
      downloadProbe = { ok: !!ok, port: Number(info.port || 0) || 0, at: nowMs() };
      renderPanelStatus();
    }).catch(function () { downloadProbeBusy = false; });
  }

  /**
   * Ile utworów z YouTube czeka na pobranie tutaj. */
  function autoWaitingCount() {
    return (cloudEntries || []).filter(function (entry) { return canFetchFromYoutube(entry); }).length;
  }

  /**
   * Ręczne „Pobierz wszystkie tutaj": pomija przełącznik automatu i okno
   * ponowień — użytkownik kliknął, więc chce pobrania, a nie odczekania 6 h.
   */
  function downloadAllCloudTracks() {
    var queue = (cloudEntries || []).filter(function (entry) { return canFetchFromYoutube(entry); });
    if (!queue.length) { fail(T('downloadNothing')); return Promise.resolve({ skipped: 'nothing' }); }
    var done = 0;
    var chain = Promise.resolve();
    queue.slice(0, MAX_CLOUD_ROWS).forEach(function (entry) {
      chain = chain.then(function () {
        return importCloudTrack(entry, false).then(function (ok) { if (ok) done++; });
      });
    });
    return chain.then(function () {
      if (!done) return { skipped: 'not-imported' };
      return runSync({ force: true });
    });
  }

  /**
   * Ręczne sprawdzenie folderu: pokazuje dokładnie, które pliki biblioteki
   * widzi to urządzenie. Gdy Dysk pokazuje folder z opóźnieniem, to jedyny
   * sposób, żeby odróżnić „nie ma pliku” od „jeszcze go nie widzę”.
   */
  function refreshCloudFiles() {
    transport = transportFor(state.mode);
    if (!transport || !transport.api) { fail(T('noTransport')); return Promise.resolve([]); }
    var device = null;
    return deviceInfo().then(function (info) {
      device = info;
      return readCloudFiles();
    }).then(function (files) {
      var own = ownFileName(device, files);
      cloudMeta.files = cloudFilesInfo(files, unionCloudFiles(files), own);
      cloudMeta.ownFile = own;
      cloudMeta.seenAt = nowMs();
      statePut({ id: 'cloudMeta', value: cloudMeta }).catch(function () {});
      var names = files.map(function (file) { return file.name; }).join(', ');
      var text = T('filesSeen') + (files.length ? files.length + ' — ' + names : T('filesNone'));
      if (files.length === 1 && files[0].name === own) text += ' ' + T('onlyOwnFile');
      note(text);
      renderPanelStatus();
      return files;
    }).catch(function (error) {
      fail(message(error));
      return [];
    });
  }

  function downloadCloudTrack(key) {
    var entry = null;
    (cloudEntries || []).forEach(function (item) { if (!entry && item && item.key === key) entry = item; });
    if (!entry) entry = { key: key };
    return importCloudTrack(entry, false).then(function (ok) {
      return ok ? runSync({ force: true }) : { skipped: 'not-imported' };
    });
  }

  /**
   * Po synchronizacji dociąga nowe utwory z YouTube z innego urządzenia.
   * Po kilka na raz i nie częściej niż raz na 6 h dla tego samego klucza, żeby
   * jedna awaria nie zamieniła się w pętlę pobierania.
   */
  function autoDownloadFresh(entries) {
    if (!state.autoDownload || autoBusy) return Promise.resolve(0);
    var now = nowMs();
    if (autoBatchAt && now - autoBatchAt < AUTO_COOLDOWN_MS) return Promise.resolve(0);
    var queue = (entries || []).filter(function (entry) {
      if (!entry || !canFetchFromYoutube(entry)) return false;
      return now - (autoTried[entry.key] || 0) > AUTO_RETRY_MS;
    }).slice(0, AUTO_MAX_PER_SYNC);
    if (!queue.length) return Promise.resolve(0);
    autoBusy = true;
    autoBatchAt = now;
    var done = 0;
    var chain = Promise.resolve();
    queue.forEach(function (entry) {
      chain = chain.then(function () {
        autoTried[entry.key] = nowMs();
        return importCloudTrack(entry, true).then(function (ok) { if (ok) done++; });
      });
    });
    return chain.then(function () {
      autoBusy = false;
      if (!done) return 0;
      return runSync({ force: true }).then(function () { return done; }).catch(function () { return done; });
    });
  }

  function renderCloudOnly(pane) {
    var card = pane.querySelector('[data-cloud-section="cloudOnly"]');
    var list = pane.querySelector('[data-cloud="cloudOnlyList"]');
    if (!card || !list) return;
    var entries = cloudEntries || [];
    card.classList.toggle('sm-hide', !entries.length);
    if (!entries.length) { list.innerHTML = ''; return; }

    var downloadable = autoWaitingCount();
    var allRow = pane.querySelector('[data-cloud-row="downloadAll"]');
    var allButton = pane.querySelector('[data-cloud="downloadAll"]');
    if (allRow) allRow.classList.toggle('sm-hide', !downloadable);
    if (allButton) allButton.textContent = T('downloadAll') + ' (' + downloadable + ')';

    var shown = entries.slice(0, MAX_CLOUD_ROWS);
    var html = '';
    shown.forEach(function (entry) {
      var id = downloadIdOf(entry);
      var query = id ? '' : searchQueryOf(entry);
      var title = String((entry && entry.title) || (entry && entry.key) || '');
      var artist = String((entry && entry.artist) || '');
      var desc = query ? (artist ? artist + ' · ' : '') + T('searchByNameHint') : artist;
      html += '<div class="sm-row"><div class="sm-txt">' +
        '<span class="sm-lab">' + escapeHtml(title) + '</span>' +
        '<span class="sm-desc">' + escapeHtml(desc) + '</span>' +
        '</div>';
      if (id || query) {
        html += '<button type="button" class="sm-act" data-cloud-download="' + escapeHtml(entry.key) + '">' +
          escapeHtml(id ? T('downloadHere') : T('downloadFromYoutube')) + '</button>';
      } else {
        html += '<div class="sm-txt"><span class="sm-desc">' + escapeHtml(T('downloadNoTitle')) + '</span></div>';
      }
      html += '</div>';
    });
    if (entries.length > shown.length) {
      html += '<div class="sm-row"><div class="sm-txt"><span class="sm-desc">' +
        escapeHtml(T('cloudOnlyMore') + (entries.length - shown.length) + T('cloudOnlyMoreTail')) +
        '</span></div></div>';
    }
    list.innerHTML = html;
    // innerHTML nie przenosi nasłuchów, więc podpinamy je po każdym renderze.
    list.querySelectorAll('[data-cloud-download]').forEach(function (button) {
      button.addEventListener('click', function () {
        button.disabled = true;
        downloadCloudTrack(button.getAttribute('data-cloud-download') || '').then(function () {
          button.disabled = false;
        }).catch(function () { button.disabled = false; });
      });
    });
  }

  function renderPanelStatus() {
    var pane = ensurePanel();
    if (!pane) return;
    var isFolder = state.mode === 'folder';

    var googleOk = supportsGoogle();
    var modeRow = pane.querySelector('[data-cloud-row="mode"]');
    if (modeRow) modeRow.classList.toggle('sm-hide', !googleOk);
    var folderSection = pane.querySelector('[data-cloud-section="folder"]');
    if (folderSection) folderSection.classList.toggle('sm-hide', !isFolder);
    var googleSection = pane.querySelector('[data-cloud-section="google"]');
    if (googleSection) googleSection.classList.toggle('sm-hide', isFolder || !googleOk);

    var modeSelect = pane.querySelector('[data-cloud="mode"]');
    if (modeSelect && modeSelect.value !== state.mode) modeSelect.value = state.mode;

    var box = pane.querySelector('[data-cloud="status"]');
    if (box) {
      var lines = [];
      if (isFolder) {
        lines.push(state.folderReady ? T('folderChosen') + (state.folderLabel || '') : T('folderMissing'));
      } else if (!state.googleConfigured) {
        lines.push(T('notConfigured'));
      } else if (!state.googleSignedIn) {
        lines.push(T('signedOut'));
      } else {
        lines.push(T('signedInAs') + (state.googleEmail || 'Google'));
      }
      lines.push(T('lastSync') + (state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : T('never')));
      if (counters.sent || counters.received || counters.cloud || counters.removed) {
        lines.push(T('sent') + counters.sent + ' · ' + T('received') + counters.received);
        if (counters.cloud) lines.push(T('inCloud') + counters.cloud + T('inCloudHint'));
        if (cloudMeta.tracks) {
          var breakdown = (cloudMeta.files || []).map(function (file) {
            return file.label + ' ' + file.tracks;
          }).join(' · ');
          lines.push(T('cloudFileInfo') + cloudMeta.tracks + ' ' + T('tracksWord') +
            (cloudMeta.albums ? ' · ' + cloudMeta.albums + ' ' + T('albumsWord') : '') +
            (breakdown ? ' (' + breakdown + ')' : ''));
        }
        if (cloudMeta.ownFile) {
          var ownEntry = null;
          (cloudMeta.files || []).forEach(function (file) { if (!ownEntry && file.own) ownEntry = file; });
          lines.push(T('ownFileLabel') + cloudMeta.ownFile +
            (ownEntry ? ' · ' + ownEntry.tracks + ' ' + T('tracksWord') : '') +
            (cloudMeta.ownFileAt ? T('fileChanged') + new Date(cloudMeta.ownFileAt).toLocaleString() : ''));
        }
        if (cloudMeta.fromOther && cloudMeta.updatedAt) {
          lines.push(T('lastOtherWrite') + (cloudMeta.device || '') + ' · ' +
            new Date(cloudMeta.updatedAt).toLocaleString() +
            (cloudMeta.fileModifiedAt ? T('fileChanged') + new Date(cloudMeta.fileModifiedAt).toLocaleString() : ''));
        }
        if (cloudMeta.devices && cloudMeta.devices.length) {
          lines.push(T('devicesInFile') + cloudMeta.devices.join(', '));
        }
        if (cloudMeta.restored) lines.push(T('cloudRestored') + cloudMeta.restored);
        // Biblioteka większa niż to, co jedzie do chmury: utwory bez
        // identyfikatora nie mają po czym się skojarzyć między urządzeniami.
        if (cloudMeta.libraryTracks && cloudMeta.snapshotTracks &&
            cloudMeta.libraryTracks > cloudMeta.snapshotTracks) {
          lines.push(T('keylessA') + cloudMeta.libraryTracks + T('keylessB') + cloudMeta.snapshotTracks + T('keylessC'));
        }
        if (cloudMeta.writeBack === 'missing') lines.push(T('writeBackWarning'));
        // Widzę tylko własny plik: to najczęstsza przyczyna „drugie urządzenie
        // mnie nie widzi”, a Dysk pokazuje cudze pliki z opóźnieniem.
        if (cloudMeta.files && cloudMeta.files.length === 1 && cloudMeta.files[0].own && state.lastSyncAt) {
          lines.push(T('onlyOwnFile'));
        }
        if (counters.removed) lines.push(T('removedElsewhere') + counters.removed);
      }
      if (state.enabled) {
        var waiting = autoWaitingCount();
        lines.push(state.autoDownload
          ? T('autoStateOn') + (waiting ? T('autoWaiting') + waiting : '')
          : T('autoStateOff'));
      }
      if (autoLast) {
        lines.push((autoLast.ok ? T('autoLastOk') : T('autoLastFail')) + (autoLast.title || autoLast.key) +
          (autoLast.ok ? '' : ' — ' + (autoLast.error || '')));
        if (!autoLast.ok) {
          var hint = downloaderHint();
          if (hint) lines.push(hint);
        }
      }
      if (busy) lines.push(T('syncing'));
      if (state.lastError) lines.push(T('error') + state.lastError);
      lines.push(layersLine());
      box.textContent = lines.join('\n');
    }

    var enabled = pane.querySelector('[data-cloud="enabled"]');
    if (enabled) enabled.checked = !!state.enabled;
    var auto = pane.querySelector('[data-cloud="auto"]');
    if (auto) auto.checked = !!state.autoDownload;
    var mirror = pane.querySelector('[data-cloud="mirror"]');
    if (mirror) mirror.checked = state.mirror !== false;

    renderCloudOnly(pane);
    ensureCloudScroll();
  }

  // --------------------------------------------------------------- rozruch

  function start() {
    loadSettings();
    if (state.mode === 'google' && !supportsGoogle()) {
      state.mode = 'folder';
      saveSettings();
    }
    transport = transportFor(state.mode);
    if (!transport) return;
    ensurePanel();
    refreshStatus();
    deviceInfo().catch(function () {});
    cloudLoad().then(function () { renderPanelStatus(); }).catch(function () {});
    stateGet('cloudMeta').then(function (stored) {
      if (stored && stored.value) {
        cloudMeta = Object.assign(cloudMeta, stored.value);
        renderPanelStatus();
      }
    }).catch(function () {});
    stateGet('cloudDerived').then(function (stored) {
      if (stored && stored.value) {
        derivedTracks = Object.assign({}, stored.value);
        renderPanelStatus();
      }
    }).catch(function () {});
    stateGet('counters').then(function (stored) {
      if (stored && stored.value) {
        counters = Object.assign(counters, stored.value);
        renderPanelStatus();
      }
    }).catch(function () {});

    if (!listenersReady) {
      listenersReady = true;
      document.addEventListener('pulsar:library', function () { scheduleSync(20000); });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) scheduleSync(5000); });
      var settingsBtn = document.getElementById('settingsBtn');
      if (settingsBtn) settingsBtn.addEventListener('click', function () { setTimeout(renderPanelStatus, 60); });
      var drive = plugins()[DRIVE_PLUGIN];
      if (drive && drive.addListener) {
        drive.addListener('driveAuth', function () {
          refreshStatus().then(function () { if (state.googleSignedIn && state.enabled) return runSync(); return null; });
        });
      }
    }

    if (state.enabled && readyToSync()) setTimeout(function () { runSync().catch(function () {}); }, 6000);
    else renderPanelStatus();
  }

  // Ustawienia czytamy od razu, żeby transport był właściwy jeszcze przed
  // pierwszym renderem panelu (start() i tak je potem odświeży).
  loadSettings();
  transport = transportFor(state.mode);

  // Runtime nie tłumaczy własnych zakładek, więc po zmianie języka odświeżamy
  // etykiety sami — niezależnie od tego, czy panel zdążył już powstać.
  document.addEventListener('pulsar:lang', function () {
    try { LANG = String(localStorage.getItem('playerLang') || 'pl').slice(0, 2); } catch (error) {}
    if (panel) applyLabels(panel);
    renderPanelStatus();
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 400);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 400); });

  // API dla konsoli i testów offline.
  window.__pulsarDrive = {
    sync: runSync,
    status: refreshStatus,
    // Wystawione dla testów offline (panel buduje się dopiero po starcie).
    openPanel: function () { return ensurePanel(); },
    showPane: showPane,
    setMode: setMode,
    setEnabled: function (flag) { state.enabled = !!flag; saveSettings(); renderPanelStatus(); },
    mode: function () { return state.mode; },
    state: function () { return state; },
    counters: function () { return counters; },
    download: downloadCloudTrack,
    downloadAll: downloadAllCloudTracks,
    refreshFiles: refreshCloudFiles,
    autoLast: function () { return autoLast ? Object.assign({}, autoLast) : null; },
    autoDownload: autoDownloadFresh,
    cloudOnly: function () { return cloudEntries.slice(); },
    ownFile: function () { return cloudMeta.ownFile || ''; },
    _fileHelpers: { platformKey: platformKey, ownFileName: ownFileName, fileLabel: fileLabel },
    cloudMeta: function () { return Object.assign({}, cloudMeta); },
    derived: function () { return Object.assign({}, derivedTracks); },
    scrollInfo: function () { return panel ? cloudScrollInfo(panel) : null; },
    setImportWait: function (ms) { IMPORT_WAIT_MS = Math.max(0, Number(ms) || 0); return IMPORT_WAIT_MS; },
    setReadRetry: function (ms) { READ_RETRY_MS = Math.max(0, Number(ms) || 0); return READ_RETRY_MS; },
    cloudMemory: function () {
      return stateGet('cloudMemory').then(function (stored) {
        var value = stored && stored.value ? stored.value : null;
        if (!value) return null;
        return {
          tracks: (value.tracks || []).length,
          albums: (value.albums || []).length,
          devices: unionDeviceLists(value.devices, []).length,
          keys: (value.tracks || []).map(function (entry) { return entry.key; }),
          at: Number(stored.at || 0) || 0
        };
      });
    },
    _pure: {
      trackKey: trackKey,
      albumKey: albumKey,
      metadataOf: metadataOf,
      buildManifest: buildManifest,
      mergeManifests: mergeManifests,
      buildApplyPlan: buildApplyPlan,
      cloudOnlyOf: cloudOnlyOf,
      canFetchFromYoutube: canFetchFromYoutube,
      searchQueryOf: searchQueryOf,
      pickResultIndex: pickResultIndex,
      namePair: namePair,
      mergeCloudMemory: mergeCloudMemory,
      cloudMemoryState: cloudMemoryState,
      hash: hash
    }
  };
})();
