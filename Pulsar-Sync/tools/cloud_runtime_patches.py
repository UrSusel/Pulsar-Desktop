#!/usr/bin/env python3
"""Wspólne poprawki runtime'u potrzebne synchronizacji — Android i desktop.

Aplikacja trzyma bibliotekę w pamięci i w IndexedDB, ale bez tych poprawek
synchronizacja nie ma czego wysłać:

  * `netId` (np. "youtube:VIDEOID") i metadane albumu/roku nie są zapisywane do
    IndexedDB, więc po restarcie ginie klucz, po którym urządzenia się kojarzą,
  * zmiany w bibliotece nie są nigdzie ogłaszane, więc synchronizacja nie wie,
    kiedy ma się uruchomić,
  * scalanie z chmury potrzebuje funkcji działających w żywym runtime'cie
    (widzą `tracks`/`albums`), żeby nie przeładowywać strony i nie ucinać
    grającego utworu.

Ten sam kod trafia więc i do Androida (przez tools/build_web_assets.py), i do
paczek Windows/Linux (przez Pulsar-Sync/tools/build_desktop_sync.py).
"""
from __future__ import annotations

from pathlib import Path

HOOKS = Path(__file__).resolve().parents[1] / "cloud_sync_hooks.js"
# Poprawki zostawiają ten znacznik; po nim wiadomo, że są już w środku.
MARKER = "window.__pulsarSyncSnapshot"
# Blok hooków jest oznaczony z obu stron, żeby dało się go wymienić na nowszy.
HOOKS_START = "/* ---- Cloud sync hooks"
HOOKS_END = "/* ---- end cloud sync hooks ---- */"


def cloud_runtime_patched(html: str) -> bool:
    """Czy ten index.html ma już poprawki runtime'u."""
    return MARKER in html


def _hooks_block(html: str) -> str:
    """Wstrzyknięty blok hooków (albo pusty łańcuch, gdy go nie ma)."""
    start = html.find(HOOKS_START)
    if start == -1:
        return ""
    end = html.find(HOOKS_END, start)
    if end == -1:
        return ""
    return html[start:end + len(HOOKS_END)].strip()


def cloud_hooks_current(html: str) -> bool:
    """Czy paczka niesie dokładnie tę wersję hooków, która leży w repozytorium."""
    return _hooks_block(html) == HOOKS.read_text(encoding="utf-8").strip()


def refresh_cloud_hooks(html: str) -> tuple[str, bool]:
    """Podmienia wstrzyknięty blok hooków na aktualny.

    Sam znacznik nie wystarcza za bramkę: hooki zmieniają się znacznie częściej
    niż reszta poprawek, a poprzednie wersje paczek (i zbudowany z nich projekt
    Androida) zostawiały w środku starszy blok — czyli nowy kod nigdy nie
    docierał do aplikacji, choć build meldował „już poprawiony”.
    """
    current = _hooks_block(html)
    if not current:
        return html, False
    source = HOOKS.read_text(encoding="utf-8").strip()
    if current == source:
        return html, False
    return html.replace(current, source, 1), True


