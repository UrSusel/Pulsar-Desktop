#!/usr/bin/env python3
"""Kontrola zasobów i zaczepów edytora w gotowych resources.neu."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

EDITOR_DIR = Path(__file__).resolve().parents[1]
REPO = EDITOR_DIR.parent
sys.path.insert(0, str(REPO / "Pulsar-Editor" / "tools"))
sys.path.insert(0, str(REPO / "Pulsar-Sync" / "tools"))
import neu  # noqa: E402
from build_desktop_editor import APP_VERSION, ASSETS, CONFIG, INDEX, PLATFORMS, expected_config, expected_index, extras_runtime_patched, run  # noqa: E402
from runtime_patches import editor_runtime_patched  # noqa: E402

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    results.append((bool(ok), name, extra))


def audit(platform: str, archive: Path) -> None:
    if not archive.is_file():
        check(f"[{platform}] resources.neu istnieje", False)
        return
    raw, header, base = neu.read_archive(str(archive))
    files = {rel: neu.file_bytes(raw, base, entry) for rel, entry in neu.iter_files(header)}
    integrity = {rel: entry for rel, entry in neu.iter_files(header)}
    bad = [rel for rel, entry in integrity.items() if neu.check(entry, files[rel]) is False]
    check(f"[{platform}] integralność całego archiwum", not bad, ", ".join(bad) or f"{len(files)} plików")

    for rel, source in ASSETS.items():
        check(f"[{platform}] {Path(rel).name} = źródło", files.get(rel) == source.read_bytes(), f"{source.stat().st_size} B")
    html = files.get(INDEX, b"").decode("utf-8", "replace")
    check(f"[{platform}] runtime ma wszystkie zaczepy", editor_runtime_patched(html) and extras_runtime_patched(html))
    check(f"[{platform}] index jest wynikiem powtarzalnego builda", files.get(INDEX) == expected_index(files.get(INDEX, b"")))
    check(f"[{platform}] config jest wynikiem powtarzalnego builda", files.get(CONFIG) == expected_config(files.get(CONFIG, b"{}")))
    config = json.loads(files.get(CONFIG, b"{}"))
    manifest = json.loads(files.get("resources/app-version.json", b"{}"))
    check(f"[{platform}] wersja {APP_VERSION} jest spójna w configu i manifeście",
          config.get("version") == APP_VERSION and manifest.get("version") == APP_VERSION)
    check(f"[{platform}] tytuł okna pokazuje Build {APP_VERSION}",
          config.get("modes", {}).get("window", {}).get("title") == f"Pulsar — Build {APP_VERSION}")

    css = '<link rel="stylesheet" href="audio-editor.css">'
    core = '<script src="editor-core.js"></script>'
    ui = '<script src="audio-editor.js"></script>'
    check(f"[{platform}] CSS i skrypty występują raz", html.count(css) == 1 and html.count(core) == 1 and html.count(ui) == 1)
    updater = '<script src="app-updates.js"></script>'
    check(f"[{platform}] aktualizator aplikacji jest dołączony raz", html.count(updater) == 1)
    check(f"[{platform}] logika ładuje się przed interfejsem", 0 < html.find(core) < html.find(ui))
    check(f"[{platform}] interfejs startuje po głównym runtime", html.find("applyLang();\n})();\n</script>") < html.find(core))
    check(f"[{platform}] istniejące API testowe pozostaje dostępne", "window.__pulsarTest" in html and "window.__pulsarHost" in html)
    check(f"[{platform}] import napisów nie zajmuje już miejsca w pasku odtwarzacza",
          'id="lyricsImportBtn"' not in html and 'id="lyricsImportInput"' not in html)
    editor_js = files.get("resources/audio-editor.js", b"").decode("utf-8", "replace")
    check(f"[{platform}] edytor ma osobną zakładkę importu i panel plików",
          'data-tab="import"' in editor_js and 'id="paeImportPane"' in editor_js and 'id="paeLyricsFile"' in editor_js)
    check(f"[{platform}] runtime zapisuje i przywraca import per utwór",
          "importTextFor:" in html and "restoreImportedFor:" in html and "saveImportedLyricsFor" in html)


def source_build_audit(platform: str, archive: Path) -> None:
    """Pełne, czytelne źródła muszą odtworzyć dostarczaną paczkę co do bajtu."""
    with tempfile.TemporaryDirectory(prefix=f"pulsar-source-audit-{platform}-") as tmp:
        rebuilt = Path(tmp) / "resources.neu"
        ok = run(platform, rebuilt, False, True)
        check(f"[{platform}] pełny build z Pulsar-Core odtwarza resources.neu",
              ok and archive.is_file() and rebuilt.is_file() and rebuilt.read_bytes() == archive.read_bytes(),
              f"{rebuilt.stat().st_size if rebuilt.is_file() else 0} B")


def main() -> int:
    for platform, archive in sorted(PLATFORMS.items()):
        audit(platform, archive)
        source_build_audit(platform, archive)
    for ok, name, extra in results:
        print(("PASS  " if ok else "FAIL  ") + name + (f"   [{extra}]" if extra else ""))
    failed = [row for row in results if not row[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} kontroli paczek edytora zaliczonych")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
