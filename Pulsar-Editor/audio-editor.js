/* Pulsar Desktop — edytor audio i przesuwanie napisów. */
(function () {
  'use strict';
  if (typeof document === 'undefined' || !window.PulsarEditorCore) return;

  const core = window.PulsarEditorCore;
  const player = window.__player;
  const host = window.__pulsarHost;
  const mainAudio = document.getElementById('audio');
  if (!player || !player.__editor || !host || !mainAudio) return;

  let editorApi = null;
  let open = false;
  let activeTab = 'audio';
  let track = null;
  let duration = 0;
  let buffer = null;
  let peaks = null;
  let cuts = [];
  let history = [];
  let draft = null;
  let preview = false;
  let saveBusy = false;
  let decodeToken = 0;
  let lyricsToken = 0;
  let lyricsLoadedId = '';
  let aiBusy = false;
  let aiBusyId = '';
  let aiCaps = null;
  let aiCandidate = null;
  let aiPreviewVariant = '';
  let raf = 0;
  let lastLyricsPaint = 0;
  let ui = {};
  let editButton = null;
  let zoom = 1;
  let viewStart = 0;
  let boundaryDrag = null;
  let nativeMode = false;
  let ffmpegAvailable = false;
  let mediaReady = null;
  let fadeInMs = 0;
  let fadeOutMs = 0;
  let joinFadeMs = 5;
  let silenceDb = -45;
  let silenceMin = 0.6;
  let outputFormat = 'wav';
  let sessionEnabled = true;
  let sessionNotice = '';
  const LARGE_FILE_BYTES = 80 * 1024 * 1024;

  function byId(id) { return document.getElementById(id); }
  function toast(text) { try { host.toast(text); } catch (e) {} }
  function round3(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }
  function numberValue(value) { return Number(String(value == null ? '' : value).replace(',', '.')); }
  function formatTime(seconds, milliseconds) {
    let value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) value = 0;
    const factor = milliseconds ? 1000 : 100;
    const digits = milliseconds ? 3 : 2;
    const units = Math.round(value * factor);
    const minutes = Math.floor(units / (60 * factor));
    const sec = (units - minutes * 60 * factor) / factor;
    return minutes + ':' + sec.toFixed(digits).padStart(digits + 3, '0');
  }
  function formatOffset(value) {
    const n = Number(value) || 0;
    return (n > 0 ? '+' : '') + n.toFixed(2).replace('.', ',') + ' s';
  }
  function samePath(a, b) {
    const normalize = function (value) { return String(value || '').trim().replace(/^"+|"+$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
    const left = normalize(a), right = normalize(b);
    return !!left && left === right;
  }
  function fileNameFromPath(path, fallback) {
    const parts = String(path || '').split(/[\\/]/);
    return parts[parts.length - 1] || fallback;
  }
  function setStatus(element, text, kind, loading) {
    if (!element) return;
    element.classList.toggle('pae-error', kind === 'error');
    element.classList.toggle('pae-success', kind === 'success');
    element.textContent = '';
    if (loading) {
      const spin = document.createElement('span');
      spin.className = 'pae-spin';
      spin.setAttribute('aria-hidden', 'true');
      element.appendChild(spin);
    }
    element.appendChild(document.createTextNode(String(text || '')));
  }

  function sessionKey() { return track ? 'pulsarEditorSession:' + track.id : ''; }
  function hasEditWork() { return cuts.length > 0 || fadeInMs > 0 || fadeOutMs > 0 || joinFadeMs !== 5 || silenceDb !== -45 || silenceMin !== 0.6; }
  function saveSession(manual) {
    if (!track || !sessionEnabled || (!manual && !hasEditWork())) return;
    try {
      localStorage.setItem(sessionKey(), JSON.stringify({ version: 2, updatedAt: Date.now(), fileName: track.file.name, fileSize: track.file.size, cuts: cuts, fadeInMs: fadeInMs, fadeOutMs: fadeOutMs, joinFadeMs: joinFadeMs, silenceDb: silenceDb, silenceMin: silenceMin, outputFormat: outputFormat, zoom: zoom, viewStart: viewStart }));
      if (manual) setStatus(ui.audioStatus, 'Sesja zapisana. Możesz zamknąć edytor i wrócić do niej później.', 'success');
    } catch (e) { if (manual) setStatus(ui.audioStatus, 'Nie udało się zapisać sesji: ' + (e.message || e), 'error'); }
  }
  function restoreSession() {
    sessionNotice = '';
    if (!track || !duration) return;
    try {
      const data = JSON.parse(localStorage.getItem(sessionKey()) || 'null');
      if (!data || data.version !== 2) return;
      cuts = core.normalizeCuts(data.cuts || [], duration);
      fadeInMs = Math.max(0, Math.min(30000, Number(data.fadeInMs) || 0));
      fadeOutMs = Math.max(0, Math.min(30000, Number(data.fadeOutMs) || 0));
      joinFadeMs = Math.max(0, Math.min(30000, Number(data.joinFadeMs == null ? 5 : data.joinFadeMs) || 0));
      silenceDb = Math.max(-90, Math.min(-5, Number(data.silenceDb) || -45));
      silenceMin = Math.max(0.1, Math.min(60, Number(data.silenceMin) || 0.6));
      outputFormat = /^(wav|mp3|flac)$/.test(data.outputFormat) ? data.outputFormat : 'wav';
      zoom = Math.max(1, Math.min(32, Number(data.zoom) || 1));
      viewStart = Math.max(0, Math.min(duration, Number(data.viewStart) || 0));
      sessionNotice = ' Wznowiono zapisaną sesję.';
    } catch (e) {}
  }
  function deleteSession() {
    if (!track) return;
    try { localStorage.removeItem(sessionKey()); } catch (e) {}
    sessionEnabled = false; cuts = []; history = []; fadeInMs = 0; fadeOutMs = 0; joinFadeMs = 5; silenceDb = -45; silenceMin = 0.6; zoom = 1; viewStart = 0; sessionNotice = '';
    syncOptionInputs(); updateAudioUi(); drawWave();
    setStatus(ui.audioStatus, 'Usunięto zapisaną sesję i wyczyszczono decyzje edycji. Oryginał pozostał bez zmian.', 'success');
  }
  function viewDuration() { return duration > 0 ? duration / zoom : 0; }
  function clampView() { if (!duration || zoom <= 1) viewStart = 0; else viewStart = Math.max(0, Math.min(duration - viewDuration(), viewStart)); }
  function setZoom(value, center) {
    if (!duration) return;
    const oldTime = Number.isFinite(center) ? center : viewStart + viewDuration() / 2;
    const oldRatio = viewDuration() ? (oldTime - viewStart) / viewDuration() : 0.5;
    zoom = Math.max(1, Math.min(32, Number(value) || 1));
    viewStart = oldTime - oldRatio * viewDuration();
    clampView(); updateViewUi(); drawWave(); saveSession(false);
  }
  function updateViewUi() {
    if (!ui.zoomLabel) return;
    clampView();
    ui.zoomLabel.textContent = zoom.toFixed(zoom < 10 ? 1 : 0) + '×';
    ui.axisStart.textContent = formatTime(viewStart, true);
    ui.axisDuration.textContent = formatTime(viewStart + viewDuration(), true);
    ui.zoomOut.disabled = zoom <= 1 || saveBusy;
    ui.zoomIn.disabled = zoom >= 32 || saveBusy;
    ui.zoomFit.disabled = zoom <= 1 || saveBusy;
  }
  function syncOptionInputs() {
    if (!ui.fadeIn) return;
    ui.fadeIn.value = String(fadeInMs); ui.fadeOut.value = String(fadeOutMs); ui.joinFade.value = String(joinFadeMs);
    ui.silenceDb.value = String(silenceDb); ui.silenceMin.value = String(silenceMin); ui.format.value = outputFormat;
  }

  function buildButton() {
    const lyricsButton = byId('lyricsBtn');
    if (!lyricsButton || !lyricsButton.parentNode || byId('audioEditorBtn')) return;
    editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'icon-btn';
    editButton.dataset.ic = 'stroke';
    editButton.id = 'audioEditorBtn';
    editButton.title = 'Edytuj audio i napisy';
    editButton.setAttribute('aria-label', 'Edytuj audio i napisy');
    editButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5M13.2 12l2.1 2"/></svg>';
    editButton.addEventListener('click', function () { openEditor('audio'); });
    lyricsButton.parentNode.insertBefore(editButton, lyricsButton);
  }

  function buildPanel() {
    if (byId('audioEditor')) return byId('audioEditor');
    const dim = document.createElement('div');
    dim.id = 'audioEditor';
    dim.className = 'pae-dim';
    dim.hidden = true;
    dim.innerHTML = `
      <section class="pae-modal" role="dialog" aria-modal="true" aria-labelledby="paeTitle">
        <header class="pae-head">
          <div class="pae-heading"><h2 id="paeTitle">Edycja utworu</h2><div class="pae-track" id="paeTrack"></div></div>
          <button type="button" class="pae-close" id="paeClose" aria-label="Zamknij edytor">×</button>
        </header>
        <nav class="pae-tabs" role="tablist" aria-label="Narzędzia edycji">
          <button type="button" class="pae-tab active" data-tab="audio" role="tab" aria-selected="true">✂ Audio</button>
          <button type="button" class="pae-tab" data-tab="lyrics" role="tab" aria-selected="false">♪ Napisy</button>
        </nav>
        <div class="pae-body">
          <div class="pae-pane" id="paeAudioPane" role="tabpanel">
            <p class="pae-note"><strong>Przeciągnij po fali, aby usunąć fragment; chwyć czerwoną granicę, aby ją przesunąć.</strong> Ctrl + kółko powiększa falę. Zapis zawsze tworzy nowy plik — oryginał nie jest nadpisywany.</p>
            <div>
              <div class="pae-wave-wrap" id="paeWaveWrap">
                <canvas class="pae-wave" id="paeWave" aria-label="Fala dźwiękowa — przeciągnij, aby wybrać wycinek"></canvas>
                <div class="pae-wave-empty" id="paeWaveEmpty">Wczytywanie fali dźwiękowej…</div>
                <div class="pae-playhead" id="paePlayhead"></div>
              </div>
              <div class="pae-time-axis"><span id="paeAxisStart">0:00,000</span><span id="paeAxisDuration">0:00,000</span></div>
            </div>
            <div class="pae-zoombar" aria-label="Powiększenie fali">
              <button type="button" class="pae-btn icon" id="paeZoomOut" aria-label="Pomniejsz falę">−</button><strong id="paeZoomLabel">1,0×</strong><button type="button" class="pae-btn icon" id="paeZoomIn" aria-label="Powiększ falę">+</button><button type="button" class="pae-btn" id="paeZoomFit">Pełny utwór</button><span>Ctrl + kółko · dokładność 1 ms</span>
            </div>
            <div class="pae-summary">
              <div class="pae-stat"><span>Oryginał</span><strong id="paeOriginalDuration">0:00,00</strong></div>
              <div class="pae-stat removed"><span>Do usunięcia</span><strong id="paeRemovedDuration">0:00,00</strong></div>
              <div class="pae-stat result"><span>Po edycji</span><strong id="paeFinalDuration">0:00,00</strong></div>
            </div>
            <details class="pae-advanced">
              <summary>Przejścia i wykrywanie ciszy</summary>
              <div class="pae-options-grid">
                <label class="pae-field">Fade-in (ms)<input class="pae-input" id="paeFadeIn" type="number" min="0" max="30000" step="10" value="0"></label>
                <label class="pae-field">Fade-out (ms)<input class="pae-input" id="paeFadeOut" type="number" min="0" max="30000" step="10" value="0"></label>
                <label class="pae-field">Wygładzanie łączeń (ms)<input class="pae-input" id="paeJoinFade" type="number" min="0" max="30000" step="1" value="5"></label>
                <label class="pae-field">Próg ciszy (dB)<input class="pae-input" id="paeSilenceDb" type="number" min="-90" max="-5" step="1" value="-45"></label>
                <label class="pae-field">Minimalna cisza (s)<input class="pae-input" id="paeSilenceMin" type="number" min="0.1" max="60" step="0.1" value="0.6"></label>
              </div>
            </details>
            <div class="pae-toolbar">
              <button type="button" class="pae-btn" id="paeDetect">Wykryj ciszę</button>
              <button type="button" class="pae-btn" id="paePreview" aria-pressed="false">▶ Podgląd bez wycinków</button>
              <span class="spacer"></span>
              <button type="button" class="pae-btn" id="paeUndo">Cofnij</button>
              <button type="button" class="pae-btn danger" id="paeClear">Wyczyść</button>
              <button type="button" class="pae-btn" id="paeSaveSession">Zapisz sesję</button>
              <button type="button" class="pae-btn" id="paeDeleteSession">Usuń sesję</button>
            </div>
            <section class="pae-section">
              <div class="pae-section-title"><h3>Dodaj wycinek</h3><span>czas w sekundach</span></div>
              <div class="pae-cut-form">
                <label class="pae-field">Początek
                  <input class="pae-input" id="paeCutStart" type="number" min="0" step="0.001" value="0">
                </label>
                <label class="pae-field">Koniec
                  <input class="pae-input" id="paeCutEnd" type="number" min="0" step="0.001" value="0">
                </label>
                <button type="button" class="pae-btn primary" id="paeAddCut">+ Usuń zakres</button>
              </div>
              <div class="pae-time-buttons" style="margin-top:8px">
                <button type="button" class="pae-btn" id="paeSetStart">Początek = pozycja odtwarzacza</button>
                <button type="button" class="pae-btn" id="paeSetEnd">Koniec = pozycja odtwarzacza</button>
              </div>
              <div class="pae-cuts" id="paeCuts"></div>
            </section>
            <div class="pae-status" id="paeAudioStatus" aria-live="polite"></div>
            <div class="pae-save">
              <label class="pae-check"><input type="checkbox" id="paeImport" checked> Dodaj wynik do biblioteki</label>
              <label class="pae-format">Format<select class="pae-input" id="paeFormat" aria-label="Format eksportu"><option value="wav">WAV PCM</option><option value="mp3">MP3 192 kbps · FFmpeg</option><option value="flac">FLAC · FFmpeg</option></select></label>
              <button type="button" class="pae-btn primary" id="paeSave">Eksportuj jako nowy utwór WAV</button>
            </div>
          </div>

          <div class="pae-pane" id="paeLyricsPane" role="tabpanel" hidden>
            <p class="pae-note">Przesunięcie działa od razu i jest zapamiętywane osobno dla tego utworu. <strong>Wartość dodatnia pokazuje napisy później, ujemna — wcześniej.</strong></p>
            <div class="pae-version-warning" id="paeVersionWarning" hidden>
              <span id="paeVersionWarningText"></span>
              <button type="button" class="pae-btn" id="paeVersionAi">Sprawdź dopasowanie</button>
            </div>
            <div class="pae-offset-hero"><span class="pae-offset-value" id="paeOffsetValue">+0,00 s</span><span>aktualne przesunięcie napisów</span></div>
            <div class="pae-offset-controls">
              <label class="pae-field">Regulacja płynna
                <input class="pae-range" id="paeOffsetRange" type="range" min="-10" max="10" step="0.05" value="0">
              </label>
              <label class="pae-field pae-offset-number">Dokładnie (s)
                <input class="pae-input" id="paeOffsetNumber" type="number" min="-300" max="300" step="0.05" value="0">
              </label>
              <button type="button" class="pae-btn" id="paeOffsetReset">Resetuj</button>
            </div>
            <div class="pae-step-buttons">
              <button type="button" class="pae-btn" data-offset-step="-0.5">−0,5 s</button>
              <button type="button" class="pae-btn" data-offset-step="-0.1">−0,1 s</button>
              <button type="button" class="pae-btn" data-offset-step="0.1">+0,1 s</button>
              <button type="button" class="pae-btn" data-offset-step="0.5">+0,5 s</button>
              <button type="button" class="pae-btn" id="paeOffsetFirst">Pierwsze słowo: teraz</button>
            </div>
            <section class="pae-section pae-ai-section">
              <div class="pae-section-title"><h3>Dopasowanie AI <span class="pae-badge">EKSPERYMENT</span></h3><span>Windows · Linux · lokalnie</span></div>
              <p class="pae-note">Stable-TS dopasowuje <strong>istniejący tekst</strong> do tego nagrania na poziomie słów. Możesz użyć go także przy istniejącym word-sync, jeśli czasy pochodzą z innej wersji — np. z wersji studyjnej zamiast teledysku. Poprzednie napisy będzie można przywrócić. Pierwsze uruchomienie może pobrać od ok. 2 GB zależności (zależnie od platformy) i model — dopiero po Twoim potwierdzeniu.</p>
              <div class="pae-ai-range">
                <label class="pae-field">Zakres analizy
                  <select class="pae-input" id="paeAiScope"><option value="full">Cały utwór</option><option value="range">Wybrany zakres</option></select>
                </label>
                <label class="pae-field">Od (s)<input class="pae-input" id="paeAiRangeStart" type="number" min="0" step="0.05" value="0"></label>
                <label class="pae-field">Do (s)<input class="pae-input" id="paeAiRangeEnd" type="number" min="0" step="0.05" value="30"></label>
                <button type="button" class="pae-btn" id="paeAiRangeNowStart">Start: teraz</button>
                <button type="button" class="pae-btn" id="paeAiRangeNowEnd">Koniec: teraz</button>
              </div>
              <div class="pae-ai-controls">
                <label class="pae-field">Język tekstu
                  <select class="pae-input" id="paeAiLanguage">
                    <option value="pl">polski</option><option value="en">angielski</option><option value="de">niemiecki</option>
                    <option value="es">hiszpański</option><option value="fr">francuski</option><option value="it">włoski</option>
                    <option value="pt">portugalski</option><option value="nl">niderlandzki</option><option value="uk">ukraiński</option>
                    <option value="ru">rosyjski</option><option value="ja">japoński</option><option value="ko">koreański</option><option value="zh">chiński</option>
                  </select>
                </label>
                <button type="button" class="pae-btn primary" id="paeAiAlign">Dopasuj tekst do audio</button>
                <button type="button" class="pae-btn danger" id="paeAiRestore" hidden>Przywróć napisy źródłowe</button>
              </div>
              <div class="pae-status" id="paeAiStatus" aria-live="polite"></div>
              <div class="pae-ai-candidate" id="paeAiCandidate" hidden>
                <strong>Wynik jest gotowy, ale jeszcze niezapisany.</strong>
                <div class="pae-ai-compare">
                  <button type="button" class="pae-btn" id="paeAiPreviewSource">Odsłuch: źródło</button>
                  <button type="button" class="pae-btn" id="paeAiPreviewNew">Odsłuch: nowe AI</button>
                </div>
                <div class="pae-ai-compare">
                  <button type="button" class="pae-btn primary" id="paeAiAccept">Zapisz nowe dopasowanie</button>
                  <button type="button" class="pae-btn" id="paeAiDiscard">Odrzuć wynik</button>
                </div>
              </div>
            </section>
            <section class="pae-section">
              <div class="pae-section-title"><h3>Podgląd synchronizacji</h3><span>czasy po przesunięciu</span></div>
              <div class="pae-lyrics-preview" id="paeLyricsPreview"></div>
            </section>
            <div class="pae-status" id="paeLyricsStatus" aria-live="polite"></div>
            <div class="pae-lyrics-actions">
              <span class="pae-note">Zmiana zapisuje się automatycznie.</span>
              <button type="button" class="pae-btn primary" id="paeExportLrc">Eksportuj przesunięte .lrc</button>
            </div>
          </div>
        </div>
      </section>`;
    document.body.appendChild(dim);

    ui = {
      dim: dim,
      track: byId('paeTrack'),
      audioPane: byId('paeAudioPane'), lyricsPane: byId('paeLyricsPane'),
      wave: byId('paeWave'), waveWrap: byId('paeWaveWrap'), waveEmpty: byId('paeWaveEmpty'), playhead: byId('paePlayhead'),
      axisStart: byId('paeAxisStart'), axisDuration: byId('paeAxisDuration'), originalDuration: byId('paeOriginalDuration'), removedDuration: byId('paeRemovedDuration'), finalDuration: byId('paeFinalDuration'),
      detect: byId('paeDetect'), preview: byId('paePreview'), undo: byId('paeUndo'), clear: byId('paeClear'),
      saveSession: byId('paeSaveSession'), deleteSession: byId('paeDeleteSession'),
      zoomOut: byId('paeZoomOut'), zoomIn: byId('paeZoomIn'), zoomFit: byId('paeZoomFit'), zoomLabel: byId('paeZoomLabel'),
      fadeIn: byId('paeFadeIn'), fadeOut: byId('paeFadeOut'), joinFade: byId('paeJoinFade'), silenceDb: byId('paeSilenceDb'), silenceMin: byId('paeSilenceMin'), format: byId('paeFormat'),
      start: byId('paeCutStart'), end: byId('paeCutEnd'), addCut: byId('paeAddCut'), cuts: byId('paeCuts'),
      audioStatus: byId('paeAudioStatus'), import: byId('paeImport'), save: byId('paeSave'),
      offsetValue: byId('paeOffsetValue'), offsetRange: byId('paeOffsetRange'), offsetNumber: byId('paeOffsetNumber'),
      lyricsPreview: byId('paeLyricsPreview'), lyricsStatus: byId('paeLyricsStatus'), exportLrc: byId('paeExportLrc'),
      aiLanguage: byId('paeAiLanguage'), aiAlign: byId('paeAiAlign'), aiRestore: byId('paeAiRestore'), aiStatus: byId('paeAiStatus'),
      aiScope: byId('paeAiScope'), aiRangeStart: byId('paeAiRangeStart'), aiRangeEnd: byId('paeAiRangeEnd'),
      aiCandidate: byId('paeAiCandidate'), aiPreviewSource: byId('paeAiPreviewSource'), aiPreviewNew: byId('paeAiPreviewNew'), aiAccept: byId('paeAiAccept'), aiDiscard: byId('paeAiDiscard'),
      offsetFirst: byId('paeOffsetFirst'), versionWarning: byId('paeVersionWarning'), versionWarningText: byId('paeVersionWarningText')
    };

    byId('paeClose').addEventListener('click', closeEditor);
    dim.addEventListener('pointerdown', function (event) { if (event.target === dim) closeEditor(); });
    dim.querySelectorAll('.pae-tab').forEach(function (button) {
      button.addEventListener('click', function () { setTab(button.dataset.tab); });
    });
    ui.detect.addEventListener('click', detectSilence);
    ui.preview.addEventListener('click', function () { setPreview(!preview); });
    ui.undo.addEventListener('click', undoCuts);
    ui.clear.addEventListener('click', clearCuts);
    ui.saveSession.addEventListener('click', function () { sessionEnabled = true; saveSession(true); });
    ui.deleteSession.addEventListener('click', deleteSession);
    ui.zoomOut.addEventListener('click', function () { setZoom(zoom / 2, viewStart + viewDuration() / 2); });
    ui.zoomIn.addEventListener('click', function () { setZoom(zoom * 2, mainAudio.currentTime >= viewStart && mainAudio.currentTime <= viewStart + viewDuration() ? mainAudio.currentTime : viewStart + viewDuration() / 2); });
    ui.zoomFit.addEventListener('click', function () { setZoom(1, 0); });
    ui.addCut.addEventListener('click', addCutFromInputs);
    byId('paeSetStart').addEventListener('click', function () { ui.start.value = String(round3(mainAudio.currentTime || 0)); });
    byId('paeSetEnd').addEventListener('click', function () { ui.end.value = String(round3(mainAudio.currentTime || 0)); });
    [ui.start, ui.end].forEach(function (input) {
      input.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); addCutFromInputs(); } });
    });
    [[ui.fadeIn, 'fadeIn', 0, 30000], [ui.fadeOut, 'fadeOut', 0, 30000], [ui.joinFade, 'joinFade', 0, 30000], [ui.silenceDb, 'silenceDb', -90, -5], [ui.silenceMin, 'silenceMin', 0.1, 60]].forEach(function (item) {
      item[0].addEventListener('change', function () {
        const value = Math.max(item[2], Math.min(item[3], numberValue(item[0].value)));
        if (!Number.isFinite(value)) { syncOptionInputs(); return; }
        if (item[1] === 'fadeIn') fadeInMs = value;
        else if (item[1] === 'fadeOut') fadeOutMs = value;
        else if (item[1] === 'joinFade') joinFadeMs = value;
        else if (item[1] === 'silenceDb') silenceDb = value;
        else silenceMin = value;
        sessionEnabled = true; syncOptionInputs(); saveSession(false); updateAudioUi();
      });
    });
    ui.format.addEventListener('change', function () { outputFormat = /^(wav|mp3|flac)$/.test(ui.format.value) ? ui.format.value : 'wav'; sessionEnabled = true; saveSession(false); updateAudioUi(); });
    ui.save.addEventListener('click', saveEditedAudio);
    ui.offsetRange.addEventListener('input', function () { setLyricsOffset(numberValue(ui.offsetRange.value), 'range'); });
    ui.offsetNumber.addEventListener('change', function () { setLyricsOffset(numberValue(ui.offsetNumber.value), 'number'); });
    byId('paeOffsetReset').addEventListener('click', function () { setLyricsOffset(0); });
    ui.offsetFirst.addEventListener('click', alignFirstWordHere);
    byId('paeVersionAi').addEventListener('click', function () { ui.aiAlign.scrollIntoView({ block: 'center', behavior: 'smooth' }); ui.aiAlign.focus(); });
    ui.aiScope.addEventListener('change', updateAiRangeUi);
    byId('paeAiRangeNowStart').addEventListener('click', function () { ui.aiRangeStart.value = String(round3(mainAudio.currentTime || 0)); });
    byId('paeAiRangeNowEnd').addEventListener('click', function () { ui.aiRangeEnd.value = String(round3(mainAudio.currentTime || 0)); });
    dim.querySelectorAll('[data-offset-step]').forEach(function (button) {
      button.addEventListener('click', function () {
        const current = player.__lyrics.offset ? player.__lyrics.offset() : 0;
        setLyricsOffset(current + Number(button.dataset.offsetStep));
      });
    });
    ui.exportLrc.addEventListener('click', exportShiftedLrc);
    ui.aiAlign.addEventListener('click', runAiAlignment);
    ui.aiRestore.addEventListener('click', restoreSourceLyrics);
    ui.aiPreviewSource.addEventListener('click', function () { previewAiCandidate('source', true); });
    ui.aiPreviewNew.addEventListener('click', function () { previewAiCandidate('new', true); });
    ui.aiAccept.addEventListener('click', acceptAiCandidate);
    ui.aiDiscard.addEventListener('click', discardAiCandidate);
    bindWaveEvents();
    return dim;
  }

  function setTab(name) {
    activeTab = name === 'lyrics' ? 'lyrics' : 'audio';
    ui.audioPane.hidden = activeTab !== 'audio';
    ui.lyricsPane.hidden = activeTab !== 'lyrics';
    ui.dim.querySelectorAll('.pae-tab').forEach(function (button) {
      const selected = button.dataset.tab === activeTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    if (activeTab === 'audio') requestAnimationFrame(drawWave);
    else ensureLyrics();
  }

  async function decodeFile(file) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error('Ta wersja WebView nie obsługuje dekodowania audio.');
    let context = null;
    try { const tap = host.audioTap && host.audioTap(); if (tap && tap.ctx) context = tap.ctx; } catch (e) {}
    const ownContext = context ? null : new AudioCtor();
    if (!context) context = ownContext;
    try {
      const bytes = await file.arrayBuffer();
      return await new Promise(function (resolve, reject) {
        try { context.decodeAudioData(bytes.slice(0), resolve, reject); } catch (error) { reject(error); }
      });
    } finally {
      if (ownContext && ownContext.close) try { await ownContext.close(); } catch (e) {}
    }
  }

  async function prepareMedia() {
    const tools = window.__pulsarDesktopTools;
    if (!tools || !tools.available) { ffmpegAvailable = false; updateAudioUi(); return; }
    try { const caps = await tools.capabilities(); ffmpegAvailable = !!caps.ffmpeg; }
    catch (e) { ffmpegAvailable = false; }
    if (open) updateAudioUi();
  }
  function activateNative(message) {
    nativeMode = true;
    buffer = null;
    const analysis = player.__sound && player.__sound.analysisFor ? player.__sound.analysisFor(track.id) : null;
    peaks = analysis && analysis.peaks && analysis.peaks.length ? new Float32Array(analysis.peaks) : null;
    if (!duration && analysis && analysis.dur) duration = Number(analysis.dur) || 0;
    if (!Number.isFinite(duration) || duration < 0) duration = 0;
    ui.waveEmpty.hidden = true;
    ui.start.max = ui.end.max = String(duration || 0);
    setStatus(ui.audioStatus, message + (peaks ? ' Używam zapisanej fali analizy.' : ' Fala jest uproszczona; granice ustawisz czasem i przeciąganiem.'), 'success');
    restoreSession(); syncOptionInputs(); updateAudioUi(); drawWave();
  }
  async function loadAudioBuffer(token) {
    buffer = null;
    peaks = null;
    nativeMode = false;
    ui.waveEmpty.hidden = false;
    ui.waveEmpty.textContent = 'Wczytywanie fali dźwiękowej…';
    setStatus(ui.audioStatus, 'Sprawdzanie najlepszego trybu edycji…', '', true);
    updateAudioUi();
    await mediaReady;
    if (!open || token !== decodeToken) return;
    const needsNative = track.file.size > LARGE_FILE_BYTES || duration > 1800;
    if (needsNative) {
      if (ffmpegAvailable) { activateNative('Tryb dużych plików: cięcie wykona FFmpeg bez dekodowania całości w WebView.'); return; }
      ui.waveEmpty.textContent = 'Duży plik — bez dekodowania całości';
      setStatus(ui.audioStatus, 'Dla tego dużego pliku włączono ochronę pamięci. Dołącz FFmpeg, aby edytować strumieniowo i eksportować MP3/FLAC.', 'error');
      updateAudioUi(); drawWave(); return;
    }
    setStatus(ui.audioStatus, 'Dekodowanie audio do edycji…', '', true);
    try {
      const decoded = await decodeFile(track.file);
      if (!open || token !== decodeToken) return;
      buffer = decoded;
      duration = decoded.length / decoded.sampleRate;
      peaks = core.waveformPeaks(decoded, 1600);
      ui.waveEmpty.hidden = true;
      ui.start.max = String(duration);
      ui.end.max = String(duration);
      ui.end.value = String(round3(Math.min(duration, Math.max(1, (mainAudio.currentTime || 0) + 1))));
      restoreSession(); syncOptionInputs();
      setStatus(ui.audioStatus, 'Fala gotowa. Zaznacz fragment albo użyj wykrywania ciszy.' + sessionNotice, 'success');
      updateAudioUi();
      drawWave();
    } catch (error) {
      if (!open || token !== decodeToken) return;
      console.warn('Pulsar Editor: dekodowanie nie powiodło się', error);
      if (ffmpegAvailable) { activateNative('WebView nie zdekodowało źródła; eksport i cięcie wykona FFmpeg.'); return; }
      ui.waveEmpty.textContent = 'Nie udało się zdekodować tego pliku.';
      setStatus(ui.audioStatus, 'Nie można edytować tego formatu w tej wersji WebView. Napisy nadal możesz przesuwać.', 'error');
      updateAudioUi();
      drawWave();
    }
  }

  function openEditor(tab) {
    const current = player.__editor.current();
    if (!current || !current.file) { toast('Najpierw wybierz utwór do edycji'); return; }
    if (open) { setTab(tab || activeTab); return; }
    buildPanel();
    track = current;
    duration = Number(current.duration || mainAudio.duration || 0) || 0;
    if (!Number.isFinite(duration) || duration < 0) duration = 0;
    cuts = [];
    history = [];
    draft = null;
    boundaryDrag = null;
    preview = false;
    saveBusy = false;
    zoom = 1; viewStart = 0; nativeMode = false;
    fadeInMs = 0; fadeOutMs = 0; joinFadeMs = 5; silenceDb = -45; silenceMin = 0.6; outputFormat = 'wav';
    sessionEnabled = true; sessionNotice = '';
    open = true;
    const token = ++decodeToken;
    ++lyricsToken;
    lyricsLoadedId = '';
    ui.dim.hidden = false;
    ui.track.textContent = (current.artist ? current.artist + ' — ' : '') + (current.title || current.file.name);
    ui.track.title = ui.track.textContent;
    ui.start.value = '0';
    ui.end.value = String(round3(Math.min(duration || 1, 1)));
    ui.aiScope.value = 'full';
    ui.aiRangeStart.value = '0'; ui.aiRangeEnd.value = String(round3(Math.min(duration || 30, 30)));
    ui.aiRangeStart.max = ui.aiRangeEnd.max = String(duration || 0);
    aiPreviewVariant = '';
    ui.start.max = ui.end.max = String(duration || 0);
    setStatus(ui.audioStatus, '');
    setStatus(ui.lyricsStatus, '');
    setStatus(ui.aiStatus, '');
    updateAiUi();
    setPreview(false);
    setTab(tab || 'audio');
    restoreSession(); syncOptionInputs();
    updateAudioUi();
    updateLyricsOffsetUi();
    if (editButton) editButton.classList.add('active');
    requestAnimationFrame(function () { if (open) ui.dim.classList.add('show'); });
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(animationTick);
    mediaReady = prepareMedia();
    loadAudioBuffer(token);
    setTimeout(function () { if (open) byId('paeClose').focus(); }, 80);
  }

  function closeEditor() {
    if (!open || saveBusy) return;
    if (aiCandidate && track && aiCandidate.id === track.id) restoreSavedLyricsView();
    saveSession(false);
    open = false;
    ++decodeToken;
    ++lyricsToken;
    preview = false;
    draft = null;
    cancelAnimationFrame(raf);
    ui.dim.classList.remove('show');
    if (editButton) editButton.classList.remove('active');
    setTimeout(function () { if (!open) ui.dim.hidden = true; }, 190);
  }

  function updateAudioUi() {
    if (!ui.dim) return;
    const removed = duration > 0 ? Math.max(0, duration - core.editedDuration(duration, cuts)) : 0;
    const finalDuration = Math.max(0, duration - removed);
    ui.originalDuration.textContent = formatTime(duration, false);
    ui.removedDuration.textContent = formatTime(removed, false);
    ui.finalDuration.textContent = formatTime(finalDuration, false);
    ui.detect.disabled = !buffer || saveBusy;
    ui.detect.title = buffer ? 'Próg ' + silenceDb + ' dB, minimum ' + silenceMin + ' s' : 'Wykrywanie ciszy wymaga zdekodowanego audio; w trybie dużych plików ustaw zakresy czasem';
    ui.preview.disabled = !cuts.length || saveBusy;
    ui.preview.classList.toggle('active', preview);
    ui.preview.setAttribute('aria-pressed', String(preview));
    ui.undo.disabled = !history.length || saveBusy;
    ui.clear.disabled = !cuts.length || saveBusy;
    ui.saveSession.disabled = saveBusy; ui.deleteSession.disabled = saveBusy;
    const formatReady = outputFormat === 'wav' || ffmpegAvailable;
    ui.save.disabled = !(buffer || nativeMode) || !duration || finalDuration < 0.1 || saveBusy || !formatReady;
    ui.save.textContent = saveBusy ? 'Zapisywanie…' : 'Eksportuj jako nowy utwór ' + outputFormat.toUpperCase();
    ui.save.title = formatReady ? 'Oryginał nie zostanie nadpisany' : 'Ten format wymaga FFmpeg obok aplikacji lub w PATH';
    ui.format.disabled = saveBusy;
    Array.prototype.forEach.call(ui.format.options, function (option) { if (option.value !== 'wav') option.disabled = !ffmpegAvailable; });
    ui.addCut.disabled = saveBusy || !(buffer || nativeMode) || !duration;
    updateViewUi();
    renderCuts();
  }

  function renderCuts() {
    ui.cuts.textContent = '';
    if (!cuts.length) {
      const empty = document.createElement('div');
      empty.className = 'pae-empty-cuts';
      empty.textContent = 'Brak wycinków — cały utwór zostanie zachowany.';
      ui.cuts.appendChild(empty);
      return;
    }
    cuts.forEach(function (cut, index) {
      const row = document.createElement('div');
      row.className = 'pae-cut-row';
      const num = document.createElement('span'); num.className = 'pae-cut-num'; num.textContent = String(index + 1) + '.';
      const startInput = document.createElement('input'); startInput.className = 'pae-input pae-cut-input'; startInput.type = 'number'; startInput.min = '0'; startInput.max = String(duration); startInput.step = '0.001'; startInput.value = String(round3(cut.start)); startInput.setAttribute('aria-label', 'Początek wycinka ' + (index + 1) + ' w sekundach');
      const arrow = document.createElement('span'); arrow.className = 'pae-cut-arrow'; arrow.textContent = '→';
      const endInput = document.createElement('input'); endInput.className = 'pae-input pae-cut-input'; endInput.type = 'number'; endInput.min = '0'; endInput.max = String(duration); endInput.step = '0.001'; endInput.value = String(round3(cut.end)); endInput.setAttribute('aria-label', 'Koniec wycinka ' + (index + 1) + ' w sekundach');
      const updateBoundary = function (side, input) {
        const value = numberValue(input.value);
        if (!Number.isFinite(value)) { updateAudioUi(); return; }
        const next = cuts.map(function (item) { return { start: item.start, end: item.end }; });
        next[index][side] = value;
        if (!mutateCuts(next, 'Przesunięto granicę wycinka.')) updateAudioUi();
      };
      startInput.addEventListener('change', function () { updateBoundary('start', startInput); });
      endInput.addEventListener('change', function () { updateBoundary('end', endInput); });
      startInput.disabled = endInput.disabled = saveBusy;
      const length = document.createElement('span'); length.className = 'pae-cut-len'; length.textContent = '−' + formatTime(cut.end - cut.start, false);
      const seek = document.createElement('button'); seek.type = 'button'; seek.className = 'pae-btn icon'; seek.textContent = '▶'; seek.title = 'Przewiń do początku wycinka'; seek.setAttribute('aria-label', seek.title);
      seek.addEventListener('click', function () { try { mainAudio.currentTime = cut.start; } catch (e) {} });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pae-btn icon danger'; remove.textContent = '×'; remove.title = 'Przywróć ten fragment'; remove.setAttribute('aria-label', remove.title); remove.disabled = saveBusy;
      remove.addEventListener('click', function () {
        mutateCuts(cuts.filter(function (_, i) { return i !== index; }), 'Przywrócono fragment.');
      });
      row.appendChild(num); row.appendChild(startInput); row.appendChild(arrow); row.appendChild(endInput); row.appendChild(length); row.appendChild(seek); row.appendChild(remove);
      ui.cuts.appendChild(row);
    });
  }

  function mutateCuts(next, message) {
    let normalized;
    try { normalized = core.normalizeCuts(next, duration); } catch (e) { return false; }
    if (duration - core.editedDuration(duration, normalized) >= duration - 0.05 || core.editedDuration(duration, normalized) < 0.1) {
      setStatus(ui.audioStatus, 'Nie można usunąć całego utworu — zostaw co najmniej 0,1 s dźwięku.', 'error');
      return false;
    }
    history.push(cuts.map(function (cut) { return { start: cut.start, end: cut.end }; }));
    if (history.length > 30) history.shift();
    cuts = normalized;
    sessionEnabled = true;
    saveSession(false);
    setPreview(false);
    if (message) setStatus(ui.audioStatus, message, 'success');
    updateAudioUi();
    drawWave();
    return true;
  }

  function addCutFromInputs() {
    const start = numberValue(ui.start.value), end = numberValue(ui.end.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.01 || start < 0 || end > duration) {
      setStatus(ui.audioStatus, 'Podaj poprawny zakres: koniec musi być później niż początek i mieścić się w utworze.', 'error');
      return;
    }
    if (mutateCuts(cuts.concat([{ start: start, end: end }]), 'Dodano wycinek ' + formatTime(start, true) + ' → ' + formatTime(end, true) + '.')) {
      ui.start.value = String(round3(end));
      ui.end.value = String(round3(Math.min(duration, end + 1)));
    }
  }

  function undoCuts() {
    if (!history.length || saveBusy) return;
    cuts = history.pop();
    sessionEnabled = true; saveSession(false);
    setPreview(false);
    setStatus(ui.audioStatus, 'Cofnięto ostatnią zmianę.', 'success');
    updateAudioUi();
    drawWave();
  }

  function clearCuts() {
    if (!cuts.length || saveBusy) return;
    mutateCuts([], 'Wyczyszczono wszystkie wycinki.');
  }

  function detectSilence() {
    if (!buffer || saveBusy) return;
    setStatus(ui.audioStatus, 'Analizowanie cichych fragmentów…', '', true);
    setTimeout(function () {
      if (!open || !buffer) return;
      try {
        const found = core.detectSilence(buffer, { db: silenceDb, minDuration: silenceMin, padding: 0.03 });
        if (!found.length) { setStatus(ui.audioStatus, 'Nie znaleziono ciszy dłuższej niż ' + silenceMin + ' s przy progu ' + silenceDb + ' dB.', ''); return; }
        const before = JSON.stringify(cuts);
        const combined = core.normalizeCuts(cuts.concat(found), duration);
        if (JSON.stringify(combined) === before) { setStatus(ui.audioStatus, 'Wykryte ciche fragmenty są już zaznaczone.', ''); return; }
        mutateCuts(combined, 'Dodano ciszę: ' + found.length + (found.length === 1 ? ' zakres.' : ' zakresy.') + ' Sprawdź je przed zapisem.');
      } catch (error) {
        setStatus(ui.audioStatus, 'Nie udało się przeanalizować ciszy: ' + (error.message || error), 'error');
      }
    }, 30);
  }

  function setPreview(value) {
    preview = !!value && cuts.length > 0;
    if (ui.preview) {
      ui.preview.classList.toggle('active', preview);
      ui.preview.setAttribute('aria-pressed', String(preview));
    }
  }

  function animationTick(timestamp) {
    if (!open) return;
    if (duration > 0) {
      const now = mainAudio.currentTime || 0;
      if (zoom > 1 && !mainAudio.paused && !boundaryDrag && !draft && (now < viewStart || now > viewStart + viewDuration())) {
        viewStart = now - viewDuration() * 0.35; clampView(); updateViewUi(); drawWave();
      }
      const position = (now - viewStart) / Math.max(0.001, viewDuration());
      ui.playhead.hidden = position < 0 || position > 1;
      ui.playhead.style.left = (Math.max(0, Math.min(1, position)) * 100) + '%';
    }
    if (preview && cuts.length) {
      const now = mainAudio.currentTime || 0;
      const hit = cuts.find(function (cut) { return now >= cut.start && now < cut.end - 0.002; });
      if (hit) {
        try {
          if (hit.end >= duration - 0.03) { mainAudio.currentTime = duration; mainAudio.pause(); }
          else mainAudio.currentTime = hit.end + 0.001;
        } catch (e) {}
      }
    }
    if (activeTab === 'lyrics' && timestamp - lastLyricsPaint > 450) {
      lastLyricsPaint = timestamp;
      renderLyricsPreview();
    }
    raf = requestAnimationFrame(animationTick);
  }

  function drawWave() {
    if (!open || activeTab !== 'audio' || !ui.wave) return;
    const rect = ui.wave.getBoundingClientRect();
    const width = Math.max(2, Math.round(rect.width));
    const height = Math.max(2, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ui.wave.width !== Math.round(width * dpr) || ui.wave.height !== Math.round(height * dpr)) {
      ui.wave.width = Math.round(width * dpr);
      ui.wave.height = Math.round(height * dpr);
    }
    const ctx = ui.wave.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#0d1222'); bg.addColorStop(1, '#080b14');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const x = Math.round(width * i / 8) + .5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }

    if (peaks && peaks.length && duration > 0) {
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, 'rgba(77,227,255,.72)');
      gradient.addColorStop(.55, 'rgba(160,107,255,.78)');
      gradient.addColorStop(1, 'rgba(255,95,208,.68)');
      ctx.fillStyle = gradient;
      const middle = height / 2;
      for (let x = 0; x < width; x++) {
        const globalRatio = (viewStart + (x / Math.max(1, width)) * viewDuration()) / duration;
        const index = Math.max(0, Math.min(peaks.length - 1, Math.floor(globalRatio * peaks.length)));
        const peak = Math.max(.012, peaks[index]);
        const half = Math.max(1, peak * (height - 18) / 2);
        ctx.fillRect(x, middle - half, 1, half * 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(0, middle, width, 1);
    }

    if (duration > 0) {
      cuts.forEach(function (cut) {
        const visible = viewDuration();
        const start = Math.max(cut.start, viewStart), end = Math.min(cut.end, viewStart + visible);
        if (end <= start) return;
        const x = (start - viewStart) / visible * width;
        const w = Math.max(1, (end - start) / visible * width);
        ctx.fillStyle = 'rgba(255,72,105,.25)'; ctx.fillRect(x, 0, w, height);
        ctx.fillStyle = 'rgba(255,125,145,.9)';
        if (cut.start >= viewStart && cut.start <= viewStart + visible) ctx.fillRect((cut.start - viewStart) / visible * width, 0, 2, height);
        if (cut.end >= viewStart && cut.end <= viewStart + visible) ctx.fillRect(Math.min(width - 1, (cut.end - viewStart) / visible * width - 1), 0, 2, height);
        ctx.strokeStyle = 'rgba(255,180,190,.32)';
        for (let sx = x - height; sx < x + w; sx += 9) { ctx.beginPath(); ctx.moveTo(Math.max(x, sx), 0); ctx.lineTo(Math.min(x + w, sx + height), height); ctx.stroke(); }
      });
      if (draft) {
        const visible = viewDuration();
        const start = Math.min(draft.start, draft.end), end = Math.max(draft.start, draft.end);
        const x = (start - viewStart) / visible * width, w = Math.max(1, (end - start) / visible * width);
        ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(x, 0, w, height);
        ctx.strokeStyle = '#fff'; ctx.strokeRect(x + .5, .5, Math.max(0, w - 1), height - 1);
      }
    }
  }

  function eventTime(event) {
    const rect = ui.wave.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return viewStart + ratio * viewDuration();
  }
  function boundaryAt(event) {
    if (!duration || !cuts.length) return null;
    const rect = ui.wave.getBoundingClientRect();
    let best = null;
    cuts.forEach(function (cut, index) {
      ['start', 'end'].forEach(function (side) {
        const time = cut[side];
        if (time < viewStart || time > viewStart + viewDuration()) return;
        const x = rect.left + (time - viewStart) / viewDuration() * rect.width;
        const distance = Math.abs(event.clientX - x);
        if (distance <= 9 && (!best || distance < best.distance)) best = { index: index, side: side, distance: distance };
      });
    });
    return best;
  }

  function bindWaveEvents() {
    ui.wave.addEventListener('pointerdown', function (event) {
      if (!(buffer || nativeMode) || saveBusy || event.button !== 0) return;
      event.preventDefault();
      const hit = boundaryAt(event);
      if (hit) {
        boundaryDrag = { index: hit.index, side: hit.side, pointerId: event.pointerId, before: cuts.map(function (cut) { return { start: cut.start, end: cut.end }; }) };
      } else {
        const time = eventTime(event);
        draft = { start: time, end: time, pointerId: event.pointerId };
      }
      try { ui.wave.setPointerCapture(event.pointerId); } catch (e) {}
      drawWave();
    });
    ui.wave.addEventListener('pointermove', function (event) {
      if (boundaryDrag && boundaryDrag.pointerId === event.pointerId) {
        const cut = cuts[boundaryDrag.index];
        if (!cut) return;
        const time = eventTime(event);
        if (boundaryDrag.side === 'start') cut.start = Math.max(0, Math.min(time, cut.end - 0.01));
        else cut.end = Math.min(duration, Math.max(time, cut.start + 0.01));
        updateAudioUi(); drawWave(); return;
      }
      if (draft && draft.pointerId === event.pointerId) { draft.end = eventTime(event); drawWave(); return; }
      ui.wave.style.cursor = boundaryAt(event) ? 'ew-resize' : 'crosshair';
    });
    ui.wave.addEventListener('pointerup', function (event) {
      if (boundaryDrag && boundaryDrag.pointerId === event.pointerId) {
        const drag = boundaryDrag; boundaryDrag = null;
        const next = cuts.map(function (cut) { return { start: cut.start, end: cut.end }; });
        cuts = drag.before;
        mutateCuts(next, 'Przesunięto granicę wycinka.'); drawWave(); return;
      }
      if (!draft || draft.pointerId !== event.pointerId) return;
      const selection = draft;
      draft = null;
      const start = Math.min(selection.start, selection.end), end = Math.max(selection.start, selection.end);
      if (end - start >= 0.08) {
        ui.start.value = String(round3(start)); ui.end.value = String(round3(end));
        mutateCuts(cuts.concat([{ start: start, end: end }]), 'Dodano wycinek ' + formatTime(start, true) + ' → ' + formatTime(end, true) + '.');
      } else {
        try { mainAudio.currentTime = start; } catch (e) {}
        drawWave();
      }
    });
    ui.wave.addEventListener('pointercancel', function () {
      if (boundaryDrag) { cuts = boundaryDrag.before; boundaryDrag = null; updateAudioUi(); }
      draft = null; drawWave();
    });
    ui.wave.addEventListener('wheel', function (event) {
      if (!event.ctrlKey || !duration) return;
      event.preventDefault();
      const center = eventTime(event);
      setZoom(zoom * (event.deltaY < 0 ? 2 : 0.5), center);
    }, { passive: false });
    window.addEventListener('resize', function () { if (open) drawWave(); });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  async function writeBlob(path, blob) {
    const fs = window.__pulsarFs;
    if (!fs || !fs.writeBinary) { downloadBlob(blob, fileNameFromPath(path, 'edycja.wav')); return; }
    const chunkSize = 8 * 1024 * 1024;
    if (!fs.appendBinary && blob.size > chunkSize) throw new Error('Zapis dużych plików nie jest obsługiwany.');
    const first = new Uint8Array(await blob.slice(0, Math.min(chunkSize, blob.size)).arrayBuffer());
    await fs.writeBinary(path, first);
    for (let offset = chunkSize; offset < blob.size; offset += chunkSize) {
      const chunk = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      await fs.appendBinary(path, chunk);
    }
  }

  async function localSyncedLyrics() {
    // Nie używaj globalnego lyricsData bez kontroli utworu: przy wyłączonych
    // napisach mogło ono zostać po poprzednim odtwarzanym pliku.
    const data = player.__lyrics.forTrack ? player.__lyrics.forTrack(track.id) : null;
    if (data && Array.isArray(data.synced) && data.synced.length) return data.synced;
    if (track && track.lrcFile && typeof track.lrcFile.text === 'function') {
      try {
        const parsed = player.__lyrics.parse(await track.lrcFile.text());
        if (parsed.length) return parsed;
      } catch (e) {}
    }
    return null;
  }

  async function saveEditedAudio() {
    if (!(buffer || nativeMode) || !duration || saveBusy) return;
    const useNative = nativeMode || outputFormat !== 'wav';
    const tools = window.__pulsarDesktopTools;
    if (useNative && (!tools || !tools.available || !ffmpegAvailable)) { setStatus(ui.audioStatus, 'Ten eksport wymaga dostępnego FFmpeg.', 'error'); return; }
    saveBusy = true;
    let completed = false;
    saveSession(false);
    updateAudioUi();
    setStatus(ui.audioStatus, useNative ? 'FFmpeg przygotowuje eksport bez dekodowania w WebView…' : 'Sklejanie audio i zapisywanie WAV…', '', true);
    try {
      const defaultName = core.editedFileName(track.file.name, ' (edycja)', outputFormat);
      const fs = window.__pulsarFs;
      const saveDialog = fs && fs.saveDialog ? fs.saveDialog : tools && tools.available ? tools.fs.saveDialog : null;
      let path = '';
      if (saveDialog) {
        path = await saveDialog('Zapisz przycięty utwór', defaultName, outputFormat, outputFormat.toUpperCase());
        if (!path) { setStatus(ui.audioStatus, 'Anulowano zapis — zmiany nadal są w edytorze.', ''); return; }
        if (track.srcPath && samePath(path, track.srcPath)) throw new Error('Wybierz inną nazwę lub folder. Edytor nie nadpisuje oryginalnego pliku.');
      }
      const outputName = fileNameFromPath(path, defaultName);
      const outputTitle = (track.title || outputName.replace(/\.[^.]+$/, '')) + ' (edycja)';
      const mime = outputFormat === 'mp3' ? 'audio/mpeg' : outputFormat === 'flac' ? 'audio/flac' : 'audio/wav';
      let blob = null;
      let importSkipped = false;
      setStatus(ui.audioStatus, 'Zapisywanie ' + outputName + '…', '', true);
      if (useNative) {
        const result = await tools.exportAudio({ inputPath: track.srcPath || '', inputBlob: track.file, inputName: track.file.name, outputPath: path, format: outputFormat, duration: duration, segments: core.keptSegments(duration, cuts), fadeInMs: fadeInMs, fadeOutMs: fadeOutMs, joinFadeMs: joinFadeMs, title: outputTitle, artist: track.artist || '' });
        path = result.path;
        if (ui.import.checked) {
          if (result.size > 256 * 1024 * 1024) importSkipped = true;
          else blob = new Blob([await tools.fs.read(path)], { type: mime });
        }
      } else {
        const wav = core.renderCutWav(buffer, cuts, { fadeInMs: fadeInMs, fadeOutMs: fadeOutMs, joinFadeMs: joinFadeMs });
        blob = new Blob([wav], { type: mime });
        if (path) await writeBlob(path, blob);
        else downloadBlob(blob, outputName);
      }

      let imported = false;
      let alreadyThere = false;
      if (ui.import.checked && !importSkipped) {
        let adjusted = null;
        const sourceLines = await localSyncedLyrics();
        if (sourceLines) {
          const offset = player.__lyrics.offset ? player.__lyrics.offset() : 0;
          const lines = core.remapLyrics(sourceLines, cuts, offset, duration);
          if (lines.length) adjusted = { synced: lines, plain: null, source: 'lrc' };
        }
        const outputFile = new File([blob], outputName, { type: mime });
        const id = player.__editor.importEdited(outputFile, track.id, {
          path: path,
          title: outputTitle,
          duration: core.editedDuration(duration, cuts),
          lyrics: adjusted,
          lrcText: adjusted ? core.formatLRC(adjusted.synced) : ''
        });
        imported = !!id;
        alreadyThere = !id;
      }
      const message = importSkipped ? 'Plik zapisany. Import do biblioteki pominięto dla pliku powyżej 256 MB, aby oszczędzić pamięć.' : imported ? 'Zapisano i dodano nowy utwór do biblioteki.' : alreadyThere ? 'Plik zapisany. Identyczna wersja jest już w bibliotece.' : 'Zapisano przycięty plik ' + outputFormat.toUpperCase() + '.';
      setStatus(ui.audioStatus, message, 'success');
      toast(message);
      completed = true;
    } catch (error) {
      console.warn('Pulsar Editor: zapis nie powiódł się', error);
      setStatus(ui.audioStatus, 'Nie udało się zapisać: ' + (error.message || error), 'error');
    } finally {
      saveBusy = false;
      if (open) updateAudioUi();
    }
    if (completed && open) closeEditor();
  }

  function editorLyricsData() {
    if (!track) return null;
    return player.__lyrics.forTrack ? player.__lyrics.forTrack(track.id) : (player.__lyrics.data ? player.__lyrics.data() : null);
  }
  function lyricsHaveWords(data) {
    return !!(data && Array.isArray(data.synced) && data.synced.some(function (line) { return Array.isArray(line.words) && line.words.length; }));
  }
  function lyricsSourceLines(data) {
    if (!data) return [];
    const source = Array.isArray(data.synced) && data.synced.length ? data.synced.map(function (line) { return line && line.txt; }) : (Array.isArray(data.plain) ? data.plain : []);
    return source.map(function (line) { return String(line || '').trim(); }).filter(Boolean);
  }
  function aiProgress(stage) {
    if (!open || !track || track.id !== aiBusyId) return;
    const messages = {
      check: 'Sprawdzanie lokalnego środowiska AI…',
      prepare: 'Przygotowywanie modułu AI…',
      python: 'Tworzenie izolowanego środowiska Python…',
      install: 'Instalowanie Stable-TS i Faster-Whisper… To jednorazowe, duże pobranie.',
      align: 'Analiza audio i dopasowywanie słów na CPU… Przy pierwszym użyciu trwa też pobieranie modelu base.',
      done: 'Zapisywanie wyniku…'
    };
    setStatus(ui.aiStatus, messages[stage] || messages.prepare, '', true);
  }
  function currentAiCandidate() { return aiCandidate && track && aiCandidate.id === track.id ? aiCandidate : null; }
  function updateAiRangeUi() {
    if (!ui.aiScope) return;
    const locked = aiBusy || !!currentAiCandidate();
    const ranged = ui.aiScope.value === 'range';
    ui.aiScope.disabled = locked;
    ui.aiRangeStart.disabled = locked || !ranged; ui.aiRangeEnd.disabled = locked || !ranged;
    byId('paeAiRangeNowStart').disabled = locked || !ranged; byId('paeAiRangeNowEnd').disabled = locked || !ranged;
  }
  function updateVersionWarning(data) {
    if (!ui.versionWarning) return;
    let warning = '';
    const audioDuration = Number(duration || (track && track.duration) || 0);
    if (data && !data.generated && Array.isArray(data.synced) && data.synced.length && audioDuration > 0) {
      const sourceDuration = Number(data.sourceDuration) || 0;
      if (sourceDuration > 0 && Math.abs(sourceDuration - audioDuration) > 2) {
        warning = 'Źródło napisów ma ' + formatTime(sourceDuration, false) + ', a nagranie ' + formatTime(audioDuration, false) + '. Czasy mogą pochodzić z innej wersji, np. studyjnej zamiast teledysku.';
      } else {
        const last = data.synced.reduce(function (value, line) { return Math.max(value, Number(line && line.t) || 0); }, 0);
        if (last > audioDuration + 1) warning = 'Ostatni znacznik napisów wykracza poza nagranie. Te czasy mogą należeć do innej wersji utworu.';
      }
    }
    ui.versionWarning.hidden = !warning;
    ui.versionWarningText.textContent = warning;
  }
  function alignFirstWordHere() {
    const data = player.__lyrics.data && player.__lyrics.data();
    const first = data && core.firstLyricsTime(data.synced);
    if (first == null) { setStatus(ui.lyricsStatus, 'Najpierw znajdź zsynchronizowany tekst.', 'error'); return; }
    const now = Number(mainAudio.currentTime) || 0;
    setLyricsOffset(now - first);
    setStatus(ui.lyricsStatus, 'Ustawiono pierwsze słowo na ' + formatTime(now, true) + '. Nowe przesunięcie: ' + formatOffset(player.__lyrics.offset()) + '.', 'success');
  }
  function paintAiCandidateButtons() {
    if (!ui.aiPreviewSource) return;
    ui.aiPreviewSource.classList.toggle('active', aiPreviewVariant === 'source');
    ui.aiPreviewNew.classList.toggle('active', aiPreviewVariant === 'new');
  }
  function restoreSavedLyricsView() {
    const saved = editorLyricsData();
    if (saved && player.__lyrics.render) player.__lyrics.render(saved);
    aiPreviewVariant = '';
    paintAiCandidateButtons();
    renderLyricsPreview();
  }
  function previewAiCandidate(variant, autoplay) {
    const candidate = currentAiCandidate();
    if (!candidate) return;
    aiPreviewVariant = variant === 'source' ? 'source' : 'new';
    let shown = candidate.before;
    if (aiPreviewVariant === 'new') {
      const offset = player.__lyrics.offset ? player.__lyrics.offset() : 0;
      shown = Object.assign({}, candidate.data, { synced: core.shiftLyricsDetailed(candidate.data.synced, -offset, false) });
    }
    if (player.__lyrics.render) player.__lyrics.render(shown);
    paintAiCandidateButtons();
    renderLyricsPreview();
    if (autoplay) {
      try {
        mainAudio.currentTime = candidate.previewStart;
        const promise = mainAudio.play(); if (promise && promise.catch) promise.catch(function () {});
      } catch (e) {}
    }
  }
  function acceptAiCandidate() {
    const candidate = currentAiCandidate();
    if (!candidate || aiBusy) return;
    try {
      player.__lyrics.applyFor(candidate.id, candidate.data, { allowSourceWordSync: candidate.sourceWords });
      aiCandidate = null; aiPreviewVariant = '';
      setLyricsOffset(0);
      lyricsLoadedId = candidate.id;
      updateAiUi(); renderLyricsPreview();
      toast('Nowe dopasowanie zapisano przy utworze');
    } catch (error) { setStatus(ui.aiStatus, 'Nie udało się zapisać wyniku: ' + (error.message || error), 'error'); }
  }
  function discardAiCandidate() {
    if (!currentAiCandidate() || aiBusy) return;
    aiCandidate = null;
    restoreSavedLyricsView();
    updateAiUi();
    setStatus(ui.aiStatus, 'Odrzucono niezapisany wynik. Poprzednie napisy pozostały bez zmian.', 'success');
  }
  function updateAiUi(keepStatus) {
    if (!ui.aiAlign) return;
    const tools = window.__pulsarDesktopTools;
    const supported = !!(tools && tools.available && typeof tools.alignLyrics === 'function' && player.__lyrics.applyFor);
    const data = editorLyricsData();
    const sourceWords = !!(data && !data.generated && lyricsHaveWords(data));
    const hasText = lyricsSourceLines(data).length > 0;
    const thisBusy = aiBusy && track && aiBusyId === track.id;
    const candidate = currentAiCandidate();
    const pendingOther = !!aiCandidate && !candidate;
    const offsetLocked = aiBusy || !!candidate;
    ui.offsetRange.disabled = offsetLocked; ui.offsetNumber.disabled = offsetLocked; ui.offsetFirst.disabled = offsetLocked;
    byId('paeOffsetReset').disabled = offsetLocked;
    ui.dim.querySelectorAll('[data-offset-step]').forEach(function (button) { button.disabled = offsetLocked; });
    ui.aiCandidate.hidden = !candidate;
    ui.aiAlign.disabled = !supported || aiBusy || !!candidate || pendingOther || !hasText;
    ui.aiAlign.textContent = thisBusy ? 'Przetwarzanie…' : (candidate ? 'Wynik oczekuje na decyzję' : 'Dopasuj tekst do audio');
    ui.aiLanguage.disabled = aiBusy || !!candidate;
    ui.aiRestore.hidden = !(data && data.generated);
    ui.aiRestore.disabled = aiBusy || !!candidate;
    updateAiRangeUi(); updateVersionWarning(data); paintAiCandidateButtons();
    if (thisBusy || keepStatus) return;
    if (aiBusy) { setStatus(ui.aiStatus, 'Inny utwór jest teraz analizowany. Poczekaj na zakończenie.', ''); return; }
    if (!supported) { setStatus(ui.aiStatus, 'Lokalne dopasowanie AI jest dostępne w desktopowej wersji Pulsara dla Windows i Linux.', ''); return; }
    if (candidate) { setStatus(ui.aiStatus, 'Porównaj oba warianty na tym samym fragmencie. Zmiana zostanie zapisana dopiero po kliknięciu „Zapisz nowe dopasowanie”.', 'success'); return; }
    if (pendingOther) { setStatus(ui.aiStatus, 'Inny utwór ma niezapisany wynik AI. Otwórz go i zapisz albo odrzuć wynik przed nową analizą.', ''); return; }
    if (sourceWords) { setStatus(ui.aiStatus, 'Źródło ma już czasy słów. Jeśli nie pasują do tego nagrania, możesz ręcznie wykonać nowe dopasowanie. Poprzednie napisy zostaną zachowane do przywrócenia.', ''); return; }
    if (data && data.generated) {
      const coverage = Number.isFinite(Number(data.coverage)) ? ' Pokrycie tekstu: ' + Math.round(Number(data.coverage) * 100) + '%.' : '';
      setStatus(ui.aiStatus, 'Eksperymentalny wynik AI · model ' + String(data.model || 'base') + '.' + coverage + ' Możesz przywrócić napisy źródłowe.', 'success');
      return;
    }
    if (!hasText) { setStatus(ui.aiStatus, 'Najpierw znajdź tekst utworu. AI dopasowuje istniejące napisy, a nie zgaduje ich treść.', ''); return; }
    if (aiCaps && aiCaps.ready) setStatus(ui.aiStatus, 'Środowisko i model base są gotowe. Analiza rozpocznie się dopiero po kliknięciu.', 'success');
    else setStatus(ui.aiStatus, 'Gotowe do ręcznego uruchomienia. Przed pierwszym pobraniem zobaczysz potwierdzenie.', '');
  }
  async function refreshAiCapabilities() {
    const tools = window.__pulsarDesktopTools;
    if (!tools || !tools.available || typeof tools.lyricsAiCapabilities !== 'function') {
      aiCaps = { available: false, ready: false }; updateAiUi(); return;
    }
    try { aiCaps = await tools.lyricsAiCapabilities(); }
    catch (error) { aiCaps = { available: true, ready: false, error: String(error && error.message || error) }; }
    updateAiUi();
  }
  async function runAiAlignment() {
    if (aiBusy || !track) return;
    if (aiCandidate) { setStatus(ui.aiStatus, 'Najpierw zapisz albo odrzuć oczekujący wynik AI.', ''); return; }
    const tools = window.__pulsarDesktopTools;
    const data = editorLyricsData();
    if (!tools || !tools.available || typeof tools.alignLyrics !== 'function') { setStatus(ui.aiStatus, 'Ta funkcja wymaga desktopowej wersji Pulsara.', 'error'); return; }
    const sourceWords = !!(data && !data.generated && lyricsHaveWords(data));
    const partial = ui.aiScope.value === 'range';
    const rangeStart = numberValue(ui.aiRangeStart.value), rangeEnd = numberValue(ui.aiRangeEnd.value);
    const offset = player.__lyrics.offset ? player.__lyrics.offset() : 0;
    if (partial && (!(rangeStart >= 0) || !(rangeEnd > rangeStart) || (duration > 0 && rangeEnd > duration))) { setStatus(ui.aiStatus, 'Ustaw poprawny zakres wewnątrz nagrania.', 'error'); return; }
    if (partial && (!data || !Array.isArray(data.synced))) { setStatus(ui.aiStatus, 'Dopasowanie zakresu wymaga zsynchronizowanych linii. Dla zwykłego tekstu użyj całego utworu.', 'error'); return; }
    const lines = partial ? core.lyricsTextsInRange(data.synced, rangeStart, rangeEnd, offset) : lyricsSourceLines(data);
    if (!lines.length) { setStatus(ui.aiStatus, partial ? 'W tym zakresie nie ma linii do dopasowania.' : 'Brak tekstu do dopasowania.', 'error'); return; }
    const jobTrack = track;
    const id = jobTrack.id;
    aiBusy = true; aiBusyId = id; updateAiUi(); aiProgress('check');
    let failed = false;
    try {
      aiCaps = await tools.lyricsAiCapabilities();
      // Do not show an installation consent prompt after the user closed the editor.
      if (!open || !track || track.id !== id) return;
      const ready = !!(aiCaps && aiCaps.ready);
      const download = ready
        ? 'Lokalne środowisko AI jest gotowe. Jeśli model base nie był jeszcze pobrany, pierwsza analiza pobierze ok. 150 MB.'
        : 'Przed analizą Pulsar pobierze izolowane środowisko Python (od ok. 2 GB, zależnie od platformy) oraz model base (ok. 150 MB). Wymagany jest Python 3.10+ i dostęp do internetu.';
      const replacement = sourceWords ? '\n\nTen utwór ma już word-sync. Po porównaniu możesz zastąpić go dla tego nagrania, a poprzednie napisy źródłowe zostaną zachowane do przywrócenia.' : '';
      const rangeInfo = partial ? '\n\nAnaliza obejmie tylko zakres ' + formatTime(rangeStart, true) + '–' + formatTime(rangeEnd, true) + ' i linie: ' + lines.length + '.' : '';
      if (!window.confirm('Eksperymentalne dopasowanie AI\n\n' + download + replacement + rangeInfo + '\n\nAnaliza na CPU może potrwać od kilku do kilkudziesięciu minut. Tekst i audio są przetwarzane lokalnie. Kontynuować?')) return;
      aiProgress('prepare');
      const job = {
        inputPath: jobTrack.srcPath || '', inputBlob: jobTrack.file, inputName: jobTrack.file.name,
        lines: lines, language: ui.aiLanguage.value, model: 'base',
        hasSourceWordSync: sourceWords, allowSourceWordSync: sourceWords
      };
      if (partial) { job.audioStart = rangeStart; job.audioEnd = rangeEnd; }
      const result = await tools.alignLyrics(job, aiProgress);
      let candidateData = result;
      if (partial) {
        if (!result.synced.some(function (line) { return line.t >= rangeStart && line.t < rangeEnd; })) throw new Error('AI nie zwróciło czasów wewnątrz wybranego zakresu; poprzednie napisy pozostają bez zmian');
        const merged = core.mergeLyricsRange(data.synced, result.synced, rangeStart, rangeEnd, offset);
        candidateData = Object.assign({}, result, { synced: merged, partial: true, alignmentRange: { start: rangeStart, end: rangeEnd } });
        candidateData.wordSync = merged.some(function (line) { return Array.isArray(line.words) && line.words.length; });
      }
      const first = core.firstLyricsTime(candidateData.synced);
      aiCandidate = {
        id: id, data: candidateData, before: data, sourceWords: sourceWords,
        previewStart: partial ? rangeStart : Math.max(0, (first == null ? 0 : first) - 0.75)
      };
      if (open && track && track.id === id) {
        lyricsLoadedId = id;
        previewAiCandidate('new', false);
        toast('Wynik AI jest gotowy do porównania — jeszcze niezapisany');
      } else toast('Analiza zakończona; wynik oczekuje na porównanie: ' + (jobTrack.title || jobTrack.file.name));
    } catch (error) {
      failed = true;
      const message = String(error && error.message || error);
      if (open && track && track.id === id) setStatus(ui.aiStatus, 'Dopasowanie nie powiodło się: ' + message, 'error');
      else { console.warn('Pulsar AI:', error); toast('Dopasowanie AI nie powiodło się'); }
    } finally {
      aiBusy = false; aiBusyId = '';
      if (open) { updateAiUi(failed); if (track && track.id === id) renderLyricsPreview(); }
    }
  }
  async function restoreSourceLyrics() {
    if (aiBusy || !track || !player.__lyrics.resetFor) return;
    const data = editorLyricsData();
    if (!data || !data.generated) return;
    if (!window.confirm('Usunąć eksperymentalne czasy AI i ponownie użyć napisów ze źródła?')) return;
    const id = track.id;
    ui.aiRestore.disabled = true;
    setStatus(ui.aiStatus, 'Przywracanie napisów źródłowych…', '', true);
    let failed = false;
    try {
      await player.__lyrics.resetFor(id);
      if (open && track && track.id === id) {
        lyricsLoadedId = id;
        renderLyricsPreview();
        toast('Przywrócono napisy źródłowe');
      }
    } catch (error) {
      failed = true;
      if (open && track && track.id === id) setStatus(ui.aiStatus, 'Nie udało się przywrócić źródła: ' + (error.message || error), 'error');
    } finally { if (open) updateAiUi(failed); }
  }

  async function ensureLyrics() {
    if (!open || !track) return;
    const token = ++lyricsToken;
    updateLyricsOffsetUi();
    if (lyricsLoadedId === track.id) { renderLyricsPreview(); updateAiUi(); return; }
    setStatus(ui.lyricsStatus, 'Wczytywanie napisów…', '', true);
    try {
      if (player.__lyrics.set) player.__lyrics.set(true);
      // fetchFor jest szybkie dla cache, a przede wszystkim gwarantuje, że
      // globalny podgląd należy do utworu otwartego w edytorze.
      await player.__lyrics.fetchFor(track.index);
      if (!open || token !== lyricsToken) return;
      lyricsLoadedId = track.id;
      renderLyricsPreview();
      const data = player.__lyrics.data();
      if (data && data.synced) setStatus(ui.lyricsStatus, 'Przeciągnij suwak podczas odtwarzania, aby dopasować tekst.', 'success');
      else if (data && data.plain) setStatus(ui.lyricsStatus, 'Ten tekst nie ma znaczników czasu. Przesuwać i eksportować można tylko napisy zsynchronizowane (LRC).', '');
      else setStatus(ui.lyricsStatus, 'Nie znaleziono napisów dla tego utworu.', '');
      updateAiUi();
      refreshAiCapabilities();
    } catch (error) {
      if (!open || token !== lyricsToken) return;
      setStatus(ui.lyricsStatus, 'Nie udało się wczytać napisów: ' + (error.message || error), 'error');
      renderLyricsPreview();
      updateAiUi();
    }
  }

  function updateLyricsOffsetUi(source) {
    if (!ui.offsetValue || !player.__lyrics.offset) return;
    const value = player.__lyrics.offset();
    ui.offsetValue.textContent = formatOffset(value);
    if (source !== 'range') ui.offsetRange.value = String(Math.max(-10, Math.min(10, value)));
    if (source !== 'number') ui.offsetNumber.value = String(Math.round(value * 100) / 100);
  }

  function setLyricsOffset(value, source) {
    if (!player.__lyrics.setOffset) return;
    if (!Number.isFinite(value)) { updateLyricsOffsetUi(); return; }
    player.__lyrics.setOffset(Math.max(-300, Math.min(300, value)));
    updateLyricsOffsetUi(source);
    renderLyricsPreview();
  }

  function renderLyricsPreview() {
    if (!open || !ui.lyricsPreview) return;
    const data = player.__lyrics.data && player.__lyrics.data();
    ui.lyricsPreview.textContent = '';
    ui.exportLrc.disabled = aiBusy || !!currentAiCandidate() || !(data && Array.isArray(data.synced) && data.synced.length);
    if (!data || !Array.isArray(data.synced) || !data.synced.length) {
      const empty = document.createElement('div');
      empty.className = 'pae-empty-cuts';
      empty.textContent = data && data.plain ? 'Tekst bez znaczników czasu — brak synchronizacji do regulacji.' : 'Brak zsynchronizowanych napisów do podglądu.';
      ui.lyricsPreview.appendChild(empty);
      return;
    }
    const offset = player.__lyrics.offset ? player.__lyrics.offset() : 0;
    const shifted = core.shiftLyrics(data.synced, offset);
    const now = mainAudio.currentTime || 0;
    let current = -1;
    shifted.forEach(function (line, index) { if (line.t <= now + .05) current = index; });
    const start = Math.max(0, Math.min(Math.max(0, current - 2), Math.max(0, shifted.length - 8)));
    shifted.slice(start, start + 8).forEach(function (line, localIndex) {
      const index = start + localIndex;
      const row = document.createElement('div');
      row.className = 'pae-lyric-row' + (index === current ? ' active' : '');
      const time = document.createElement('time'); time.textContent = formatTime(line.t, false);
      const text = document.createElement('span'); text.textContent = line.txt;
      row.appendChild(time); row.appendChild(text);
      row.addEventListener('click', function () { try { mainAudio.currentTime = line.t; } catch (e) {} });
      ui.lyricsPreview.appendChild(row);
    });
  }

  async function exportShiftedLrc() {
    const data = player.__lyrics.data && player.__lyrics.data();
    if (!data || !Array.isArray(data.synced) || !data.synced.length || !track) return;
    try {
      const offset = player.__lyrics.offset ? player.__lyrics.offset() : 0;
      const lines = core.shiftLyrics(data.synced, offset);
      const blob = new Blob([core.formatLRC(lines)], { type: 'text/plain;charset=utf-8' });
      const base = String(track.file.name || 'napisy').replace(/\.[^.]+$/, '');
      const name = core.safeFileName(base + ' (przesunięte)') + '.lrc';
      const fs = window.__pulsarFs;
      let path = '';
      if (fs && fs.saveDialog) {
        path = await fs.saveDialog('Eksportuj przesunięte napisy', name, 'lrc', 'Napisy LRC');
        if (!path) return;
      }
      if (path) await writeBlob(path, blob); else downloadBlob(blob, name);
      setStatus(ui.lyricsStatus, 'Zapisano przesunięte napisy LRC.', 'success');
      toast('Wyeksportowano przesunięte napisy LRC');
    } catch (error) {
      setStatus(ui.lyricsStatus, 'Nie udało się wyeksportować LRC: ' + (error.message || error), 'error');
    }
  }

  // Blokuje skróty głównego okna, które mogłyby zmienić utwór pod otwartym edytorem.
  window.addEventListener('keydown', function (event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); closeEditor(); return;
    }
    const tag = String(event.target && event.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    if (event.code === 'Space' || key === ' ') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (mainAudio.paused) { const promise = mainAudio.play(); if (promise && promise.catch) promise.catch(function () {}); }
      else mainAudio.pause();
    } else if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'n', 'p', 's', 'r', 'l', 'q', 'f', 'm', '?'].indexOf(key) > -1) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 'arrowleft') mainAudio.currentTime = Math.max(0, (mainAudio.currentTime || 0) - 5);
      if (key === 'arrowright') mainAudio.currentTime = Math.min(duration, (mainAudio.currentTime || 0) + 5);
    }
  }, true);

  buildButton();
  buildPanel();
  window.PulsarAudioEditor = {
    open: openEditor,
    close: closeEditor,
    saveSession: function () { sessionEnabled = true; saveSession(true); },
    state: function () { return { open: open, tab: activeTab, trackId: track && track.id, cuts: cuts.map(function (cut) { return { start: cut.start, end: cut.end }; }), preview: preview, decoded: !!buffer, nativeMode: nativeMode, ffmpeg: ffmpegAvailable, busy: saveBusy, aiBusy: aiBusy, aiBusyId: aiBusyId, zoom: zoom, viewStart: viewStart, fadeInMs: fadeInMs, fadeOutMs: fadeOutMs, joinFadeMs: joinFadeMs, silenceDb: silenceDb, silenceMin: silenceMin, format: outputFormat, sessionKey: sessionKey() }; }
  };
})();
