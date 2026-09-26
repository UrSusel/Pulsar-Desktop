# 🌌 Pulsar — Desktop Music Player

A free, portable music player for **Windows 10/11** with a pulsar-nebula soul: search YouTube, save full tracks **with cover art and tags embedded**, sing along with synced lyrics, and watch audio-reactive 3D visualizers. No installer, no command line — one folder that just runs.

**⬇ [Download the latest ZIP](https://ursusel.github.io/Pulsar-Desktop/)** *(or grab [`Pulsar-Desktop.zip`](../../raw/main/Pulsar-Desktop.zip) straight from this repo)*

![version](https://img.shields.io/badge/version-0.19.26-4de3ff) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-a06bff) ![size](https://img.shields.io/badge/size-%7E20%20MB-ff5fd0)

## ✨ Features

- 🎧 **Built-in YouTube downloader** — yt-dlp ships inside the app and starts itself in the background
- 🖼️ **Covers & tags embedded** — saved tracks look right in Explorer, your phone, any player
- 🌠 **Nebula visualizers** — audio-reactive 3D backgrounds, fullscreen ambient mode
- 🎤 **Synced lyrics** — elegant column, buttery-smooth in fullscreen
- ⏱️ **Sleep timer & stats** — gentle fade-out, favorites, play counts, smart sorting
- 🔌 **Truly portable** — keep it on any drive, even a USB stick
- 🪟 **Windows integration** — tray icon with a Pulsar-styled panel (cover, progress, playback controls, toggles), optional close-to-tray, always-on-top, compact mini mode, now-playing in the window/taskbar title, track-change notifications
- ⏯️ **Resume where you left off** — last track and position are restored on start
- 📡 **OBS / streaming** — Pulsar's audio (with EQ & effects) goes straight into an OBS *Browser* source, plus an optional now-playing overlay. No virtual audio cables needed
- 🎨 **Overlay themes** — card, full-width bar, big cover or minimal text; five positions; accent from the cover or your own colour, with a live preview
- 🔁 **Gapless playback** — live albums and DJ mixes flow on without a gap (when crossfade is off); crossfade now preloads the next track too
- ✏️ **Tag editor** — fix title, artist and cover from the track list; MP3 (ID3v2) and M4A tags are written into the file itself, optionally also the original on disk
- 📂 **Watched folder** — pick a music folder and new files (including subfolders) show up in the library automatically
- 💾 **Library backup** — one `.pulsarlib` file with tracks, covers, albums, favourites, play counts and (optionally) settings; restore merges, never deletes
- ⬆️ **yt-dlp auto-update** — one-click update in Settings, a daily check against the latest release, and an automatic retry after an update if a download fails
- 🔔 **Pulsar update check** — on every start Pulsar compares its Build number with the one on the `main` branch and offers a one-click download when a newer version is out (can be turned off in Settings)

## 📸 Screenshots

| Player view | Fullscreen ambient |
|---|---|
| ![Player view](screenshots/player.png) | ![Fullscreen](screenshots/fullscreen.png) |

## 🚀 Run it in three steps

1. **Download & unpack** — extract the whole `Pulsar` folder anywhere (e.g. `C:\Pulsar`).
2. **Double-click `pulsar.exe`** — if SmartScreen appears: *More info → Run anyway* (only once).
3. **Play & save** — drop local files in, or open the *Net* tab and paste a YouTube link. Songs arrive with cover art, ready to keep or save to any folder on disk.

## 📡 Streaming with OBS

OBS's *Application Audio Capture* can't hear Pulsar: WebView2 plays sound from a separate `msedgewebview2.exe` process ([obs-studio#9838](https://github.com/obsproject/obs-studio/issues/9838)). Pulsar gets around this:

1. In Pulsar: **Settings → OBS / streaming → Audio and overlay for OBS** (on). Then click **How to connect OBS…** for the exact file path.
2. In OBS: add a **Browser** source, tick **Local file** and pick `obs\pulsar-obs.html` next to `pulsar.exe`. That file gives you the overlay with cover, title, progress and visualizer, plus the audio. For audio only, use `obs\pulsar-obs-audio.html`.
3. Tick **Control audio via OBS**. The source now shows up in the OBS mixer and reconnects by itself whenever Pulsar restarts.

For the window picture, use **Window Capture** with the method set to **Windows 10 (1903 and up)**. The relayed audio runs about 0.15 s behind the window picture. If you need perfect sync, add a 150 ms *Render Delay* filter to the window capture.

How it works: an AudioWorklet taps the final mix and a Web Worker streams it as 16-bit PCM over Neutralino's local-only WebSocket server (`127.0.0.1`). The OBS page receives only the *connect* token, so it can listen to events but cannot call any native API.

## 🛠️ Tech

Single-file web app (vanilla JS + WebGL shaders) wrapped with [Neutralino.js](https://neutralino.js.org) (WebView2) — ~20 MB, no Electron, no Node.js required at runtime. Downloads powered by the bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## 🧩 Source code & building

The app source lives in [`app/`](app/) (recovered 1:1 from `resources.neu`, SHA-256 verified):

```
app/
├─ neutralino.config.json    # window, permissions, version
└─ resources/
   ├─ index.html             # the whole player (HTML + CSS + JS, single file)
   ├─ desktop.js             # desktop layer: runs yt-dlp.exe, file system, window
   ├─ tags.js                # ID3v2 / MP4 tag writer (used by the tag editor and downloads)
   ├─ obs/overlay.html       # OBS overlay + themes
   ├─ neutralino.js          # Neutralino client library 6.9.0
   └─ icons/appIcon.png
```

Rebuild `resources.neu` after editing (Python 3 only, no Node.js needed):

```bash
python tools/neu.py pack app resources.neu     # folder  -> resources.neu
python tools/neu.py unpack resources.neu app   # resources.neu -> folder
python tools/neu.py verify resources.neu       # check SHA-256 integrity
```

Then put `pulsar.exe` + `resources.neu` + `yt-dlp.exe` in one folder and run `pulsar.exe`.
`pulsar.exe` is the stock Neutralino 6.9.0 Windows binary, so it never needs rebuilding.
Packing is deterministic: an unmodified `app/` produces a byte-identical `resources.neu`.

---

*Please respect the artists you love — use the YouTube features responsibly.*
