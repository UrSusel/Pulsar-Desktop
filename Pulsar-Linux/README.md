# Pulsar — Linux

Pulsar's original code is open source under Apache-2.0. This archive includes `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, and the upstream license texts in `licenses/`.

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

## Optional: FFmpeg exports and long recordings

Converting downloads to MP3, editor export to MP3/FLAC, and memory-safe editing of very large recordings use `ffmpeg` (auto-detected from your system or from this folder). Playback, downloads, covers, tags, library and ordinary WAV editing work without it.

```bash
sudo pacman -S ffmpeg     # or place an ffmpeg binary in this folder
```

## Audio and lyrics editor

Click the **scissors** next to the lyrics button to remove unwanted audio ranges or detected silence. Editor 2.0 adds 32× zoom, draggable/numeric 1 ms boundaries, adjustable silence threshold/duration, fades and resumable sessions. Preview skips the cuts before saving; export always creates a new copy and never overwrites the original. WAV works without FFmpeg; MP3/FLAC and files over 80 MB or 30 minutes use FFmpeg without decoding the whole recording in WebView.

The **Lyrics** tab shifts synchronized subtitles earlier or later and remembers the offset per track. You can also export an adjusted `.lrc` file. When an edited audio copy has lyrics, their timing is remapped around the removed ranges automatically. The regular lyrics panel uses real word timing from enhanced LRC or LRCLIB first, then tries the multi-source Lyrics+ service if LRCLIB has only line timing; if neither has words, ordinary line highlighting remains. The current word fills gradually over its real duration, directly on the text rather than through a separate progress bar.

### Optional experimental AI alignment

The same **Lyrics** tab can manually align existing lyrics to the local audio at word level. It uses Stable-TS/Faster-Whisper on CPU, not a cloud transcription service. Existing word timing can also be realigned after explicit confirmation — useful when it belongs to the studio recording rather than a music video — and the source remains restorable. The first run asks before creating an isolated Python environment and downloading packages/model (from about 2 GB depending on the platform, plus the roughly 150 MB `base` model). Install Python 3.10+ and, on Debian/Ubuntu, `python3-venv` if it is separate. PyAV decodes audio, so system FFmpeg is not required for this feature.

AI files live in `$XDG_CACHE_HOME/pulsar/lyrics-ai` or `~/.cache/pulsar/lyrics-ai`, not in the app folder. The result is marked experimental and saved with the track; **Restore source lyrics** brings back the saved source even offline. Singing over a full mix can still align imperfectly, so check the result before relying on it.

## Application updates

**Settings → Downloads → Pulsar** shows the installed version and checks the published releases at `UrSusel/Pulsar-Desktop` on app startup, then at most once every 12 hours during a long session; you can also use **Check for updates** on demand. A newer stable release is shown with a download link; Pulsar never downloads or installs an application update automatically. You can disable the automatic checks independently of `yt-dlp` updates.

## Auto-DJ and automatic backups

**Settings → Playback → Auto-DJ 2.0** provides moods, “more like this”, artist/genre diversity, a reason for the next pick and undoable DJ history.

**Settings → Library → Automatic backups** creates a weekly `.pulsarlib` copy by default and keeps three rotated versions. Safety snapshots can also run before restore, major library changes or deleting a track whose only local file is inside the library. The default folder is `~/Pulsar/Backups`; you can choose another. Scheduling runs while Pulsar is open and does not install a system service.

## Cloud library (Google Drive)

The app can keep your library — titles, artists, favourites, play counts, albums — in a folder
that Google Drive syncs, so Windows, Linux and the Android app all share one library. Only that
metadata travels; the audio files stay on each device.

1. Sync a folder with Drive using whatever you already run — `rclone` (`rclone mount`, or
   `rclone bisync` on a timer), Insync, or a Files/overlay integration. The app does not care
   how the folder gets to the cloud, only that it does.
2. In Pulsar: **Settings → Cloud → Choose folder** and pick that folder. This is a one-time
   step per machine; the app remembers it.
3. Leave **Sync automatically** on. **Sync now** forces a sync on demand, and the panel shows
   when the last one happened.

Signing in with a Google account inside the app is Android-only (Google no longer allows the
desktop flow), so the desktop panel asks for the folder instead — no account setup, no OAuth
screen, no Google Cloud project.

Two things worth knowing: the other device must pick the same folder, and it sees changes only
after its Drive client has downloaded the file the other device wrote, so this is not instant.

## Troubleshooting

- **No sound** (the usual one): WebKitGTK decodes MP3/AAC through GStreamer codecs that minimal
  installs skip. Add them: `sudo pacman -S gst-libav gst-plugins-ugly gst-plugins-good`
  (Debian/Ubuntu: `sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-ugly gstreamer1.0-plugins-good`).
  Verify outside the app with `gst-play-1.0 some-track.mp3`.
- **Black or blank window** (usually NVIDIA + Wayland):
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./pulsar` or `WEBKIT_DISABLE_COMPOSITING_MODE=1 ./pulsar`
- **No tray icon on GNOME**: enable an AppIndicator/TopIcons extension (app still works without it).
- **Library and settings** are saved automatically in your user profile; nothing is written into this folder except cached audio.
