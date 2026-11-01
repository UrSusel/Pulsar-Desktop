#!/usr/bin/env python3
"""Wstrzykuje wspólną warstwę synchronizacji do paczek Windows i Linuksa.

Aplikacja desktop jest spakowana w resources.neu (format asar Neutralino).
Ten skrypt rozpakowuje archiwum, dokłada dwa pliki (silnik drive-sync.js oraz
adapter desktop-cloud-sync.js jako resources/cloud-sync.js), wstawia znacznik
<script> do resources/index.html i pakuje archiwum z powrotem — z przeliczonymi
sumami SHA-256, których Neutralino wymaga przy starcie.

Wszystko poza index.html zostaje bajt w bajt takie samo, a skrypt jest
idempotentny: powtórne uruchomienie nie doda drugiego znacznika.

Użycie:
  python Pulsar-Sync/tools/build_desktop_sync.py            # obie paczki
  python Pulsar-Sync/tools/build_desktop_sync.py --check    # tylko sprawdź
  python Pulsar-Sync/tools/build_desktop_sync.py --platform windows
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
import tempfile
from pathlib import Path
from typing import Iterator

SYNC_DIR = Path(__file__).resolve().parents[1]
REPO = SYNC_DIR.parent
sys.path.insert(0, str(SYNC_DIR / "tools"))
from cloud_runtime_patches import (  # noqa: E402
    apply_cloud_runtime_patches,
    cloud_hooks_current,
    cloud_runtime_patched,
)
ENGINE = SYNC_DIR / "drive-sync.js"
ADAPTER = SYNC_DIR / "desktop-cloud-sync.js"
NEU = SYNC_DIR / "tools" / "neu.py"

CONFIG_NAME = "neutralino.config.json"
INDEX_NAME = "resources/index.html"
ENGINE_NAME = "resources/drive-sync.js"
ADAPTER_NAME = "resources/cloud-sync.js"
# Kolejność ma znaczenie: adapter rejestruje window.__pulsarSyncAdapter,
# a dopiero po nim startuje silnik.
SCRIPT_TAGS = (
    '  <script src="cloud-sync.js"></script>\n'
    '  <script src="drive-sync.js"></script>\n'
)
SCRIPT_FILES = ('cloud-sync.js', 'drive-sync.js')
AFTER_TAG = '<script src="desktop.js"></script>\n'

PLATFORMS = {
    "windows": REPO / "Pulsar-Windows" / "resources.neu",
    "linux": REPO / "Pulsar-Linux" / "resources.neu",
}


# ------------------------------------------------------------------ format .neu
def read_archive(path: Path):
    data = path.read_bytes()
    if len(data) < 16:
        raise ValueError(f"{path} jest za mały na archiwum")
    outer, header_size, inner_size, json_size = struct.unpack("<4I", data[:16])
    if outer != 4 or inner_size > header_size or json_size > inner_size - 4:
        raise ValueError(f"{path}: nierozpoznany nagłówek")
    header = json.loads(data[16:16 + json_size].decode("utf-8"))
    base = 8 + header_size
    return data, header, base, header_size, json_size


def iter_files(node, prefix: str = "") -> Iterator[tuple[str, dict]]:
    for name, entry in node.get("files", {}).items():
        rel = prefix + name
        if "files" in entry:
            yield from iter_files(entry, rel + "/")
        else:
            yield rel, entry


def file_bytes(data: bytes, base: int, entry: dict) -> bytes:
    offset = base + int(entry["offset"])
    return data[offset:offset + int(entry["size"])]


# ------------------------------------------------------------------ operacje
def unpack(archive: Path, dest: Path) -> dict[str, bytes]:
    data, header, base, _, _ = read_archive(archive)
    files: dict[str, bytes] = {}
    for rel, entry in iter_files(header):
        files[rel] = file_bytes(data, base, entry)
    for rel, blob in files.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    return files


def patch_index(html: str) -> tuple[str, bool]:
    """Wstawia znaczniki <script> raz; zwraca (html, czy_zmieniono).

    Para znaczników (adapter, potem silnik) jest traktowana jako jedna całość:
    istniejące znaczniki naszych plików są usuwane i wstawiane od nowa w
    poprawnej kolejności. Dzięki temu starsza wersja skryptu, która wstawiła
    tylko jeden z nich, sama się naprawi.
    """
    if html.count(AFTER_TAG) != 1:
        raise ValueError("nie znaleziono dokładnie jednego znacznika desktop.js w index.html")

    if SCRIPT_TAGS in html and (AFTER_TAG + SCRIPT_TAGS) in html:
        return html, False  # już jest dokładnie tak, jak ma być

    ours = ['  <script src="' + name + '"></script>\n' for name in SCRIPT_FILES]
    stripped = html
    for line in ours:
        stripped = stripped.replace(line, '')

    html = stripped.replace(AFTER_TAG, AFTER_TAG + SCRIPT_TAGS, 1)
    return html, True


def run(platform: str, archive: Path, check_only: bool) -> bool:
    if not archive.is_file():
        print(f"[{platform}] brak {archive} — pomijam")
        return False
    if not ENGINE.is_file() or not ADAPTER.is_file():
        raise ValueError("brak silnika lub adaptera w Pulsar-Sync/")

    before_size = archive.stat().st_size
    with tempfile.TemporaryDirectory(prefix=f"pulsar-{platform}-") as tmp:
        work = Path(tmp) / "src"
        files = unpack(archive, work)

        html = files[INDEX_NAME].decode("utf-8")
        # 1) Poprawki runtime'u: zapis netId/metadanych, zdarzenia biblioteki
        # i hooki scalania. Bez nich synchronizacja nie ma czego wysłać i nie
        # wie, kiedy się uruchomić.
        runtime_changed = not cloud_runtime_patched(html) or not cloud_hooks_current(html)
        html = apply_cloud_runtime_patches(html)
        # 2) Znaczniki <script>: adapter przed silnikiem.
        patched, changed = patch_index(html)
        already = not changed

        print(f"[{platform}] {archive.name}: {len(files)} plików, {before_size} B")
        print(f"[{platform}]   runtime: {'już poprawiony' if not runtime_changed else 'wstrzykuję poprawki (albo nowsze hooki)'};"
              f" znaczniki: {'już są' if already else 'wstawiam'}")

        if check_only:
            ready = already and not runtime_changed
            print(f"[{platform}] tryb --check: {'gotowe' if ready else 'wymaga wstrzyknięcia'}")
            return ready

        (work / INDEX_NAME).write_text(patched, encoding="utf-8")
        shutil.copy2(ENGINE, work / ENGINE_NAME)
        shutil.copy2(ADAPTER, work / ADAPTER_NAME)

        rebuilt = Path(tmp) / "resources.neu"
        sys.path.insert(0, str(NEU.parent))
        import neu  # noqa: E402  (narzędzie użytkownika do pakowania)
        neu.pack(str(work), str(rebuilt))

        # Kontrola: archiwum musi dać się odczytać, a pliki spoza index.html
        # muszą być identyczne jak przed patchowaniem.
        data, header, base, _, _ = read_archive(rebuilt)
        after = {}
        for rel, entry in iter_files(header):
            after[rel] = file_bytes(data, base, entry)
        # Pliki, które celowo podmieniamy, są sprawdzane osobno niżej; cała
        # reszta zawartości musi przejść przez rozpakowanie i pakowanie bez
        # jednego zmienionego bajtu.
        replaced = {INDEX_NAME, ENGINE_NAME, ADAPTER_NAME}
        for rel, blob in files.items():
            if rel in replaced:
                continue
            if after.get(rel) != blob:
                raise ValueError(f"[{platform}] plik {rel} zmienił się przy przepakowaniu")
        if after.get(ENGINE_NAME) != ENGINE.read_bytes():
            raise ValueError(f"[{platform}] silnik w archiwum nie zgadza się z Pulsar-Sync")
        if after.get(ADAPTER_NAME) != ADAPTER.read_bytes():
            raise ValueError(f"[{platform}] adapter w archiwum nie zgadza się z Pulsar-Sync")
        for name in SCRIPT_FILES:
            tag = b'<script src="' + name.encode("utf-8") + b'"></script>'
            if tag not in after[INDEX_NAME]:
                raise ValueError(f"[{platform}] index.html bez znacznika {name}")
        if after[INDEX_NAME].find(b'cloud-sync.js') > after[INDEX_NAME].find(b'drive-sync.js'):
            raise ValueError(f"[{platform}] zła kolejność znaczników (adapter musi być pierwszy)")

        shutil.copy2(rebuilt, archive)
        print(f"[{platform}] zapisano: {len(after)} plików, {archive.stat().st_size} B "
              f"({'wstrzyknięto' if changed else 'znaczniki bez zmian'})")
        return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=sorted(PLATFORMS), default=None,
                        help="tylko jedna paczka (domyślnie obie)")
    parser.add_argument("--check", action="store_true",
                        help="nie zapisuj, tylko powiedz, czy paczka ma już warstwę")
    args = parser.parse_args(argv)

    targets = [args.platform] if args.platform else sorted(PLATFORMS)
    ok = True
    for platform in targets:
        try:
            ok &= run(platform, PLATFORMS[platform], args.check)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            print(f"[{platform}] błąd: {exc}", file=sys.stderr)
            return 1
    return 0 if ok or args.check else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
