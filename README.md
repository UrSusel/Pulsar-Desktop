# 🌌 Pulsar — Desktop Music Player

A free, portable music player for **Windows 10/11** with a pulsar-nebula soul: search YouTube, save full tracks **with cover art and tags embedded**, sing along with synced lyrics, and watch audio-reactive 3D visualizers. No installer, no command line — one folder that just runs.

**⬇ [Download the latest ZIP](https://ursusel.github.io/Pulsar-Desktop/)** *(or grab [`Pulsar-Desktop.zip`](../../raw/main/Pulsar-Desktop.zip) straight from this repo)*

![version](https://img.shields.io/badge/version-0.09.22-4de3ff) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-a06bff) ![size](https://img.shields.io/badge/size-%7E20%20MB-ff5fd0)

## ✨ Features

- 🎧 **Built-in YouTube downloader** — yt-dlp ships inside the app and starts itself in the background
- 🖼️ **Covers & tags embedded** — saved tracks look right in Explorer, your phone, any player
- 🌠 **Nebula visualizers** — audio-reactive 3D backgrounds, fullscreen ambient mode
- 🎤 **Synced lyrics** — elegant column, buttery-smooth in fullscreen
- ⏱️ **Sleep timer & stats** — gentle fade-out, favorites, play counts, smart sorting
- 🔌 **Truly portable** — keep it on any drive, even a USB stick

## 📸 Screenshots

| Player view | Fullscreen ambient |
|---|---|
| ![Player view](screenshots/player.png) | ![Fullscreen](screenshots/fullscreen.png) |

## 🚀 Run it in three steps

1. **Download & unpack** — extract the whole `Pulsar` folder anywhere (e.g. `C:\Pulsar`).
2. **Double-click `pulsar.exe`** — if SmartScreen appears: *More info → Run anyway* (only once).
3. **Play & save** — drop local files in, or open the *Net* tab and paste a YouTube link. Songs arrive with cover art, ready to keep or save to any folder on disk.

## 🛠️ Tech

Single-file web app (vanilla JS + WebGL shaders) wrapped with [Neutralino.js](https://neutralino.js.org) (WebView2) — ~20 MB, no Electron, no Node.js required at runtime. Downloads powered by the bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp).

---

*Please respect the artists you love — use the YouTube features responsibly.*
