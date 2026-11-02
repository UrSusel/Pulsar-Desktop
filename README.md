# 🌌 Pulsar — Desktop Music Player

A free, **portable** music player for **Windows and Linux** with a pulsar-nebula soul: search YouTube, save full tracks **with cover art and tags embedded**, sing along with synced lyrics, and watch audio-reactive visualizers. No installer, no command line — one folder that just runs.

![version](https://img.shields.io/badge/version-0.21.0-4de3ff) ![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011%20%C2%B7%20Linux%20x64-a06bff) ![size](https://img.shields.io/badge/size-%7E20%20MB%20(Win)%20%2F%20%7E7%20MB%20(Linux)-ff5fd0)

## ⬇️ Download

| Platform | Archive | Run it |
|---|---|---|
| **Windows 10 / 11 (x64)** | [`Pulsar-Desktop.zip`](Pulsar-Desktop.zip) | unpack anywhere → double-click `pulsar.exe` |
| **Linux x64** | [`Pulsar-Linux.zip`](Pulsar-Linux.zip) | unpack anywhere → `chmod +x pulsar && ./pulsar` |

The project page — [ursusel.github.io/Pulsar-Desktop](https://ursusel.github.io/Pulsar-Desktop/) — shows a **Download for Linux** button automatically once `Pulsar-Linux.zip` lands in this repo.

> **Windows:** if SmartScreen appears, click *More info → Run anyway* (only once) — the app just isn't code-signed.

> **Linux:** the only system dependency is WebKitGTK, and the download manager (`yt-dlp`) is bundled.
> Arch / CachyOS: `sudo pacman -S gtk3 webkit2gtk-4.1 gst-libav gst-plugins-ugly gst-plugins-good` · Debian / Ubuntu: `sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 gstreamer1.0-libav gstreamer1.0-plugins-ugly gstreamer1.0-plugins-good`
> (the GStreamer packages are what actually decode MP3/AAC — without them the player stays silent)
> `ffmpeg` is optional: it unlocks MP3/FLAC export and memory-safe editing of very long recordings. The optional experimental AI lyrics aligner needs Python 3.10+ on first use, but does not need system FFmpeg. On Wayland everything works through XWayland out of the box.

## ✨ Features

- 🎧 **Built-in YouTube downloader** — yt-dlp ships inside the app and starts itself in the background
- 🖼️ **Covers & tags embedded** — saved tracks look right in Explorer, your phone, any player
- 🌠 **Nebula visualizers** — audio-reactive 3D backgrounds, fullscreen ambient mode
- 🎤 **Word-synced lyrics** — the regular lyrics panel gradually fills each word over its real duration from enhanced LRC, LRCLIB Lyricsfile, or the multi-source Lyrics+ fallback (used when LRCLIB has no word timing); otherwise it keeps the standard line-by-line highlighting
- 🧪 **Experimental local AI alignment** — on Windows/Linux, manually align a track's existing lyrics to its audio with Stable-TS/Faster-Whisper on CPU; useful for music videos whose source timings come from the studio version, existing word-sync can be replaced only after confirmation, and the original lyrics can be restored offline
- ✂️ **Audio Editor 2.0** — 32× waveform zoom, 1 ms cut boundaries, configurable silence detection, fades, resumable sessions and non-destructive WAV export
- 🎞️ **MP3 / FLAC & long recordings** — optional FFmpeg export; large files are edited without decoding the whole recording in WebView
- ⏱️ **Lyrics timing controls** — shift subtitles per track, export adjusted LRC, and keep lyrics aligned automatically after audio cuts
- 🎨 **Dynamic colours** — the whole UI picks up palettes from the current album cover
- ⏱️ **Sleep timer & stats** — gentle fade-out, favourites, play counts, smart sorting
- 📻 **Auto-DJ 2.0** — calm/focus/workout/party/discovery moods, “more like this”, artist/genre diversity, undoable history and a short reason for every pick
- 🔌 **Truly portable** — keep it on any drive, even a USB stick; identical experience on Windows and Linux
- 🔄 **App update checks** — automatic checks every 12 hours and a manual button compare the installed version with GitHub Releases; Pulsar only shows a download link and never installs an update by itself
- 🌍 **PL / EN / ES localization** — all newly added editor, AI, Auto-DJ, backup and update UI follows the selected language without a restart
- 🪟 **Windows integration** — tray icon with playback menu, optional close-to-tray, always-on-top, compact mini mode
- ⏯️ **Resume where you left off** — last track and position are restored on start
- 🔁 **Gapless playback** — live albums and DJ mixes flow on without a gap
- ✏️ **Tag editor** — fix title, artist and cover from the track list; MP3/M4A tags are written into the file
- ☁️ **One library everywhere** — point the app once at a folder synced with Google Drive and Windows, Linux and Android share the same library (names, favourites, plays, albums — never the audio files)
- 💾 **Automatic & safe backups** — scheduled `.pulsarlib` copies, rotated versions, safety snapshots before restore/major changes, and a warning before deleting a track that exists only in the library

## ☁️ One library on every device

The app can keep your library in a folder that Google Drive syncs. Only metadata travels —
track names, artists, albums, favourites, play counts. Audio files never leave your devices,
and nothing is sent anywhere except your own Drive.

**Windows** — install [Google Drive for desktop](https://www.google.com/drive/download/), keep a
folder synced, then in the app: *Settings → Cloud → Choose folder* and pick that folder.
**Linux** — sync a folder with `rclone`, `Insync` or your file manager's Google Drive
integration, then pick that folder the same way. **Android** — same folder, same menu.

That's the whole setup: one-time per machine, then it happens automatically. The second device
must be signed into the same Google account *and* have the same folder picked — the access
grant does not copy across devices, and the app waits for the Drive client to download the
manifest before it sees new changes.

A track saved on one device is metadata on the others — audio files never travel. Those entries
are listed in the panel with a **Download here** button: for YouTube tracks the app fetches its own
copy on that machine, and files that live on the other device say so instead of pretending.

Signing in with a Google account inside the app is Android-only: Google no longer allows the
browser-based flow the desktop build could perform, so on Windows and Linux the panel simply
asks for the synced folder instead.

## 📁 What's in this repo

```
Pulsar-Windows/     the runnable Windows build   (pulsar.exe · resources.neu · yt-dlp.exe)
Pulsar-Linux/       the runnable Linux build     (pulsar · resources.neu · yt-dlp · README.md)
Pulsar-Core/        complete readable core      (Windows/Linux UI, runtime + resources)
Pulsar-Sync/        shared cloud library layer  (engine, adapters, build + tests)
Pulsar-Editor/      desktop audio/LRC editor    (UI, audio engine, build + tests)
Pulsar-Extras/      Auto-DJ, backups, updates  (native bridge, UI + tests)
index.html          the project / download page  (served via GitHub Pages)
Pulsar-Desktop.zip  packaged Windows release
Pulsar-Linux.zip    packaged Linux release
```

Each app folder contains the files needed to run that build. The complete original source is available under Apache-2.0: `Pulsar-Core/` holds the readable core, while `Pulsar-Sync/`, `Pulsar-Editor/`, and `Pulsar-Extras/` hold the extension layers. Packed `resources.neu` files are reproducible build outputs, not the preferred form for editing.

## 🔨 Build from source

```bash
python Pulsar-Editor/tools/build_desktop_editor.py --from-source
python Pulsar-Editor/tools/build_desktop_editor.py --check
python Pulsar-Editor/tools/test_desktop_editor.py
python Pulsar-Sync/tools/test_desktop_bundle.py
```

The source-build test independently rebuilds both desktop archives from `Pulsar-Core` and requires byte-for-byte identical output. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and development data rules.

## 🔐 License, ownership and privacy

Pulsar is an independent personal project owned and maintained by **UrSusel**. Original project code is licensed under [Apache-2.0](LICENSE); third-party components keep their own [licenses and notices](THIRD_PARTY_NOTICES.md). The application is local-first and has no project-operated telemetry backend; see [PRIVACY.md](PRIVACY.md).

## 🛠️ Tech

Single-file web app (vanilla JS + WebGL shaders) wrapped with [Neutralino.js](https://neutralino.js.org) — WebView2 on Windows, system WebKitGTK on Linux. No Electron, no Node.js, no runtime installer. Downloads powered by the bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp).
