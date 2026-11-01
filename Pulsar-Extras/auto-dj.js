/* Pulsar Auto-DJ 2.0 — nastroje, różnorodność, historia i wyjaśnienia. */
(function () {
  'use strict';
  const player = window.__player;
  const core = window.PulsarDjCore;
  if (!player || !player.__dj || !core || typeof document === 'undefined') return;

  const KEY = 'pulsarAutoDjPlus';
  let settings = load();
  let oneShotSimilar = false;
  let lastChoice = null;
  let refreshTimer = 0;
  let ui = {};

  function load() {
    try { return core.settingsOf(JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return core.settingsOf(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
  }
  function toast(text) { try { if (window.__pulsarHost) window.__pulsarHost.toast(text); } catch (e) {} }
  function el(id) { return document.getElementById(id); }
  function trackLabel(track) { return String(track && track.title || 'Utwór') + (track && track.artist ? ' — ' + track.artist : ''); }
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); }

  function build() {
    if (el('pulsarDjPlus')) return;
    const toggle = el('smAutoDj');
    const parentCard = toggle && toggle.closest('.sm-card');
    if (!parentCard || !parentCard.parentNode) return;
    const card = document.createElement('section');
    card.className = 'sm-card padj-card';
    card.id = 'pulsarDjPlus';
    card.innerHTML = `
      <h3 class="sm-cap">Auto-DJ 2.0</h3>
      <div class="sm-row"><div class="sm-txt"><span class="sm-lab">Nastrój</span><span class="sm-desc">Tempo, energia i znajomość utworów</span></div><select class="sm-select" id="padjMood" aria-label="Nastrój Auto-DJ"><option value="balance">Zbalansowany</option><option value="calm">Spokojnie</option><option value="focus">Skupienie</option><option value="workout">Trening</option><option value="party">Impreza</option><option value="discovery">Odkrywanie</option></select></div>
      <div class="sm-row sm-row-range"><div class="sm-txt"><span class="sm-lab">Różnorodność wykonawców</span><span class="sm-desc">100% omija powtórki, gdy jest wybór</span></div><input type="range" id="padjArtists" min="0" max="100" step="5"><span class="sm-val" id="padjArtistsVal"></span></div>
      <div class="sm-row sm-row-range"><div class="sm-txt"><span class="sm-lab">Różnorodność gatunków / albumów</span><span class="sm-desc">Używa gatunku, a gdy go brak — albumu</span></div><input type="range" id="padjGenres" min="0" max="100" step="5"><span class="sm-val" id="padjGenresVal"></span></div>
      <div class="padj-actions"><button type="button" class="sm-btn" id="padjSimilar">▶ Więcej podobnych</button><button type="button" class="sm-mini" id="padjUndo">↶ Cofnij wybór DJ</button></div>
      <div class="padj-choice" aria-live="polite"><strong id="padjNext">Wybierz utwór, aby zobaczyć propozycję</strong><span id="padjReason"></span></div>
      <details class="padj-history"><summary>Ostatnio wybrane <span id="padjHistoryCount"></span></summary><div id="padjHistory"></div></details>`;
    parentCard.parentNode.insertBefore(card, parentCard.nextSibling);
    ui = { mood: el('padjMood'), artists: el('padjArtists'), genres: el('padjGenres'), artistsVal: el('padjArtistsVal'), genresVal: el('padjGenresVal'), next: el('padjNext'), reason: el('padjReason'), history: el('padjHistory'), historyCount: el('padjHistoryCount') };
    ui.mood.value = settings.mood;
    ui.artists.value = settings.artistDiversity;
    ui.genres.value = settings.genreDiversity;
    ui.mood.addEventListener('change', function () { settings.mood = ui.mood.value; changed(); });
    ui.artists.addEventListener('input', function () { settings.artistDiversity = Number(ui.artists.value); changed(); });
    ui.genres.addEventListener('input', function () { settings.genreDiversity = Number(ui.genres.value); changed(); });
    el('padjSimilar').addEventListener('click', playSimilar);
    el('padjUndo').addEventListener('click', function () { if (player.__dj.back) player.__dj.back(); else player.prevTrack(); setTimeout(refresh, 100); });
    ui.history.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-index]');
      if (button) { player.loadIndex(Number(button.dataset.index)); setTimeout(refresh, 100); }
    });
    syncValues();
  }

  function syncValues() {
    if (!ui.mood) return;
    ui.artistsVal.textContent = settings.artistDiversity + '%';
    ui.genresVal.textContent = settings.genreDiversity + '%';
  }
  function changed() { settings = core.settingsOf(settings); save(); syncValues(); refresh(); }

  function refresh() {
    if (!ui.next || !player.__dj.context) return;
    const context = player.__dj.context();
    const choice = core.select(context, settings);
    if (choice) {
      ui.next.textContent = 'Następny: ' + trackLabel(choice.track);
      ui.reason.textContent = choice.reason;
    } else {
      ui.next.textContent = 'Dodaj więcej utworów, aby Auto-DJ miał wybór';
      ui.reason.textContent = '';
    }
    const history = (context.history || []).slice(-8).reverse();
    ui.historyCount.textContent = history.length ? '(' + history.length + ')' : '';
    ui.history.textContent = '';
    history.forEach(function (index) {
      const track = context.tracks[index];
      if (!track) return;
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.index = String(index); button.textContent = trackLabel(track);
      ui.history.appendChild(button);
    });
    if (!history.length) ui.history.textContent = 'Historia pojawi się po pierwszym automatycznym przejściu.';
  }

  function playSimilar() {
    const context = player.__dj.context();
    if (context.currentIndex < 0 || context.tracks.length < 2) { toast('Najpierw wybierz utwór i dodaj do biblioteki podobne pozycje'); return null; }
    const choice = core.select(context, settings, { similar: true });
    if (!choice) { toast('Nie ma kandydata do podobnego odtwarzania'); return null; }
    if (!player.__dj.on()) player.__dj.set(true);
    if (player.__dj.play) {
      lastChoice = choice;
      player.__dj.play(choice.index);
      if (ui.next) { ui.next.textContent = 'Wybrano: ' + trackLabel(choice.track); ui.reason.textContent = choice.reason; }
    } else {
      oneShotSimilar = true;
      player.nextTrack();
      setTimeout(function () { oneShotSimilar = false; }, 1000);
    }
    setTimeout(refresh, 120);
    return choice.index;
  }

  window.__pulsarDjSelector = function () {
    const similar = oneShotSimilar;
    oneShotSimilar = false;
    const choice = core.select(player.__dj.context(), settings, { similar: similar });
    lastChoice = choice;
    if (choice && ui.next) {
      ui.next.textContent = 'Wybrano: ' + trackLabel(choice.track);
      ui.reason.textContent = choice.reason;
    }
    return choice ? choice.index : null;
  };

  build();
  refresh();
  document.addEventListener('pulsar:state', scheduleRefresh);
  window.PulsarAutoDj = {
    settings: function () { return Object.assign({}, settings); },
    set: function (value) { settings = core.settingsOf(Object.assign({}, settings, value)); save(); build(); syncValues(); if (ui.mood) { ui.mood.value = settings.mood; ui.artists.value = settings.artistDiversity; ui.genres.value = settings.genreDiversity; } refresh(); },
    preview: function (similar) { return core.select(player.__dj.context(), settings, { similar: !!similar }); },
    playSimilar: playSimilar,
    refresh: refresh,
    lastChoice: function () { return lastChoice; }
  };
})();
