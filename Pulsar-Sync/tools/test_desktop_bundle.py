#!/usr/bin/env python3
"""Kontrola paczek desktopowych po wstrzyknięciu synchronizacji.

  python Pulsar-Sync/tools/test_desktop_bundle.py

Sprawdza oba archiwa resources.neu (Windows i Linux) bez uruchamiania aplikacji:
  * sumy SHA-256 wszystkich plików zgadzają się z nagłówkiem,
  * index.html wczytuje OBA pliki warstwy synchronizacji: adapter
    (cloud-sync.js) i silnik (drive-sync.js) — w tej kolejności, bo adapter
    rejestruje się przed startem silnika,
  * oba znaczniki występują dokładnie raz i stoją zaraz za desktop.js,
  * pliki w archiwum są bajt w bajt takie same jak źródła w Pulsar-Sync/,
  * reszta aplikacji (index.html, tags.js, ikony, neutralino.js, desktop.js)
    nadal jest w środku.
"""
from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

SYNC_DIR = Path(__file__).resolve().parents[1]
REPO = SYNC_DIR.parent
ENGINE = SYNC_DIR / "drive-sync.js"
ADAPTER = SYNC_DIR / "desktop-cloud-sync.js"

TARGETS = {
    "windows": REPO / "Pulsar-Windows" / "resources.neu",
    "linux": REPO / "Pulsar-Linux" / "resources.neu",
}

REQUIRED_FILES = [
    "neutralino.config.json",
    "resources/index.html",
    "resources/tags.js",
    "resources/neutralino.js",
    "resources/desktop.js",
    "resources/icons/appIcon.png",
    "resources/icons/trayIcon.png",
]

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    results.append((bool(ok), name, extra))


def read(archive: Path):
    raw = archive.read_bytes()
    outer, header_size, inner_size, json_size = struct.unpack("<4I", raw[:16])
    header = json.loads(raw[16:16 + json_size].decode("utf-8"))
    base = 8 + header_size
    files: dict[str, bytes] = {}
    integrity: dict[str, dict] = {}

    def walk(node, prefix=""):
        for name, entry in node.get("files", {}).items():
            rel = prefix + name
            if "files" in entry:
                walk(entry, rel + "/")
            else:
                offset = base + int(entry["offset"])
                files[rel] = raw[offset:offset + int(entry["size"])]
                integrity[rel] = entry.get("integrity", {})
    walk(header)
    return files, integrity