def apply_cloud_runtime_patches(html: str) -> str:
    """Zwraca index.html z wstrzykniętą obsługą synchronizacji.

    Wywołanie na pliku, który już ma poprawki, nic nie zmienia — dzięki temu
    ten sam kod może czytać zarówno oryginalną, jak i spatchowaną paczkę
    (np. build Androida czyta Pulsar-Linux/resources.neu).
    """
    if cloud_runtime_patched(html):
        # Reszta poprawek jest już w środku — ale hooki wymieniamy zawsze, gdy
        # w repozytorium jest nowsza wersja (patrz refresh_cloud_hooks).
        refreshed, _changed = refresh_cloud_hooks(html)
        return refreshed
    # --- Cloud sync -----------------------------------------
    # The runtime keeps network metadata (netId, album, year) in memory only, so
    # a restart loses the YouTube identifier. Cloud sync needs that identifier
    # as the cross-device key, and remembering album/year is a fix in itself.
    sync_replacements = [
        (
            "      await dbPut('tracks', {\n"
            "        id: track.id, name: track.file.name, type: track.file.type, folder: track.folder,\n"
            "        title: track.title, artist: track.artist, blob: track.file, coverBlob: track.coverBlob || null,\n"
            "        fav: !!track.fav, plays: track.plays || 0, lastPlay: track.lastPlay || 0,\n"
            "        srcPath: track.srcPath || '' // \u015bcie\u017cka orygina\u0142u na dysku (obserwowany folder) \u2014 edytor tag\u00f3w mo\u017ce go zaktualizowa\u0107\n"
            "      });",
            "      await dbPut('tracks', {\n"
            "        id: track.id, name: track.file.name, type: track.file.type, folder: track.folder,\n"
            "        title: track.title, artist: track.artist, blob: track.file, coverBlob: track.coverBlob || null,\n"
            "        fav: !!track.fav, plays: track.plays || 0, lastPlay: track.lastPlay || 0,\n"
            "        srcPath: track.srcPath || '', // \u015bcie\u017cka orygina\u0142u na dysku \u2014 edytor tag\u00f3w mo\u017ce go zaktualizowa\u0107\n"
            "        // Android: to\u017csamo\u015b\u0107 sieciowa i metadane, kt\u00f3rych synchronizacja u\u017cywa jako klucza\n"
            "        netId: track.netId || '', album: track.album || '', year: track.year || '',\n"
            "        netLink: track.netLink || '', durMs: Math.round(Number(track.durMs || 0) || 0)\n"
            "      });\n"
            "      document.dispatchEvent(new CustomEvent('pulsar:library', { detail: { reason: 'track' } }));",
        ),
        (
            "      tracks = storedTracks.map(item => ({\n"
            "        id: item.id, file: new File([item.blob], item.name, { type: item.type || 'audio/mpeg' }),\n"
            "        folder: item.folder || '', title: item.title, artist: item.artist,\n"
            "        matchedImg: null, coverBlob: item.coverBlob || null, coverUrl: null, resolved: true,\n"
            "        fav: !!item.fav, plays: item.plays || 0, lastPlay: item.lastPlay || 0, srcPath: item.srcPath || ''\n"
            "      }));",
            "      tracks = storedTracks.map(item => ({\n"
            "        id: item.id, file: new File([item.blob], item.name, { type: item.type || 'audio/mpeg' }),\n"
            "        folder: item.folder || '', title: item.title, artist: item.artist,\n"
            "        matchedImg: null, coverBlob: item.coverBlob || null, coverUrl: null, resolved: true,\n"
            "        fav: !!item.fav, plays: item.plays || 0, lastPlay: item.lastPlay || 0, srcPath: item.srcPath || '',\n"
            "        netId: item.netId || '', album: item.album || '', year: item.year || '',\n"
            "        netLink: item.netLink || '', durMs: Math.round(Number(item.durMs || 0) || 0)\n"
            "      }));",
        ),
        (
            "  async function persistAlbum(album){\n"
            "    try { await dbPut('playlists', album); } catch(e) { console.warn('Nie mo\u017cna zapisa\u0107 albumu.', e); }\n"
            "  }",
            "  async function persistAlbum(album){\n"
            "    try {\n"
            "      await dbPut('playlists', album);\n"
            "      document.dispatchEvent(new CustomEvent('pulsar:library', { detail: { reason: 'album' } }));\n"
            "    } catch(e) { console.warn('Nie mo\u017cna zapisa\u0107 albumu.', e); }\n"
            "  }",
        ),
    ]
    for old, new in sync_replacements:
        if html.count(old) != 1:
            raise ValueError(f"expected exactly one cloud-sync source fragment: {old[:80]!r}")
        html = html.replace(old, new, 1)

    # Deletions must notify the sync layer too, otherwise a track removed here
    # would be uploaded again from the previous manifest.
    delete_anchor = (
        "  async function dbDelete(storeName, id){\n"
        "    const db = await openDatabase();\n"
        "    return new Promise((resolve, reject) => {\n"
        "      const request = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);\n"
        "      request.onsuccess = resolve;"
    )
    delete_android = delete_anchor.replace(
        "      request.onsuccess = resolve;",
        "      request.onsuccess = () => { resolve();"
        " document.dispatchEvent(new CustomEvent('pulsar:library', { detail: { reason: 'delete' } })); };",
    )
    if html.count(delete_anchor) != 1:
        raise ValueError("expected exactly one library delete source fragment")
    html = html.replace(delete_anchor, delete_android, 1)

    # Snapshot/apply hooks for drive-sync.js. They have to live inside the
    # runtime: only it sees the in-memory library (with netId) and only it may
    # touch the live arrays, so merging never needs a page reload that would
    # drop the currently playing file.
    hooks_source = HOOKS.read_text(encoding="utf-8")
    if "window.__pulsarSyncSnapshot" not in hooks_source or "window.__pulsarSyncApply" not in hooks_source:
        raise ValueError("cloud sync hooks file does not define the expected entry points")
    host_tail = (
        "      x.srcPath = path; persistTrack(x); return true;\n"
        "    }\n"
        "  };\n"
    )
    if html.count(host_tail) != 1:
        raise ValueError("could not find the host API tail to attach the cloud sync hooks")
    html = html.replace(host_tail, host_tail + "\n" + hooks_source + "\n", 1)
    return html
