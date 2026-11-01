/* Pulsar Auto-DJ — czysta logika doboru, wspólna dla UI i testów. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulsarDjCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = { mood: 'balance', artistDiversity: 65, genreDiversity: 45 };
  const MOODS = {
    balance: 'Zbalansowany', calm: 'Spokojnie', focus: 'Skupienie',
    workout: 'Trening', party: 'Impreza', discovery: 'Odkrywanie', similar: 'Więcej podobnych'
  };
  function number(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function norm(value) { return String(value || '').trim().toLocaleLowerCase(); }
  function settingsOf(value) {
    const input = value || {};
    return {
      mood: Object.prototype.hasOwnProperty.call(MOODS, input.mood) && input.mood !== 'similar' ? input.mood : DEFAULTS.mood,
      artistDiversity: clamp(number(input.artistDiversity, DEFAULTS.artistDiversity), 0, 100),
      genreDiversity: clamp(number(input.genreDiversity, DEFAULTS.genreDiversity), 0, 100)
    };
  }
  function genreOf(track) { return norm(track && (track.genre || track.album)); }
  function energyOf(track) { return clamp(number(track && track.rms, 0) * 4, 0, 1); }
  function tempoDistance(a, b) {
    a = number(a, 0); b = number(b, 0);
    if (a <= 0 || b <= 0) return -1;
    return Math.min(Math.abs(a - b), Math.abs(a * 2 - b), Math.abs(a - b * 2));
  }

  function select(context, value, options) {
    const ctx = context || {};
    const settings = settingsOf(value);
    const opts = options || {};
    const mood = opts.similar ? 'similar' : settings.mood;
    const tracks = Array.isArray(ctx.tracks) ? ctx.tracks : [];
    const queue = new Set(Array.isArray(ctx.queue) ? ctx.queue : tracks.map(function (_, index) { return index; }));
    const current = tracks[ctx.currentIndex] || {};
    const recent = Array.isArray(ctx.recent) ? ctx.recent : [];
    let candidates = tracks.filter(function (track) { return track && queue.has(track.index) && track.index !== ctx.currentIndex; });
    if (candidates.length < 2) candidates = tracks.filter(function (track) { return track && track.index !== ctx.currentIndex; });
    if (!candidates.length) return null;

    if (settings.artistDiversity >= 90 && norm(current.artist)) {
      const varied = candidates.filter(function (track) { return norm(track.artist) !== norm(current.artist); });
      if (varied.length) candidates = varied;
    }
    if (settings.genreDiversity >= 90 && genreOf(current)) {
      const varied = candidates.filter(function (track) { return genreOf(track) !== genreOf(current); });
      if (varied.length) candidates = varied;
    }

    const currentEnergy = energyOf(current);
    const targetEnergy = { calm: 0.2, focus: 0.16, workout: 0.78, party: 0.82, discovery: 0.45, similar: currentEnergy, balance: currentEnergy }[mood];
    const recentSet = recent.slice(-6).map(function (index) { return tracks[index]; }).filter(Boolean);
    let best = null;
    candidates.forEach(function (track) {
      const bpmDistance = tempoDistance(current.bpm, track.bpm);
      const energy = energyOf(track);
      const sameArtist = !!norm(current.artist) && norm(current.artist) === norm(track.artist);
      const sameGenre = !!genreOf(current) && genreOf(current) === genreOf(track);
      const recentPos = recent.lastIndexOf(track.index);
      const recency = recentPos < 0 ? 0 : (recentPos + 1) / recent.length;
      let score = 100;
      score -= recency * (mood === 'discovery' ? 34 : 24);
      score -= Math.abs(energy - targetEnergy) * (mood === 'similar' ? 50 : 34);
      if (bpmDistance >= 0) score -= Math.min(80, bpmDistance) * (mood === 'similar' ? 2.5 : mood === 'workout' ? 0.35 : 1.15);
      else score -= 2; // brak analizy BPM nie dyskwalifikuje utworu

      if (mood === 'calm' || mood === 'focus') {
        if (track.bpm > 125) score -= Math.min(35, (track.bpm - 125) * 0.5);
        if (energy > 0.55) score -= (energy - 0.55) * 35;
      } else if (mood === 'workout' || mood === 'party') {
        if (track.bpm > 0 && track.bpm < 95) score -= (95 - track.bpm) * 0.35;
        score += energy * 12;
        if (mood === 'workout') { score += energy * 25; if (track.bpm >= 120) score += 10; }
        if (mood === 'party' && track.fav) score += 8;
      } else if (mood === 'discovery') {
        if (!track.plays) score += 20;
        else score -= Math.min(12, Math.log2(track.plays + 1) * 3);
        if (!track.lastPlay) score += 6;
      } else if (mood === 'similar') {
        if (sameArtist) score += 24;
        if (sameGenre) score += 20;
        score -= Math.abs(energy - currentEnergy) * 25;
      }
      if (track.fav && mood !== 'discovery') score += 3;
      if (sameArtist) score -= settings.artistDiversity * (mood === 'similar' ? 0.04 : 0.24);
      if (sameGenre) score -= settings.genreDiversity * (mood === 'similar' ? 0.03 : 0.18);
      recentSet.forEach(function (old) {
        if (norm(old.artist) && norm(old.artist) === norm(track.artist)) score -= settings.artistDiversity * 0.035;
        if (genreOf(old) && genreOf(old) === genreOf(track)) score -= settings.genreDiversity * 0.025;
      });

      const reasons = [MOODS[mood]];
      if (track.bpm > 0) {
        reasons.push(Math.round(track.bpm) + ' BPM');
        if (bpmDistance >= 0 && bpmDistance <= 8) reasons.push('zbliżone tempo');
      }
      if (mood === 'workout' || mood === 'party') reasons.push('odpowiednia energia');
      else if (mood === 'calm' || mood === 'focus') reasons.push('spokojniejsze brzmienie');
      else if (mood === 'discovery' && !track.plays) reasons.push('jeszcze nieodtwarzany');
      else if (mood === 'similar' && sameArtist) reasons.push('ten sam wykonawca');
      else if (mood === 'similar' && sameGenre) reasons.push('podobny gatunek/album');
      if (!sameArtist && norm(current.artist) && settings.artistDiversity >= 60) reasons.push('inny wykonawca');
      if (!sameGenre && genreOf(current) && settings.genreDiversity >= 60) reasons.push('inny gatunek/album');
      const result = { index: track.index, score: score, reason: reasons.slice(0, 4).join(' · '), track: track, mood: mood };
      if (!best || result.score > best.score || (result.score === best.score && result.index < best.index)) best = result;
    });
    return best;
  }

  return { DEFAULTS: DEFAULTS, MOODS: MOODS, settingsOf: settingsOf, select: select, tempoDistance: tempoDistance };
});
