# Pulsar-Sync — one library on Android, Windows and Linux

Everything that makes the three builds share a single library lives here. There is one
engine and one set of runtime hooks; Android, Windows and Linux all ship the same code.

| File | What it is |
|---|---|
| `drive-sync.js` | The engine: builds the manifest, merges two manifests, applies the result, draws the Cloud panel. Runs on all three platforms. |
| `desktop-cloud-sync.js` | Desktop adapter (Neutralino). Talks to the folder the user picked; registers `window.__pulsarSyncAdapter`. |
| `cloud_sync_hooks.js` | Runtime hooks (`__pulsarSyncSnapshot`, `__pulsarSyncApply`) injected into the app's `index.html` on every platform. |
| `tools/build_desktop_sync.py` | Injects the layer into `Pulsar-Windows/resources.neu` and `Pulsar-Linux/resources.neu`. |
| `tools/cloud_runtime_patches.py` | The runtime edits shared by the Android build and the desktop packages. |
| `tools/test_drive_sync.js` | Offline test suite — Android plugins, desktop adapter, engine, panel. |
| `tools/test_desktop_bundle.py` | Checks both packaged archives after injection. |
| `tools/neu.py` | Unpack / pack / verify for the Neutralino `.neu` archives. |
| `tools/refresh_download_zips.py` | Puts the patched `resources.neu` into `Pulsar-Linux.zip` / `Pulsar-Desktop.zip`. |

## What travels, and what never does

Only metadata: track titles, artists, albums, years, favourites, play counts, the YouTube
identifier, album names and album membership. Audio files, covers and local paths stay on
the device that owns them.

Each device writes **its own file** — `pulsar-library-windows.json`,
`pulsar-library-linux.json`, `pulsar-library-android.json` — and reads all of them. Nobody ever
overwrites somebody else's file, so a device that cannot see the folder for a moment cannot
destroy the other device's library. The library is the sum of those files; the old single
`pulsar-library.json` is still read (so nothing written by an older build is lost), just never
written again.

## Tracks that only exist on the other device

Audio never travels, so a song saved on the phone is metadata-only on the PC (and the other
way round). The panel lists those entries by name under **Utwory tylko w chmurze** /
*Tracks only in the cloud*:

* a YouTube entry gets a **Pobierz tutaj** / *Download here* button. It asks the runtime's own
  network API (`window.__player.__net`) to search for that video and import it, so the track
  arrives with its `netId`, cover and tags — and because `netId` is the cross-device key, the
  next sync matches it and the entry stops being cloud-only everywhere;
* a file that only exists on the other device is labelled as such, because there is nothing to
  download — the audio is on that machine's disk.

Every failure is a sentence, never a silent button: no network API in the build, an empty search
result, network search switched off, or an import that never lands in the library.

When a sync finds tracks that were not in the cloud the last time it looked, it announces them
("Nowe z innego urządzenia: 1 «Nowa piosenka» …") instead of changing something invisibly in the
background, and the status box shows what the cloud file holds and who wrote it last
("Plik w chmurze: 54 utw. · Ostatnia zmiana z innego urządzenia: Pixel 8 · 13.10.2026, 21:12").
Devices name themselves: an Android device reports its model, a computer reports Windows PC /
Linux PC, and the manifest stores that with `platform: desktop` — a computer no longer registers
as "android".

New YouTube tracks can also be fetched on their own: the switch in the panel (on by default on a
computer, off on a phone so it does not spend mobile data) downloads a few tracks per batch, with
a pause between batches and a six-hour retry window for anything that failed, so a broken download
can never turn into a loop.

### Deletions, and the entries that only live in the cloud

A manifest lists what the other device has, so a device that has never seen a track must not treat
it as deleted. The engine keeps a record of the keys that were in *this* library at the last sync
(`localKeys`) and only tombstones keys from that record:

* a track saved on the phone stays in the cloud manifest when the computer syncs, however often
  it syncs, and stays on the "cloud only" list until it is downloaded (or the switch fetches it);
* a track deleted here still becomes a tombstone, the other device is told about it
  ("Usunięte na innym urządzeniu"), and its audio file is never touched;
* the record also keeps live tombstones (`localKeys.deleted`), so a deletion is not quietly
  forgotten on the next start;
* a manifest written by an older build may carry tombstones for entries that were never local —
  on the first sync after the update those are dropped, and the merge restores the entries from
  the file, which is how an already-broken library heals itself.

### When Drive does not show the files

A missing file is not an empty cloud. Drive's folder listing on Android (SAF) refreshes with a
delay, and the desktop client may not have downloaded a file yet, so for a moment a device sees a
folder with nothing in it — right after the other device wrote. Writing a shared manifest at that
point replaced the other device's library with a local copy, and if that write then won in Drive,
the other device lost what it had just saved. That is why the files are per device now: a bad
read can only make this device's own mirror smaller, never the other device's file.

