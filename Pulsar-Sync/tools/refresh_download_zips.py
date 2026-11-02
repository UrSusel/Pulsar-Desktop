#!/usr/bin/env python3
"""Odświeża archiwa do pobrania (Pulsar-Linux.zip, Pulsar-Desktop.zip).

Paczki w repo to to, co ludzie ściągają z GitHuba, więc muszą mieć tę samą
warstwę synchronizacji, co foldery Pulsar-Linux/ i Pulsar-Windows/. Skrypt
podmienia w archiwum pliki, które się zmieniły (`resources.neu`, stronę
`index.html` w paczce Windows, a na Linuksie także README.md), oraz dodaje brakujące
LICENSE/NOTICE i pozostałe wymagane dokumenty. Wszystkie pozostałe wpisy —
łącznie z prawami dostępu i datami — zostają bez zmian.

  python Pulsar-Sync/tools/refresh_download_zips.py           # odśwież
  python Pulsar-Sync/tools/refresh_download_zips.py --check   # tylko sprawdź
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

TARGETS = {
    "Pulsar-Linux.zip": {
        "resources.neu": REPO / "Pulsar-Linux" / "resources.neu",
        "README.md": REPO / "Pulsar-Linux" / "README.md",
    },
    "Pulsar-Desktop.zip": {
        "resources.neu": REPO / "Pulsar-Windows" / "resources.neu",
        "index.html": REPO / "index.html",
    },
}

DISTRIBUTION_NOTICES = {
    name: REPO / name
    for name in ("LICENSE", "NOTICE", "PRIVACY.md", "THIRD_PARTY_NOTICES.md")
}
DISTRIBUTION_NOTICES.update({
    source.relative_to(REPO).as_posix(): source
    for source in sorted((REPO / "licenses").glob("*.txt"))
})
for replacements in TARGETS.values():
    replacements.update(DISTRIBUTION_NOTICES)


def stale_names(archive: Path, replacements: dict[str, Path]) -> list[str]:
    with zipfile.ZipFile(archive) as zip_file:
        names = zip_file.namelist()
        return [name for name, source in replacements.items()
                if name not in names or zip_file.read(name) != source.read_bytes()]


def refresh(archive: Path, replacements: dict[str, Path], check_only: bool) -> bool:
    if not archive.is_file():
        print(f"{archive.name}: brak archiwum — pomijam")
        return True
    stale = stale_names(archive, replacements)
    if not stale:
        print(f"{archive.name}: aktualne ✔")
        return True
    if check_only:
        print(f"{archive.name}: do odświeżenia: {', '.join(stale)}")
        return False

    with tempfile.TemporaryDirectory() as tmp:
        rebuilt = Path(tmp) / archive.name
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(rebuilt, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename in stale:
                    data = replacements[info.filename].read_bytes()
                fresh = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                fresh.external_attr = info.external_attr       # prawa dostępu (pulsar, yt-dlp)
                fresh.internal_attr = info.internal_attr
                fresh.compress_type = info.compress_type
                fresh.create_system = info.create_system
                target.writestr(fresh, data)
            existing = set(source.namelist())
            for name, source_path in replacements.items():
                if name not in existing:
                    target.write(source_path, arcname=name)

        # Kontrola przed podmianą: stare wpisy zostają w tej samej kolejności,
        # nowe dokumenty są dopisane na końcu, a tryby pozostałych plików się
        # nie zmieniają.
        with zipfile.ZipFile(archive) as before, zipfile.ZipFile(rebuilt) as after:
            before_names = [i.filename for i in before.infolist()]
            expected_names = before_names + [name for name in replacements if name not in before_names]
            if expected_names != [i.filename for i in after.infolist()]:
                raise ValueError(f"{archive.name}: nieoczekiwana lista plików po odświeżeniu")
            for old, new in zip(before.infolist(), after.infolist()):
                if old.external_attr != new.external_attr or old.date_time != new.date_time:
                    raise ValueError(f"{archive.name}: {old.filename} zgubił prawa dostępu")
                if old.filename not in stale and before.read(old.filename) != after.read(new.filename):
                    raise ValueError(f"{archive.name}: {old.filename} zmienił się niepotrzebnie")
            for name in replacements:
                if after.read(name) != replacements[name].read_bytes():
                    raise ValueError(f"{archive.name}: {name} nie zgadza się z plikiem w repo")
        shutil.copy2(rebuilt, archive)

    print(f"{archive.name}: odświeżono {', '.join(stale)} → {archive.stat().st_size} B")
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="nie zapisuj, tylko sprawdź")
    args = parser.parse_args(argv)
    fresh = []
    for name, replacements in TARGETS.items():
        try:
            if not refresh(REPO / name, replacements, args.check):
                fresh.append(name)
        except (OSError, ValueError, zipfile.BadZipFile) as exc:
            print(f"{name}: błąd: {exc}", file=sys.stderr)
            return 1
    if args.check and fresh:
        print("Do odświeżenia: " + ", ".join(fresh))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
