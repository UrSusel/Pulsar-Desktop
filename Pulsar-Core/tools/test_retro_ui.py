#!/usr/bin/env python3
"""Regression checks for the cross-platform retro player layout and controls."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
THEMES = {"classic", "green", "pink", "amber", "metal"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check(platform: str) -> None:
    source = (ROOT / "Pulsar-Core" / platform / "resources" / "index.html").read_text(encoding="utf-8")

    require('id="smRetroTheme"' in source, f"{platform}: theme selector is missing")
    require("localStorage.setItem('playerRetroTheme', chosen)" in source,
            f"{platform}: selected theme is not persisted")
    require("document.body.dataset.retroTheme = chosen" in source,
            f"{platform}: theme selection is not applied to the document")
    require("body.retro-mode { --retro-cyan:" in source,
            f"{platform}: missing classic retro theme styling")
    require('body.retro-mode:not([data-retro-layout="compact"]) #fullscreenBtn { display:none !important; }' in source,
            f"{platform}: fullscreen button is still visible in Pulsar Classic")
    for theme in THEMES - {"classic"}:
        require(f'data-retro-theme="{theme}"' in source,
                f"{platform}: missing retro theme styling for {theme}")

    retro_tick = re.search(r"function resetHideTimer\(\)\s*\{(.*?)\n  \}", source, re.S)
    require(retro_tick is not None and
            "if (document.body.classList.contains('retro-mode')) return;" in retro_tick.group(1),
            f"{platform}: retro playback bar can still be auto-hidden")
    require("body.retro-mode .bottombar.hidden { transform: none; opacity: 1; pointer-events: auto; }" in source,
            f"{platform}: retro control bar hidden styling is not overridden")

    track_click = re.search(
        r"li\.addEventListener\('click', \(\) => \{(.*?)\n      \}\);\n      trackListEl\.appendChild\(li\);",
        source, re.S)
    require(track_click is not None and
            "if (!document.body.classList.contains('retro-mode')) closeLibrary();" in track_click.group(1),
            f"{platform}: selecting a track closes the retro library")
    album_play = re.search(r"function playAlbumFrom\(album, withShuffle\)\s*\{(.*?)\n  \}", source, re.S)
    require(album_play is not None and
            "if (!document.body.classList.contains('retro-mode')) closeLibrary();" in album_play.group(1),
            f"{platform}: playing an album closes the retro library")

    require("overflow-x: clip" in source and
            "body.retro-mode .player::-webkit-scrollbar { display: none; width: 0; height: 0; }" in source,
            f"{platform}: cover display can show a horizontal scrollbar")
    require("width: min(100%, 180px)" in source,
            f"{platform}: retro cover display artwork is not compact")
    require("grid-template-columns:repeat(auto-fill,minmax(136px,160px))" in source and
            "max-width:144px" in source,
            f"{platform}: album artwork cards are not constrained to a compact size")
    require("body.retro-mode .cover-display-stack .volume-wrap { position:relative; left:auto; top:auto;" in source,
            f"{platform}: retro volume control is not positioned beneath the track metadata")
    require("body.retro-mode .library-toolbar { display:grid; grid-template-columns:repeat(auto-fit,minmax(108px,1fr));" in source,
            f"{platform}: retro library toolbar remains oversized")
    require("body.retro-mode .bpm-chip { display: none !important; }" in source,
            f"{platform}: BPM badge remains visible in retro mode")
    stack_markup = source.find('<div class="cover-display-stack" id="coverDisplayStack">')
    require(stack_markup >= 0 and
            stack_markup < source.find('id="coverWrap"', stack_markup) <
            source.find('id="lyricsBox"', stack_markup) <
            source.find('id="centerSeekRow"', stack_markup),
            f"{platform}: cover art and lyrics are not arranged in a single vertical stack")
    require("body.retro-mode .cover-display-stack > #lyricsBox," in source and
            "position:static !important;" in source,
            f"{platform}: retro lyrics can overlay the cover art")
    require("body.retro-mode .cover-display-stack > #coverWrap { position:relative !important;" in source and
            "visibility:visible !important;" in source,
            f"{platform}: cover art can disappear when retro lyrics are enabled")
    volume_markup = source.find('class="volume-wrap"', stack_markup)
    stack_end = source.find('\n    </div>\n\n    <div class="center-seek-row"', stack_markup)
    require(stack_markup < source.find('id="trackArtist"', stack_markup) < volume_markup < stack_end,
            f"{platform}: volume control is not under the current track information")
    require("function syncRetroVolumeDock()" in source and
            "retroVolumeWrap.parentElement !== destination" in source and
            "document.body.dataset.retroLayout !== 'compact'" in source,
            f"{platform}: volume control does not move between classic, Compact Retro, and normal layouts")
    require("body.retro-mode .cover-display-stack .volume-wrap { position:relative; left:auto; top:auto;" in source and
            "body.retro-mode .cover-display-stack .vol-bar { position:relative; flex:1 1 auto; width:auto;" in source and
            "body.retro-mode .cover-display-stack .vol-bar .seek-fill { top:0; height:100%; border-radius:4px;" in source,
            f"{platform}: retro volume is not boxed and positioned beneath the metadata")
    require('body.retro-mode[data-retro-layout="compact"] .cover-display-stack { display:none !important; }' in source,
            f"{platform}: cover/lyrics stack overflows the compact retro deck")
    require('data-retro-layout="compact"' in source and 'id="smRetroLayoutCompact"' in source and
            '>Compact Retro</button>' in source,
            f"{platform}: Compact Retro layout option is missing")
    legacy_brand = "win" + "amp"
    require(legacy_brand not in source.lower(),
            f"{platform}: legacy third-party product branding remains in the retro layout")
    require('id="smRetroLayoutClassic"' in source and
            "localStorage.setItem('playerRetroLayoutV2', chosen)" in source,
            f"{platform}: retro layout options are not persisted")
    require("body.retro-mode[data-retro-layout=\"compact\"] .library-panel { position:fixed; top:211px;" in source,
            f"{platform}: Compact Retro playlist is not compactly docked under its player")
    require(".bb-left { grid-column:1; grid-row:1; gap:7px; min-width:0; padding-right:114px; }" in source and
            "body.retro-mode[data-retro-layout=\"compact\"] .bb-meta { flex:1 1 0; width:0; min-width:0; }" in source,
            f"{platform}: Compact Retro track title does not reserve space for the top-right buttons")
    require('id="retroWallpaperBtn"' not in source and 'retro-wallpaper-layer' not in source,
            f"{platform}: the mistaken desktop-screen button is still present")
    require('not(#ambientStyleBtn)' in source and
            'body.retro-mode[data-retro-layout="compact"] .bb-right > #ambientStyleBtn' in source and
            'right:89px; width:24px; height:22px;' in source,
            f"{platform}: Compact Retro does not expose the 3D visual-style button")
    require("const compactRetro = document.body.classList.contains('retro-mode') && document.body.dataset.retroLayout === 'compact';" in source and
            "threeDMode || compactRetro" in source,
            f"{platform}: the 3D style button is unavailable while Compact Retro is active")
    require("document.body.classList.add('three-d-mode');" in source and
            "localStorage.setItem('threeDMode', 'true')" in source,
            f"{platform}: the Compact Retro 3D button does not enable the GPU background itself")
    require('body.retro-mode:not([data-retro-layout="compact"]) .player { left:50%;' not in source and
            'position: fixed; top: 164px; bottom: 22px; left: 24px; right: auto;' in source and
            'width: min(330px, calc(39vw - 28px))' in source,
            f"{platform}: the original non-fullscreen Classic player placement was not restored")
    require('body.retro-mode.fullscreen-mode .bottombar { display:none !important; }' in source and
            'body.retro-mode.fullscreen-mode .player > .center-seek-row { left:auto !important;' in source and
            'body.retro-mode.fullscreen-mode .ambient-3d-canvas { z-index:0; }' in source,
            f"{platform}: fullscreen Classic still shows the dock, shifts the seek bar, or hides the 3D canvas")
    fullscreen = re.search(r"function setFullscreen\(on\)\{([\s\S]*?)\n  \}", source)
    require(fullscreen is not None and
            'if (entering && retroStyleOn && !threeDMode && ambientVisual)' in fullscreen.group(1) and
            "document.body.classList.add('three-d-mode')" in fullscreen.group(1) and
            'fullscreenForcedThreeD' in fullscreen.group(1),
            f"{platform}: Classic full-screen does not temporarily enable and restore its 3D background")
    for theme, accent in (("green", "--accent:#8dff72"), ("pink", "--accent:#ff71cf"),
                          ("amber", "--accent:#ffc653"), ("metal", "--accent:#c4ccd2")):
        require(f'data-retro-theme="{theme}"' in source and accent in source,
                f"{platform}: {theme} theme does not propagate its color through the UI")
    print(f"{platform}: retro layout/theme regressions passed")


if __name__ == "__main__":
    for target in ("Linux", "Windows"):
        check(target)
