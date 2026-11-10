# Contributing to Pulsar

Pulsar is an independent personal project owned and maintained by **UrSusel**. The original project code is available under [Apache-2.0](LICENSE). Unless explicitly stated otherwise, contributions are submitted under the same license; third-party code keeps its original license.

## Development ground rules

- Keep changes focused and cover behavior with deterministic tests.
- Use synthetic fixtures and placeholder credentials only. Never submit secrets, private keys, access tokens, personal music libraries, or other people's personal data.
- Do not commit generated `www/`, temporary build directories, Python/Node dependency directories, model caches, or local application data.
- Preserve third-party copyright and license notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The packed `resources.neu` files and release ZIPs are build outputs. Change the readable sources, then rebuild them rather than editing archives by hand.

## Build from complete sources

Python 3 is required for the desktop resource build. The following command starts with `Pulsar-Core`, applies the current synchronization/editor/extension sources, and writes both desktop `resources.neu` files:

```bash
python Pulsar-Editor/tools/build_desktop_editor.py --from-source
python Pulsar-Editor/tools/build_desktop_editor.py --check
python Pulsar-Editor/tools/test_desktop_editor.py
python Pulsar-Sync/tools/test_desktop_bundle.py
python Pulsar-Sync/tools/refresh_download_zips.py
```

`test_desktop_editor.py` includes a clean source rebuild and requires its output to be byte-for-byte identical to the checked-in archives.

Before changing downloadable archives, run the relevant unit/browser suites listed in `Pulsar-Editor/README.md`, refresh both ZIPs, and update the versioned `SHA256SUMS-<version>.txt` file for the release artifacts.
