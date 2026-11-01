/* Pulsar — czysta logika harmonogramu, nazw i rotacji kopii. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulsarBackupCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PREFIX = 'Pulsar-auto-';
  const DEFAULTS = { enabled: true, safety: true, intervalDays: 7, keep: 3, folder: '', lastRun: 0, lastPath: '' };
  function number(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function settingsOf(value) {
    const input = value || {};
    return {
      enabled: input.enabled !== false,
      safety: input.safety !== false,
      intervalDays: Math.max(1, Math.min(30, Math.round(number(input.intervalDays, 7)))),
      keep: Math.max(1, Math.min(10, Math.round(number(input.keep, 3)))),
      folder: String(input.folder || ''),
      lastRun: Math.max(0, number(input.lastRun, 0)),
      lastPath: String(input.lastPath || '')
    };
  }
  function due(value, now) {
    const settings = settingsOf(value);
    if (!settings.enabled) return false;
    const time = number(now, Date.now());
    return !settings.lastRun || time - settings.lastRun >= settings.intervalDays * 86400000;
  }
  function pad(value) { return String(value).padStart(2, '0'); }
  function backupName(date, reason) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const suffix = String(reason || 'auto').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'auto';
    return PREFIX + stamp + '-' + suffix + '.pulsarlib';
  }
  function isBackupName(name) { return String(name || '').startsWith(PREFIX) && /\.pulsarlib$/i.test(String(name || '')); }
  function rotationTargets(names, keep) {
    return (Array.isArray(names) ? names : []).filter(isBackupName).sort().reverse().slice(Math.max(1, Math.min(10, Number(keep) || 3)));
  }
  function isLargeChange(count, total) {
    count = Math.max(0, Number(count) || 0); total = Math.max(0, Number(total) || 0);
    return count >= 10 || (total >= 8 && count / total >= 0.25);
  }
  return { PREFIX: PREFIX, DEFAULTS: DEFAULTS, settingsOf: settingsOf, due: due, backupName: backupName, isBackupName: isBackupName, rotationTargets: rotationTargets, isLargeChange: isLargeChange };
});
