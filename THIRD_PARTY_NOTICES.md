# Third-party notices

Pulsar's original code is licensed under Apache-2.0. That license does not replace or relicense third-party components. The relevant upstream licenses continue to apply.

## Included in the desktop application

| Component | Version / use | License and notice |
|---|---|---|
| [Neutralinojs](https://github.com/neutralinojs/neutralinojs) | 6.9.0 runtime and `neutralino.js` client | MIT, plus notices for libraries bundled by Neutralino. The complete upstream notice is in [`licenses/Neutralino-LICENSE.txt`](licenses/Neutralino-LICENSE.txt). |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 2026.08.19 downloader executable | Unlicense. The complete upstream notice is in [`licenses/yt-dlp-LICENSE.txt`](licenses/yt-dlp-LICENSE.txt). |

The Windows and Linux ZIP archives include these notices alongside the binaries.

## Android build dependency

[Capacitor](https://github.com/ionic-team/capacitor) 8.4.3 (`@capacitor/core`, `@capacitor/android`, and `@capacitor/cli`) is MIT-licensed; see [`licenses/Capacitor-LICENSE.txt`](licenses/Capacitor-LICENSE.txt). Transitive npm, Android, and Gradle dependencies retain their own licenses.

## Optional components downloaded or supplied by the user

These components are not bundled in the desktop ZIP archives:

- [Stable-TS](https://github.com/jianfch/stable-ts) 2.19.1 — MIT; installed only after the user enables experimental lyrics alignment.
- [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.1 — MIT; installed with Stable-TS for local forced alignment.
- [PyAV](https://github.com/PyAV-Org/PyAV) `>=12,<19` — BSD-3-Clause; used by the optional alignment environment.
- [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.11.6 — MIT wrapper, optionally loaded from a CDN by the browser fallback. FFmpeg and `@ffmpeg/core` retain their own licenses and notices.
- System FFmpeg, WebKitGTK, GStreamer, Python, and the packages/models installed into the user's optional AI environment remain third-party software under their respective licenses.

No third-party component is represented as Pulsar's original work.
