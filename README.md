# 🌌 Pulsar — Desktop Music Player

A free, **portable** music player for **Windows and Linux** with a pulsar-nebula soul: search YouTube, save full tracks **with cover art and tags embedded**, sing along with synced lyrics, and watch audio-reactive visualizers. No installer, no command line — one folder that just runs.

![version](https://img.shields.io/badge/version-0.20.12-4de3ff) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20%C2%B7%20Linux%20x64-a06bff) ![size](https://img.shields.io/badge/size-%7E20%20MB%20(Win)%20%2F%20%7E7%20MB%20(Linux)-ff5fd0)

## ⬇️ Download

| Platform | Archive | Run it |
|---|---|---|
| **Windows 10 / 11 (x64)** | [`Pulsar-Desktop.zip`](Pulsar-Desktop.zip) | unpack anywhere → double-click `pulsar.exe` |
| **Linux x64** | [`Pulsar-Linux.zip`](Pulsar-Linux.zip) | unpack anywhere → `chmod +x pulsar && ./pulsar` |

The project page — [ursusel.github.io/Pulsar-Desktop](https://ursusel.github.io/Pulsar-Desktop/) — shows a **Download for Linux** button automatically once `Pulsar-Linux.zip` lands in this repo.

> **Windows:** if SmartScreen appears, click *More info → Run anyway* (only once) — the app just isn't code-signed.

> **Linux:** the only system dependency is WebKitGTK, and the download manager (`yt-dlp`) is bundled.
> Arch / CachyOS: `sudo pacman -S gtk3 webkit2gtk-4.1` · Debian / Ubuntu: `sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0`
> `ffmpeg` is optional and unlocks a few extra audio formats. On Wayland everything works through XWayland out of the box.

## ✨ Features

- 🎧 **Built-in YouTube downloader** — yt-dlp ships inside the app and starts itself in the background
- 🖼️ **Covers & tags embedded** — saved tracks look right in Explorer, your phone, any player
- 🌠 **Nebula visualizers** — audio-reactive 3D backgrounds, fullscreen ambient mode
- 🎤 **Synced lyrics** — elegant column, buttery-smooth in fullscreen
- 🎨 **Dynamic colours** — the whole UI picks up palettes from the current album cover
- ⏱️ **Sleep timer & stats** — gentle fade-out, favourites, play counts, smart sorting
- 📻 **Auto-DJ** — picks the next tracks by tempo and energy, keeps them fresh (no ping-pong between two songs)
- 🔌 **Truly portable** — keep it on any drive, even a USB stick; identical experience on Windows and Linux
- 🪟 **Windows integration** — tray icon with playback menu, optional close-to-tray, always-on-top, compact mini mode
- ⏯️ **Resume where you left off** — last track and position are restored on start
- 🔁 **Gapless playback** — live albums and DJ mixes flow on without a gap
- ✏️ **Tag editor** — fix title, artist and cover from the track list; MP3/M4A tags are written into the file
- 💾 **Library backup** — one `.pulsarlib` file with tracks, covers, favourites and stats; restore merges, never deletes

## 📁 What's in this repo

```
Pulsar-Windows/     the runnable Windows build   (pulsar.exe · resources.neu · yt-dlp.exe)
Pulsar-Linux/       the runnable Linux build     (pulsar · resources.neu · yt-dlp · README.md)
index.html          the project / download page  (served via GitHub Pages)
Pulsar-Desktop.zip  packaged Windows release
Pulsar-Linux.zip    packaged Linux release
```

Each folder is the whole app: exactly the files needed to run it, nothing else. The player itself is closed-source — `resources.neu` is a packed runtime bundle, not editable sources.

## 🛠️ Tech

Single-file web app (vanilla JS + WebGL shaders) wrapped with [Neutralino.js](https://neutralino.js.org) — WebView2 on Windows, system WebKitGTK on Linux. No Electron, no Node.js, no runtime installer. Downloads powered by the bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp).