def audit(platform: str, archive: Path) -> None:
    if not archive.is_file():
        check(f"[{platform}] paczka istnieje", False, str(archive))
        return
    check(f"[{platform}] paczka istnieje", True, f"{archive.stat().st_size} B")
    files, integrity = read(archive)

    bad = [rel for rel, meta in integrity.items()
           if meta.get("hash") and hashlib.sha256(files[rel]).hexdigest() != meta["hash"]]
    check(f"[{platform}] sumy SHA-256", not bad, ", ".join(bad) or f"{len(files)} plików OK")

    missing = [rel for rel in REQUIRED_FILES if rel not in files]
    check(f"[{platform}] pliki aplikacji na miejscu", not missing, ", ".join(missing))

    html = files.get("resources/index.html", b"").decode("utf-8", "replace")
    adapter_tag = '<script src="cloud-sync.js"></script>'
    engine_tag = '<script src="drive-sync.js"></script>'
    check(f"[{platform}] index.html wczytuje oba pliki warstwy",
          html.count(adapter_tag) == 1 and html.count(engine_tag) == 1,
          f"adapter={html.count(adapter_tag)}x silnik={html.count(engine_tag)}x")
    check(f"[{platform}] adapter ładowany przed silnikiem",
          html.find(adapter_tag) < html.find(engine_tag),
          f"adapter@{html.find(adapter_tag)} silnik@{html.find(engine_tag)}")

    desktop_tag = '<script src="desktop.js"></script>'
    anchor = html.find(desktop_tag)
    expected = "\n  " + adapter_tag + "\n  " + engine_tag + "\n"
    block = html[anchor + len(desktop_tag):anchor + len(desktop_tag) + len(expected)]
    check(f"[{platform}] para znaczników stoi zaraz za desktop.js",
          anchor > -1 and block == expected,
          block.replace("\n", " \u23ce ")[:120])

    # Poprawki runtime'u: bez nich synchronizacja nie zna klucza (netId) ani
    # nie wie, kiedy się uruchomić.
    runtime_needs = {
        "zapis klucza netId (utwór)": "netId: track.netId",
        "zapis klucza netId (odczyt)": "netId: item.netId",
        "zdarzenie zmiany biblioteki": "CustomEvent('pulsar:library', { detail: { reason: 'track' } })",
        "zdarzenie skasowania": "reason: 'delete'",
        "zdarzenie zmiany albumu": "reason: 'album'",
        "hook scalania (snapshot)": "window.__pulsarSyncSnapshot",
        "hook scalania (apply)": "window.__pulsarSyncApply",
    }
    for label, needle in runtime_needs.items():
        check(f"[{platform}] runtime: {label}", html.count(needle) == 1, f"{html.count(needle)}x")

    host_tail = "x.srcPath = path; persistTrack(x); return true;"
    check(f"[{platform}] hooki scalania są w runtime (po API hosta)",
          host_tail in html and html.find(host_tail) < html.find("window.__pulsarSyncSnapshot"),
          f"host@{html.find(host_tail)} hook@{html.find('window.__pulsarSyncSnapshot')}")

    # Panel chmury jest wstawiany w locie do ustawień aplikacji. Jeśli zamknięty
    # UI zgubi te zaczepy, panel przestanie się w ogóle pojawiać — dlatego
    # pilnujemy ich obecności.
    footholds = {
        'menu ustawień': 'id="settingsMenu"',
        'treść ustawień': 'id="smBody"',
        'wyszukiwarka ustawień': 'id="smSearch"',
        'pasek zakładek': 'sm-nav',
        'zakładka': 'sm-tab',
        'strona ustawień': 'sm-pane',
    }
    absent = [label for label, needle in footholds.items() if needle not in html]
    check(f"[{platform}] panel chmury ma zaczepy w ustawieniach", not absent,
          ", ".join(absent) or f"{len(footholds)} zaczepów OK")

    # Przycisk „Pobierz tutaj" woła API sieciowe runtime'u. Jeśli zamknięta
    # aplikacja przestanie je wystawiać, przycisk przestanie działać — dlatego
    # sprawdzamy zaczepy, a nie tylko obecność naszego kodu.
    net_api = {
        'API sieciowe (__player.__net)': '__net: {',
        'import utworu (importIdx)': 'importIdx: (i) => netImport(i, null)',
        'klucz netId po imporcie': "netId: r.provider + ':' + r.id",
        'rozpoznanie linku YouTube': 'function ytIdFromText(t)',
    }
    net_missing = [label for label, needle in net_api.items() if needle not in html]
    check(f"[{platform}] runtime wystawia API potrzebne do pobrania utworu", not net_missing,
          ", ".join(net_missing) or f"{len(net_api)} zaczepów OK")

    check(f"[{platform}] silnik w archiwum = źródło",
          files.get("resources/drive-sync.js") == ENGINE.read_bytes(),
          f"{ENGINE.stat().st_size} B")
    # Sam znacznik hooków nie wystarcza: paczki (i zbudowany z nich projekt
    # Androida) muszą nieść dokładnie tę wersję, która leży w repozytorium.
    hooks_source = (SYNC_DIR / "cloud_sync_hooks.js").read_text(encoding="utf-8").strip()
    hooks_start = html.find("/* ---- Cloud sync hooks")
    hooks_end = html.find("/* ---- end cloud sync hooks ---- */", hooks_start)
    hooks_block = (html[hooks_start:hooks_end + len("/* ---- end cloud sync hooks ---- */")].strip()
                   if hooks_start > -1 and hooks_end > -1 else "")
    check(f"[{platform}] hooki scalania w archiwum = źródło",
          hooks_block == hooks_source,
          f"{len(hooks_block)} B vs {len(hooks_source)} B")

    check(f"[{platform}] adapter w archiwum = źródło",
          files.get("resources/cloud-sync.js") == ADAPTER.read_bytes(),
          f"{ADAPTER.stat().st_size} B")


def main() -> int:
    for platform, archive in sorted(TARGETS.items()):
        audit(platform, archive)
    for ok, name, extra in results:
        print(("PASS  " if ok else "FAIL  ") + name + (f"   [{extra}]" if extra else ""))
    failed = [row for row in results if not row[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
