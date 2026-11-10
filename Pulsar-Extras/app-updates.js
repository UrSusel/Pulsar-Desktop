/* Pulsar — sprawdzanie wydań aplikacji, bez automatycznej instalacji. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.window === root) {
    root.PulsarUpdates = api;
    api.mount();
  }
})(typeof window !== 'undefined' ? window : {}, function (root) {
  'use strict';
  const tr = root.PulsarI18n ? root.PulsarI18n.t : function (text) { return text; };
  const trMessage = root.PulsarI18n ? root.PulsarI18n.message : tr;

  const AUTO_KEY = 'pulsarAppUpdateAuto';
  const CHECKED_KEY = 'pulsarAppUpdateCheckedAt';
  const NOTICE_KEY = 'pulsarAppUpdateNoticeV2';
  const AUTO_INTERVAL = 12 * 60 * 60 * 1000;
  let configPromise = null;
  let inflight = null;
  let lastResult = null;
  let ui = {};

  function parseVersion(value) {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value || '').trim());
    if (!match) return null;
    return {
      major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
      pre: match[4] ? match[4].split('.') : [],
      text: match[1] + '.' + match[2] + '.' + match[3] + (match[4] ? '-' + match[4] : '')
    };
  }

  function compareVersions(left, right) {
    const a = typeof left === 'object' && left ? left : parseVersion(left);
    const b = typeof right === 'object' && right ? right : parseVersion(right);
    if (!a || !b) return null;
    for (const key of ['major', 'minor', 'patch']) {
      if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    }
    if (!a.pre.length && !b.pre.length) return 0;
    if (!a.pre.length) return 1;
    if (!b.pre.length) return -1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
      if (a.pre[i] === undefined) return -1;
      if (b.pre[i] === undefined) return 1;
      if (a.pre[i] === b.pre[i]) continue;
      const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
      if (an && bn) return Number(a.pre[i]) < Number(b.pre[i]) ? -1 : 1;
      if (an !== bn) return an ? -1 : 1;
      return a.pre[i] < b.pre[i] ? -1 : 1;
    }
    return 0;
  }

  function storageGet(key) { try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (e) { return null; } }
  function storageSet(key, value) { try { if (root.localStorage) root.localStorage.setItem(key, value); } catch (e) {} }

  function safeReleaseUrl(value, fallback) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : fallback;
    } catch (e) { return fallback; }
  }

  function selectDownloadAsset(release, platform) {
    const os = String(platform || '').toLowerCase();
    const windows = /^(?:windows|win32|win64)/.test(os), linux = /linux/.test(os);
    if (!windows && !linux) return '';
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    const ext = windows ? /\.(?:exe|msi|zip)$/i : /\.(?:appimage|deb|rpm|tar\.gz|zip)$/i;
    const platformName = windows ? /windows|win32|win64|desktop/i : /linux|ubuntu|debian|appimage/i;
    const asset = assets.find(function (item) {
      const name = String(item && item.name || '');
      return ext.test(name) && platformName.test(name) && !/source|symbols|debug/i.test(name);
    });
    try {
      const url = new URL(String(asset && asset.browser_download_url || ''));
      return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'objects.githubusercontent.com') ? url.href : '';
    } catch (e) { return ''; }
  }

  function releaseNotesText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').slice(0, 12000).trim();
  }
  function shouldAutoCheck(now, lastCheck, enabled, force) {
    return enabled !== false && (force === true || !(Number(lastCheck) > 0) || Number(now) - Number(lastCheck) >= AUTO_INTERVAL);
  }

  function loadConfig() {
    if (!configPromise) {
      configPromise = Promise.resolve().then(function () {
        if (!root.fetch) throw new Error(tr('Brak fetch'));
        return root.fetch('app-version.json', { cache: 'no-store' });
      }).then(function (response) {
        if (!response || !response.ok) throw new Error(tr('Nie można odczytać wersji aplikacji'));
        return response.json();
      }).then(function (config) {
        if (!parseVersion(config && config.version) || !/^[\w.-]+\/[\w.-]+$/.test(String(config.repo || ''))) throw new Error(tr('Niepoprawny manifest wersji'));
        return { version: parseVersion(config.version).text, repo: String(config.repo) };
      });
    }
    return configPromise;
  }

  function current() { return loadConfig().then(function (config) { return config.version; }); }

  function notify(result) {
    const key = result.current + '→' + result.latest;
    if (storageGet(NOTICE_KEY) === key) return;
    const host = root.__pulsarHost;
    if (!host || typeof host.toast !== 'function') return;
    try {
      host.toast(tr('Dostępna jest nowa wersja Pulsara: ') + result.latest + tr('. Otwórz Ustawienia → Pobieranie.'));
      storageSet(NOTICE_KEY, key);
    } catch (e) {}
  }

  function render(result) {
    if (!ui.status) return;
    lastResult = result || lastResult;
    const value = result || lastResult;
    ui.check.disabled = !!value && !!value.pending;
    if (!value) return;
    ui.download.hidden = !value.updateAvailable;
    ui.notesSection.hidden = true;
    ui.notesTitle.textContent = tr('Informacje o wydaniu');
    ui.status.classList.toggle('pupdate-error', !!value.error);
    ui.status.classList.toggle('pupdate-new', !!value.updateAvailable);
    if (value.pending) {
      ui.status.textContent = tr('Sprawdzanie GitHub Releases…');
    } else if (value.error === 'invalid-tag') {
      ui.status.textContent = tr('Najnowszy release nie ma tagu wersji, np. v') + value.current + tr('. Nie udało się porównać wersji.');
    } else if (value.error) {
      ui.status.textContent = tr('Nie udało się sprawdzić aktualizacji: ') + trMessage(value.error);
    } else if (value.updateAvailable) {
      ui.status.textContent = tr('Dostępna wersja ') + value.latest + tr(' · zainstalowana ') + value.current + tr('. Pobieranie nie uruchamia się automatycznie.');
      ui.download.href = value.downloadUrl || value.releaseUrl;
      ui.download.textContent = value.downloadUrl && value.downloadUrl !== value.releaseUrl
        ? tr('Pobierz dla tego systemu') : tr('Otwórz stronę wydania');
      ui.notes.textContent = value.releaseNotes || tr('To wydanie nie zawiera opisu zmian.');
      ui.notesSection.hidden = !value.releaseNotes;
      notify(value);
    } else {
      ui.status.textContent = tr('Masz najnowszą wersję: ') + value.current + '.';
    }
  }

  async function check(options) {
    options = options || {};
    if (inflight && !options.fetchImpl) return inflight;
    const task = (async function () {
      let config = null;
      const localVersion = options.current && parseVersion(options.current);
      if (!localVersion || !options.repo) config = await loadConfig();
      const currentVersion = localVersion || parseVersion(config.version);
      const repo = options.repo || config.repo;
      if (!currentVersion) return { current: '', latest: null, updateAvailable: false, error: tr('Niepoprawna wersja lokalna') };
      const base = { current: currentVersion.text, latest: null, updateAvailable: false, releaseUrl: 'https://github.com/' + repo + '/releases/latest' };
      try {
        const fetcher = options.fetchImpl || (root.fetch && root.fetch.bind(root));
        if (!fetcher) throw new Error(tr('Brak dostępu do sieci'));
        const response = await fetcher('https://api.github.com/repos/' + repo + '/releases/latest', {
          cache: 'no-store', headers: { Accept: 'application/vnd.github+json' }
        });
        if (!response || !response.ok) throw new Error('GitHub HTTP ' + (response && response.status || tr('brak odpowiedzi')));
        const release = await response.json();
        const latest = parseVersion(release && release.tag_name);
        const releaseUrl = safeReleaseUrl(release && release.html_url, base.releaseUrl);
        const platform = root.Neutralino && root.Neutralino.os;
        const result = Object.assign(base, {
          releaseUrl: releaseUrl,
          downloadUrl: selectDownloadAsset(release, platform) || releaseUrl,
          releaseNotes: releaseNotesText(release && release.body),
          checkedAt: Date.now()
        });
        if (!latest) result.error = 'invalid-tag';
        else {
          result.latest = latest.text;
          result.updateAvailable = compareVersions(currentVersion, latest) < 0;
        }
        storageSet(CHECKED_KEY, String(result.checkedAt));
        render(result);
        return result;
      } catch (error) {
        const result = Object.assign(base, { error: String(error && error.message || error) });
        render(result);
        return result;
      }
    })();
    if (!options.fetchImpl) inflight = task;
    try { return await task; }
    finally { if (inflight === task) inflight = null; }
  }

  function maybeAutoCheck(force) {
    const enabled = storageGet(AUTO_KEY) !== '0';
    if (!shouldAutoCheck(Date.now(), Number(storageGet(CHECKED_KEY)), enabled, force === true)) return null;
    return check({ manual: false });
  }

  function mount() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('pulsarAppUpdate')) return;
    const pane = document.querySelector('.sm-pane[data-pane="net"]');
    if (!pane) return;
    const card = document.createElement('section');
    card.className = 'sm-card sm-desktop-only pupdate-card';
    card.id = 'pulsarAppUpdate';
    card.innerHTML = '<h3 class="sm-cap">Pulsar</h3>'
      + '<div class="sm-row"><div class="sm-txt"><span class="sm-lab">Wersja aplikacji</span><span class="sm-desc" id="pupdateVersion">Wczytywanie…</span></div></div>'
      + '<div class="sm-row"><div class="sm-txt"><span class="sm-lab">Sprawdzaj nowe wydania</span><span class="sm-desc">Przy starcie i co 12 godzin podczas długiej sesji; nie instaluje aktualizacji automatycznie</span></div><label class="switch"><input type="checkbox" id="pupdateAuto"><span class="slider"></span></label></div>'
      + '<div class="pupdate-actions"><button type="button" class="sm-btn" id="pupdateCheck">Sprawdź aktualizacje</button><a class="sm-btn" id="pupdateDownload" href="#" target="_blank" rel="noopener noreferrer" hidden>Pobierz nową wersję</a></div>'
      + '<div class="pupdate-status" id="pupdateStatus" aria-live="polite">Sprawdzanie jest wykonywane najwyżej co 12 godzin.</div>'
      + '<section class="pupdate-release-notes" id="pupdateNotesSection" hidden><h4 id="pupdateNotesTitle">Informacje o wydaniu</h4><pre id="pupdateNotes"></pre></section>';
    const ytdlp = document.getElementById('smYtdlpBtn');
    const anchor = ytdlp && ytdlp.closest('.sm-card');
    pane.insertBefore(card, anchor || null);
    ui = {
      version: document.getElementById('pupdateVersion'), auto: document.getElementById('pupdateAuto'),
      check: document.getElementById('pupdateCheck'), download: document.getElementById('pupdateDownload'),
      status: document.getElementById('pupdateStatus'), notesSection: document.getElementById('pupdateNotesSection'),
      notes: document.getElementById('pupdateNotes'), notesTitle: document.getElementById('pupdateNotesTitle')
    };
    ui.auto.checked = storageGet(AUTO_KEY) !== '0';
    ui.auto.addEventListener('change', function () {
      storageSet(AUTO_KEY, ui.auto.checked ? '1' : '0');
      if (ui.auto.checked) maybeAutoCheck(true);
    });
    ui.check.addEventListener('click', function () { render({ pending: true }); check({ manual: true }); });
    ui.download.addEventListener('click', function (event) {
      const os = root.Neutralino && root.Neutralino.os;
      if (!ui.download.hidden && os && typeof os.open === 'function') {
        event.preventDefault();
        Promise.resolve(os.open(ui.download.href)).catch(function () {
          if (root.open) root.open(ui.download.href, '_blank', 'noopener');
        });
      }
    });
    current().then(function (version) { if (ui.version) ui.version.textContent = version + ' · GitHub Releases'; }).catch(function (error) {
      if (ui.version) ui.version.textContent = tr('Nieznana');
      if (ui.status) ui.status.textContent = trMessage(String(error && error.message || error));
    });
    document.addEventListener('pulsar:lang', function () { render(); });
    // Always check on launch; the update notice itself is deduplicated per version pair.
    setTimeout(function () { maybeAutoCheck(true); }, 5000);
    // While the app stays open, retry on the existing 12-hour cadence.
    setInterval(maybeAutoCheck, 60 * 60 * 1000);
  }

  return {
    AUTO_INTERVAL: AUTO_INTERVAL,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    shouldAutoCheck: shouldAutoCheck,
    selectDownloadAsset: selectDownloadAsset,
    releaseNotesText: releaseNotesText,
    current: current,
    check: check,
    maybeAutoCheck: maybeAutoCheck,
    mount: mount,
    state: function () { return lastResult; }
  };
});
