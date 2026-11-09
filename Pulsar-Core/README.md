# Pulsar Core — readable application sources

This directory contains the original, readable runtime sources for the Pulsar desktop application. It is the source starting point for a complete build, not an unpacked scratch directory.

- `Windows/` and `Linux/` contain the platform-specific Neutralino configuration and native adapter differences.
- `resources/index.html` contains the main player UI, styles, and application logic.
- `resources/desktop.js` contains the Windows native integration; Linux has its corresponding adapter.
- `resources/tags.js`, `obs/`, icons, and tray sources are the remaining application resources. The player can import per-track `.lrc`/`.txt` lyrics and read embedded M4A/MP4 cover art (`covr`) locally.
- `resources/neutralino.js` is the third-party Neutralino client and retains its upstream license.

The source baseline also contains the synchronization hooks. The full build overlays the current `Pulsar-Sync`, `Pulsar-Editor`, and `Pulsar-Extras` modules so every layer has one canonical readable source.

## Rebuild both desktop archives

From the repository root:

```bash
python Pulsar-Editor/tools/build_desktop_editor.py --from-source
python Pulsar-Editor/tools/build_desktop_editor.py --check
python Pulsar-Editor/tools/test_desktop_editor.py
```

The build is deterministic. The test suite performs an independent build from these sources and compares each resulting `resources.neu` byte-for-byte with the checked-in Windows/Linux artifact.

Use `Pulsar-Core` for core changes, the respective module directory for extension changes, and then rebuild. Do not treat `resources.neu` as the preferred source for modifications.
