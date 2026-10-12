# Pulsar — Linux

Everything in this folder is self-contained. No installer needed.

| File | Purpose |
|---|---|
| `pulsar` | Application executable (Linux x86_64) |
| `resources.neu` | The packaged app (UI, visualizers, Linux bridge) |
| `yt-dlp` | Bundled YouTube search/downloader |

## Run it

```bash
cd Pulsar-Linux
chmod +x pulsar yt-dlp
./pulsar
```

## One-time system prerequisites

The app uses your system's web engine (WebKitGTK), like any other Linux desktop app:

```bash
# Arch / CachyOS
sudo pacman -S gtk3 webkit2gtk-4.1

# Debian / Ubuntu
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0

# Fedora
sudo dnf install gtk3 webkit2gtk4.1
```

`yt-dlp` runs on the bundled copy and only needs `python3`, which every desktop distro already has.

## Optional: MP3 export

Converting downloads to MP3 uses `ffmpeg` (auto-detected from your system or from this folder).
Everything else — playback, downloads, covers, tags, library — works without it.

```bash
sudo pacman -S ffmpeg     # or place an ffmpeg binary in this folder
```

## Troubleshooting

- **Black or blank window** (usually NVIDIA + Wayland):
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./pulsar` or `WEBKIT_DISABLE_COMPOSITING_MODE=1 ./pulsar`
- **No tray icon on GNOME**: enable an AppIndicator/TopIcons extension (app still works without it).
- **Library and settings** are saved automatically in your user profile; nothing is written into this folder except cached audio.
