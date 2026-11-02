#!/usr/bin/env python3
"""Wbudowuje edytor audio/napisów w paczki Pulsara Windows i Linux.

  python Pulsar-Editor/tools/build_desktop_editor.py
  python Pulsar-Editor/tools/build_desktop_editor.py --check
  python Pulsar-Editor/tools/build_desktop_editor.py --platform windows
  python Pulsar-Editor/tools/build_desktop_editor.py --from-source

Tryb --from-source używa czytelnych źródeł Pulsar-Core zamiast istniejącego
archiwum i wykonuje pełny build rdzenia, synchronizacji, edytora i rozszerzeń.
Skrypt współpracuje z warstwą Pulsar-Sync: zmienia tylko zaczepy rozszerzeń,
dodaje własne zasoby edytora/Auto-DJ/kopii i przelicza integralność resources.neu.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

EDITOR_DIR = Path(__file__).resolve().parents[1]
REPO = EDITOR_DIR.parent
EXTRAS_DIR = REPO / "Pulsar-Extras"
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(REPO / "Pulsar-Sync" / "tools"))
from runtime_patches import apply_editor_runtime_patches, editor_runtime_patched  # noqa: E402
_EXTRAS_SPEC = importlib.util.spec_from_file_location("pulsar_extras_runtime_patches", EXTRAS_DIR / "tools" / "runtime_patches.py")
_EXTRAS_PATCHES = importlib.util.module_from_spec(_EXTRAS_SPEC)
assert _EXTRAS_SPEC and _EXTRAS_SPEC.loader
_EXTRAS_SPEC.loader.exec_module(_EXTRAS_PATCHES)
apply_extras_runtime_patches = _EXTRAS_PATCHES.apply_extras_runtime_patches
extras_runtime_patched = _EXTRAS_PATCHES.extras_runtime_patched
import neu  # noqa: E402
from cloud_runtime_patches import apply_cloud_runtime_patches  # noqa: E402
from build_desktop_sync import patch_index as patch_sync_asset_tags  # noqa: E402

INDEX = "resources/index.html"
CONFIG = "neutralino.config.json"
VERSION_MANIFEST = EXTRAS_DIR / "app-version.json"
APP_VERSION = json.loads(VERSION_MANIFEST.read_text(encoding="utf-8"))["version"]
SYNC_ASSETS = {
    "resources/cloud-sync.js": REPO / "Pulsar-Sync" / "desktop-cloud-sync.js",
    "resources/drive-sync.js": REPO / "Pulsar-Sync" / "drive-sync.js",
}
ASSETS = {
    **SYNC_ASSETS,
    "resources/i18n.js": EXTRAS_DIR / "i18n.js",
    "resources/app-version.json": VERSION_MANIFEST,
    "resources/app-updates.js": EXTRAS_DIR / "app-updates.js",
    "resources/editor-core.js": EDITOR_DIR / "editor-core.js",
    "resources/audio-editor.js": EDITOR_DIR / "audio-editor.js",
    "resources/audio-editor.css": EDITOR_DIR / "audio-editor.css",
    "resources/dj-core.js": EXTRAS_DIR / "dj-core.js",
    "resources/backup-core.js": EXTRAS_DIR / "backup-core.js",
    "resources/desktop-bridge.js": EXTRAS_DIR / "desktop-bridge.js",
    "resources/lyrics-aligner.py": EDITOR_DIR / "lyrics-aligner.py",
    "resources/auto-dj.js": EXTRAS_DIR / "auto-dj.js",
    "resources/library-backup.js": EXTRAS_DIR / "library-backup.js",
    "resources/extras.css": EXTRAS_DIR / "extras.css",
}
LEGACY_ASSETS = {
    "resources/karaoke-core.js",
    "resources/karaoke.js",
    "resources/karaoke.css",
}
CSS_TAG = (
    '  <link rel="stylesheet" href="audio-editor.css">\n'
    '  <link rel="stylesheet" href="extras.css">\n'
)
SCRIPT_TAGS = (
    '  <script src="i18n.js"></script>\n'
    '  <script src="editor-core.js"></script>\n'
    '  <script src="dj-core.js"></script>\n'
    '  <script src="backup-core.js"></script>\n'
    '  <script src="desktop-bridge.js"></script>\n'
    '  <script src="app-updates.js"></script>\n'
    '  <script src="audio-editor.js"></script>\n'
    '  <script src="auto-dj.js"></script>\n'
    '  <script src="library-backup.js"></script>\n'
)
PLATFORMS = {
    "windows": REPO / "Pulsar-Windows" / "resources.neu",
    "linux": REPO / "Pulsar-Linux" / "resources.neu",
}
CORE_SOURCES = {
    "windows": REPO / "Pulsar-Core" / "Windows",
    "linux": REPO / "Pulsar-Core" / "Linux",
}


def patch_asset_tags(html: str) -> str:
    for tag in (CSS_TAG, SCRIPT_TAGS):
        html = html.replace(tag, "")
    # Usuń także znaczniki z innym wcięciem po starszych buildach.
    asset_names = tuple(Path(rel).name for rel in (*ASSETS.keys(), *LEGACY_ASSETS)
                        if rel not in SYNC_ASSETS)
    lines = [line for line in html.splitlines(keepends=True)
             if not any(name in line and ("<script" in line or "<link" in line)
                        for name in asset_names)]
    html = "".join(lines)
    if html.count("</head>") != 1 or html.count("</body>") != 1:
        raise ValueError("index.html nie ma dokładnie jednego </head> i </body>")
    html = html.replace("</head>", CSS_TAG + "</head>", 1)
    html = html.replace("</body>", SCRIPT_TAGS + "</body>", 1)
    return html


def expected_index(original: bytes) -> bytes:
    html = original.decode("utf-8")
    html = re.sub(r"Build \d+\.\d+\.\d+", f"Build {APP_VERSION}", html)
    html = apply_cloud_runtime_patches(html)
    html, _ = patch_sync_asset_tags(html)
    return patch_asset_tags(apply_extras_runtime_patches(apply_editor_runtime_patches(html))).encode("utf-8")


def expected_config(original: bytes) -> bytes:
    config = json.loads(original)
    config["version"] = APP_VERSION
    window = config.setdefault("modes", {}).setdefault("window", {})
    window["title"] = f"Pulsar — Build {APP_VERSION}"
    # Ten format jest identyczny ze źródłowym configiem, więc build jest idempotentny.
    return json.dumps(config, indent=2).encode("utf-8")


def run(platform: str, archive: Path, check_only: bool, from_source: bool = False) -> bool:
    if not from_source and not archive.is_file():
        print(f"[{platform}] brak {archive}")
        return False
    for source in ASSETS.values():
        if not source.is_file():
            raise ValueError(f"brak zasobu {source}")

    with tempfile.TemporaryDirectory(prefix=f"pulsar-editor-{platform}-") as tmp:
        work = Path(tmp) / "src"
        if from_source:
            source_root = CORE_SOURCES[platform]
            if not (source_root / INDEX).is_file() or not (source_root / CONFIG).is_file():
                raise ValueError(f"brak kompletnych źródeł rdzenia w {source_root}")
            files = {
                source.relative_to(source_root).as_posix(): source.read_bytes()
                for source in sorted(source_root.rglob("*")) if source.is_file()
            }
        else:
            data, header, base = neu.read_archive(str(archive))
            files = {rel: neu.file_bytes(data, base, entry) for rel, entry in neu.iter_files(header)}
        if INDEX not in files or CONFIG not in files:
            raise ValueError("w źródłach brak resources/index.html lub neutralino.config.json")
        for rel, blob in files.items():
            target = work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(blob)

        patched = expected_index(files[INDEX])
        patched_config = expected_config(files[CONFIG])
        sources_match = all(files.get(rel) == source.read_bytes() for rel, source in ASSETS.items())
        ready = (not from_source and files[INDEX] == patched and files[CONFIG] == patched_config and sources_match
                 and not any(rel in files for rel in LEGACY_ASSETS)
                 and editor_runtime_patched(patched.decode("utf-8"))
                 and extras_runtime_patched(patched.decode("utf-8")))
        if check_only:
            print(f"[{platform}] {'gotowe' if ready else 'wymaga przebudowania'}")
            return ready
        if ready:
            print(f"[{platform}] edytor już aktualny")
            return True

        (work / INDEX).write_bytes(patched)
        (work / CONFIG).write_bytes(patched_config)
        for rel in LEGACY_ASSETS:
            (work / rel).unlink(missing_ok=True)
        for rel, source in ASSETS.items():
            target = work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        rebuilt = Path(tmp) / "resources.neu"
        neu.pack(str(work), str(rebuilt))
        after_data, after_header, after_base = neu.read_archive(str(rebuilt))
        after = {rel: neu.file_bytes(after_data, after_base, entry)
                 for rel, entry in neu.iter_files(after_header)}
        allowed = {INDEX, CONFIG, *ASSETS.keys()}
        for rel, blob in files.items():
            if rel in LEGACY_ASSETS:
                if rel in after:
                    raise ValueError(f"przestarzały zasób {rel} nadal jest w archiwum")
                continue
            if rel not in allowed and after.get(rel) != blob:
                raise ValueError(f"plik {rel} zmienił się przy przebudowie")
        if after.get(INDEX) != patched:
            raise ValueError("index.html w archiwum różni się od oczekiwanego")
        if after.get(CONFIG) != patched_config:
            raise ValueError("neutralino.config.json różni się od oczekiwanego")
        for rel, source in ASSETS.items():
            if after.get(rel) != source.read_bytes():
                raise ValueError(f"zasób {rel} nie zgadza się ze źródłem")
        for rel, entry in neu.iter_files(after_header):
            if neu.check(entry, after[rel]) is False:
                raise ValueError(f"zła suma SHA-256: {rel}")

        shutil.copy2(rebuilt, archive)
        print(f"[{platform}] zapisano edytor: {archive.stat().st_size} B, {len(after)} plików")
        return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=sorted(PLATFORMS))
    parser.add_argument("--check", action="store_true", help="sprawdź bez zapisywania")
    parser.add_argument("--from-source", action="store_true", help="pełny build z czytelnych źródeł Pulsar-Core")
    args = parser.parse_args(argv)
    if args.from_source and args.check:
        parser.error("--from-source służy do budowania; po buildzie uruchom osobno --check")
    targets = [args.platform] if args.platform else sorted(PLATFORMS)
    ok = True
    for platform in targets:
        try:
            ok &= run(platform, PLATFORMS[platform], args.check, args.from_source)
        except (OSError, ValueError, KeyError) as exc:
            print(f"[{platform}] błąd: {exc}", file=sys.stderr)
            return 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