The engine keeps a memory of the last cloud manifest it saw or wrote (refreshed on every sync and
dropped when the folder is forgotten or changed) and treats a bad read carefully:

* a read that finds nothing is retried once after a moment — the usual cause is exactly that lag;
* if the file is still invisible while the memory says it existed, the sync writes **nothing** and
  says so in the panel, rather than replacing the file with this device's copy;
* an entry the read did not show, and which has no tombstone, comes back from that memory, and so
  does a device record (`Odtworzone w pliku: n` in the panel when it happens);
* a memory older than the tombstone window restores nothing, so nothing is resurrected years later;
* an empty library with no file to read and no memory writes nothing at all.

Names follow the system, so the folder stays readable; a second device of the same system (two
Windows machines) detects that the plain name is taken and moves to
`pulsar-library-windows-<id>.json` instead of sharing it.

## How a device joins the library

Folder mode needs no Google Cloud project, no OAuth screen and no tester list — the app
asks the system file picker for a folder once and remembers it:

* **Android** — *Settings → Cloud → Choose folder*, pick the Drive folder. The app keeps
  all `pulsar-library*.json` files there through Storage Access Framework permissions.
* **Windows** — install *Google Drive for desktop*, let it sync (or mirror) a folder, then
  *Settings → Cloud → Choose folder* and pick that folder.
* **Linux** — mount or sync your Drive with `rclone`, `Insync`, `rclone bisync` or an
  overlay filesystem, then pick that local folder in the app.

The second device must pick the same folder, and the Drive client on each machine must have
finished its transfer. Sync is therefore near-real-time, not instant: the Drive client is
the one talking to Google, so what a device sees depends on when it last downloaded the
file.

Signing in with a Google account inside the app exists only on Android. Google no longer
allows the browser-based desktop flow, so on Windows and Linux the panel hides that option
and works with the folder instead (`supportsGoogle()` returns `false`).

## Rebuilding the desktop packages

The app itself is closed-source: `resources.neu` is a packed archive and its `index.html`
and `desktop.js` are never unpacked into the repository. The script does that in a scratch
directory, injects the layer and packs the archive back, so both platforms keep working
without touching the source of the app.

```bash
# inject into both packages (idempotent — running it again changes nothing)
python Pulsar-Sync/tools/build_desktop_sync.py

# only report whether a package already carries the layer
python Pulsar-Sync/tools/build_desktop_sync.py --check

# check the archives afterwards (checksums, script tags, runtime hooks, panel footholds)
python Pulsar-Sync/tools/test_desktop_bundle.py

# the downloadable archives have to carry the same layer as the folders
python Pulsar-Sync/tools/refresh_download_zips.py
```

What the script does inside the archive:

1. `resources/cloud-sync.js` — the desktop adapter, byte-for-byte copy of
   `desktop-cloud-sync.js`.
2. `resources/drive-sync.js` — the engine, byte-for-byte copy of `drive-sync.js`.
3. `resources/index.html` — two `<script>` lines right after `desktop.js`, adapter first
   (it registers before the engine starts).
4. The same runtime patches Android gets: `netId` and album/year are persisted, library
   changes emit `pulsar:library`, and the merge hooks are attached to the host API.
   The hook block is delimited by `/* ---- Cloud sync hooks … end cloud sync hooks ---- */`,
   so a package that already carries the patches still gets a **newer** `cloud_sync_hooks.js`;
   without that, a package built once kept its hooks frozen forever while every build reported
   "already patched".

Neutralino verifies a SHA-256 checksum for every file at startup, and `neu.py` recomputes
them, so nothing else in the archive may change — the script re-checks the untouched files
byte by byte before it writes the result.

## Android

`Pulsar-Android/tools/build_web_assets.py` reads the engine from this folder and applies
`cloud_runtime_patches.py`, so the Android copy of the runtime is generated from the same
source. The desktop-only `<script>` lines are stripped from the generated `www/index.html`,
which keeps one copy of the engine on the page.

## Checks

```bash
node Pulsar-Sync/tools/test_drive_sync.js          # 229 checks: engine, panel, plugins, desktop adapter
python Pulsar-Sync/tools/test_desktop_bundle.py    # 38 checks on the two packed archives
python Pulsar-Sync/tools/refresh_download_zips.py --check
node Pulsar-Android/tools/test_background_watchdog.js
```

The desktop adapter is tested for real: the suite loads `desktop-cloud-sync.js` into a VM
with a fake `Neutralino` filesystem, so picking a folder, writing the manifest, reading it
back on a second "computer" and reporting a write failure all go through the shipped code.
