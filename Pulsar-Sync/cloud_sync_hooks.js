/* ---- Cloud sync hooks (Android only, injected by tools/build_web_assets.py) ----
 *
 * These two functions live inside the app runtime closure, because only the
 * runtime can see the in-memory library: the cross-device key comes from
 * `netId` (e.g. "youtube:VIDEOID"), which is not part of every persisted
 * record, and applying a merged library has to touch the live arrays so the UI
 * and the play queue stay consistent without a reload (a reload would drop the
 * currently playing file).
 *
 * Nothing here uploads or downloads audio: only metadata is exposed.
 */

/**
 * Identyfikator filmu YouTube. Rekord zapisany przed poprawką zachowującą
 * `netId` nie ma go już wcale, ale zwykle zostaje `netLink` (adres, z którego
 * utwór pobrano) — dzięki temu stara piosenka z telefonu znów ma wspólny
 * klucz z innymi urządzeniami i da się ją pobrać po drugiej stronie.
 */
function pulsarCloudYoutubeId(track) {
  if (!track) return '';
  const netId = String(track.netId || '');
  if (netId) return netId.indexOf('youtube:') === 0 ? netId.slice(8) : '';
  const link = String(track.netLink || track.link || track.url || track.src || '');
  if (!/youtu\.?be|youtube\.com/i.test(link)) return '';
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{6,20})/,
    /youtu\.be\/([A-Za-z0-9_-]{6,20})/,
    /youtube\.com\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})/
  ];
  for (let i = 0; i < patterns.length; i++) {
    const found = patterns[i].exec(link);
    if (found) return found[1];
  }
  return '';
}

function pulsarCloudTrackKey(track) {
  if (!track) return '';
  const netId = track.netId || '';
  if (netId) return String(netId);
  const videoId = pulsarCloudYoutubeId(track);
  if (videoId) return 'youtube:' + videoId;
  const size = track.file ? (track.file.size || 0) : 0;
  const name = track.file ? (track.file.name || '') : '';
  if (!name && !size) return '';
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const text = String(name).toLowerCase();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c * (i + 1)) ^ (h2 >>> 13)) >>> 0;
  }
  return 'fp:' + size + ':' + (h1.toString(16) + h2.toString(16)).slice(0, 16);
}

function pulsarCloudAlbumKey(album) {
  if (!album) return '';
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const text = String(album.name || '').toLowerCase();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c * (i + 1)) ^ (h2 >>> 13)) >>> 0;
  }
  return 'al:' + (h1.toString(16) + h2.toString(16)).slice(0, 16);
}

/** Metadane biblioteki do wysłania: bez plików, bez okładek, bez ścieżek lokalnych. */
window.__pulsarSyncSnapshot = function () {
  const trackList = tracks.map(function (track) {
    return {
      key: pulsarCloudTrackKey(track),
      title: track.title || '',
      artist: track.artist || '',
      album: track.album || '',
      year: track.year || '',
      provider: track.netId ? String(track.netId).split(':')[0] : (pulsarCloudYoutubeId(track) ? 'youtube' : ''),
      ytId: pulsarCloudYoutubeId(track),
      durMs: Math.round(Number(track.durMs || 0) || 0),
      fav: !!track.fav,
      plays: Number(track.plays || 0) || 0,
      lastPlay: Number(track.lastPlay || 0) || 0
    };
  }).filter(function (entry) { return !!entry.key; });

  const keysById = new Map();
  tracks.forEach(function (track) {
    const key = pulsarCloudTrackKey(track);
    if (key) keysById.set(track.id, key);
  });

  const albumList = albums.map(function (album) {
    const trackKeys = [];
    (album.trackIds || []).forEach(function (id) {
      const key = keysById.get(id);
      if (key) trackKeys.push(key);
    });
    return {
      key: pulsarCloudAlbumKey(album),
      name: album.name || '',
      artist: album.artist || '',
      // Okładka albumu to lokalny blob — świadomie nie wchodzi do synchronizacji.
      cover: '',
      customCover: !!album.customCover,
      createdAt: Number(album.createdAt || 0) || 0,
      trackKeys: trackKeys
    };
  }).filter(function (entry) { return !!entry.key; });

  return { tracks: trackList, albums: albumList };
};

/**
 * Zastosowuje scalony plan w żywej bibliotece.
 * Zwraca { tracks, albums } — liczbę faktycznie zmienionych pozycji.
 */
window.__pulsarSyncApply = async function (plan) {
  const result = { tracks: 0, albums: 0 };
  if (!plan) return result;

  const byKey = new Map();
  tracks.forEach(function (track) {
    const key = pulsarCloudTrackKey(track);
    if (key && !byKey.has(key)) byKey.set(key, track);
  });

  (plan.trackUpdates || []).forEach(function (update) {
    const track = byKey.get(update.key);
    if (!track || !update.fields) return;
    Object.keys(update.fields).forEach(function (field) {
      track[field] = update.fields[field];
    });
    try { persistTrack(track); } catch (e) {}
    result.tracks++;
  });

  const localKeysToIds = function (keys) {
    const ids = [];
    (keys || []).forEach(function (key) {
      const track = byKey.get(key);
      if (track && ids.indexOf(track.id) === -1) ids.push(track.id);
    });
    return ids;
  };

  const albumByKey = new Map();
  albums.forEach(function (album) {
    const key = pulsarCloudAlbumKey(album);
    if (key && !albumByKey.has(key)) albumByKey.set(key, album);
  });

  for (const update of (plan.albumUpdates || [])) {
    const album = albumByKey.get(update.key);
    if (!album) continue;
    const ids = localKeysToIds(update.trackKeys);
    const before = (album.trackIds || []).join(',');
    if (before === ids.join(',')) continue;
    album.trackIds = ids;
    try { await persistAlbum(album); } catch (e) {}
    if (typeof activeAlbumId !== 'undefined' && activeAlbumId === album.id && typeof rebuildQueue === 'function') {
      try { rebuildQueue(); } catch (e) {}
    }
    result.albums++;
  }

  for (const incoming of (plan.newAlbums || [])) {
    const ids = localKeysToIds(incoming.trackKeys);
    if (!ids.length) continue; // album złożony w całości z utworów, których tu nie ma
    let coverBlob = null;
    try { if (typeof buildAlbumCover === 'function') coverBlob = await buildAlbumCover(ids); } catch (e) {}
    const album = {
      id: makeId(),
      name: incoming.name || 'Album',
      trackIds: ids,
      customCover: false,
      coverBlob: coverBlob,
      createdAt: Number(incoming.createdAt || 0) || Date.now()
    };
    albums.push(album);
    try { await persistAlbum(album); } catch (e) {}
    result.albums++;
  }

  if (result.tracks || result.albums) {
    try { renderLibrary(); } catch (e) {}
    try { if (typeof renderAlbumDetail === 'function') renderAlbumDetail(); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('pulsar:state', { detail: { reason: 'cloud-sync' } })); } catch (e) {}
  }
  return result;
};
/* ---- end cloud sync hooks ---- */
