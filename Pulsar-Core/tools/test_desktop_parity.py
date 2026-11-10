#!/usr/bin/env python3
"""Regression checks for the Linux/Windows desktop parity fixes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLATFORMS = {
    "Linux": ROOT / "Pulsar-Core/Linux/resources",
    "Windows": ROOT / "Pulsar-Core/Windows/resources",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    for platform, resources in PLATFORMS.items():
        html = (resources / "index.html").read_text(encoding="utf-8")
        desktop = (resources / "desktop.js").read_text(encoding="utf-8")

        require("folderDialog: function" in desktop and "Neutralino.os.showFolderDialog" in desktop,
                f"{platform}: native folder picker is exposed to the UI")
        require("async function openDiskDirModal()" in html and "fs.folderDialog(" in html,
                f"{platform}: downloaded-file copy uses the native folder picker")
        picker_block = html[html.index("async function openDiskDirModal()"):html.index("const smNetDiskBtn", html.index("async function openDiskDirModal()"))]
        require("input:" not in picker_block and "probeDiskDir(dir)" in picker_block,
                f"{platform}: no typed filesystem path; selected folder is validated")
        require("async function openNetLibraryFolderDialog()" in html
                and "fs.folderDialog(t('Wybierz folder w bibliotece dla pobrań'))" in html,
                f"{platform}: library download folder also uses the native folder picker")
        require("setNetBaseFolder(String(selected))" in html,
                f"{platform}: selected library folder is applied to the download category")
        require("input: t('np. Sieć albo Muzyka/Pobrane" not in html,
                f"{platform}: download folder is no longer requested as typed text")
        require("const mimeExt =" in html and "mimeExt || streamExt" in html,
                f"{platform}: downloaded audio extension is detected from its MIME type")
        require("id=\"smYtdlpBtn\"" in html and "id=\"smYtdlpAuto\"" in html,
                f"{platform}: updater controls are present")
        require("Aktualizuj yt-dlp" in desktop and "autoCheck" in desktop and "autoFix" in desktop,
                f"{platform}: manual, daily, and failure-recovery yt-dlp updates are wired")
        require("--embed-metadata --embed-thumbnail" in desktop,
                f"{platform}: MP3 download embeds metadata and artwork when FFmpeg is available")
        tags = (resources / "tags.js").read_text(encoding="utf-8")
        require("extractMp4Metadata" in tags and "'album'" in tags and "'year'" in tags and "'genre'" in tags,
                f"{platform}: M4A/MP4 album, year, and genre tags can be read and written")

    linux = (PLATFORMS["Linux"] / "desktop.js").read_text(encoding="utf-8")
    require("window.PulsarTags.mp4Embed" in linux,
            "Linux: disk-saved M4A/MP4 files use the shared metadata/cover embedder")
    print("Desktop parity checks passed for Linux and Windows")


if __name__ == "__main__":
    main()
