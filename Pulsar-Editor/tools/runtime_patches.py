#!/usr/bin/env python3
"""Idempotentne zaczepy edytora w zamkniętym runtime index.html."""
from __future__ import annotations

import re
from pathlib import Path

EDITOR_DIR = Path(__file__).resolve().parents[1]
LYRICS_PARSER = "\n".join(
    ("  " + line) if line else line
    for line in (EDITOR_DIR / "lyrics-core.js").read_text(encoding="utf-8").splitlines()
).rstrip()

HELPER_BEGIN = "  /* ---- Pulsar editor: lyrics offset ---- */"
HELPER_END = "  /* ---- end Pulsar editor: lyrics offset ---- */"
API_BEGIN = "    /* ---- Pulsar editor: library bridge ---- */"
API_END = "    /* ---- end Pulsar editor: library bridge ---- */"

LYRICS_METHODS = '''      data: () => lyricsData, parse: parseLRC, parseWords: parseLyricsfile, parsePlus: parseLyricsPlus, fetchFor: i => fetchLyrics(tracks[i]),
      forTrack: id => { const tr = tracks.find(x => x.id === id); if (!tr) return null; return lyricsCache.has(id) ? lyricsCache.get(id) : (tr.lyricsData || null); },
      applyFor: (id, data, options) => applyGeneratedLyrics(id, data, !!(options && options.allowSourceWordSync)), resetFor: id => resetGeneratedLyrics(id),
      render: function(data){ if (data !== undefined) lyricsData = data; renderLyricsLines(); }, highlight: () => updateLyricsHighlight(true),
      offset: () => lyricsOffset(), setOffset: v => setLyricsOffset(v)
'''

LYRICS_HELPER = r'''  /* ---- Pulsar editor: lyrics offset ---- */
  function lyricsOffset(track){
    const tr = track || tracks[currentIndex];
    if (!tr) return 0;
    try {
      const raw = localStorage.getItem('playerLyricsOffset:' + tr.id);
      if (raw === null) return 0;
      const value = Number(raw);
      return isFinite(value) ? Math.max(-300, Math.min(300, value)) : 0;
    } catch(e){ return 0; }
  }
  function setLyricsOffset(value, track){
    const tr = track || tracks[currentIndex];
    if (!tr) return 0;
    const numeric = Number(value);
    const next = Math.round((isFinite(numeric) ? Math.max(-300, Math.min(300, numeric)) : 0) * 1000) / 1000;
    try { localStorage.setItem('playerLyricsOffset:' + tr.id, String(next)); } catch(e){}
    if (tracks[currentIndex] === tr){
      lyricsCurIdx = -1;
      updateLyricsHighlight(true);
    }
    try { document.dispatchEvent(new CustomEvent('pulsar:lyricsoffset', { detail: { trackId: tr.id, offset: next } })); } catch(e){}
    return next;
  }
  function applyGeneratedLyrics(id, data, allowSourceWordSync){
    const tr = tracks.find(function(x){ return x.id === id; });
    if (!tr || !data || !data.generated || !Array.isArray(data.synced) || !data.synced.length) throw new Error('Niepoprawny wynik AI');
    if (!data.synced.some(function(line){ return Array.isArray(line.words) && line.words.length; })) throw new Error('Wynik AI nie zawiera czasów słów');
    let previous = lyricsCache.has(id) ? lyricsCache.get(id) : tr.lyricsData;
    if (!previous){ try { previous = JSON.parse(localStorage.getItem('playerLyricsV2:' + id) || 'null'); } catch(e){} }
    if (!allowSourceWordSync && previous && !previous.generated && Array.isArray(previous.synced) && previous.synced.some(function(line){ return Array.isArray(line.words) && line.words.length; })){
      throw new Error('Zastąpienie źródłowych czasów słów wymaga ręcznego potwierdzenia');
    }
    data = Object.assign({}, data);
    delete data.previousLyrics;
    if (previous && previous.generated && previous.previousLyrics) data.previousLyrics = previous.previousLyrics;
    else if (previous && !previous.generated) data.previousLyrics = previous;
    tr.lyricsData = data;
    lyricsCache.set(id, data);
    try {
      const serialized = JSON.stringify(data);
      if (serialized.length < 300000) localStorage.setItem('playerLyricsV2:' + id, serialized);
      else localStorage.removeItem('playerLyricsV2:' + id);
    } catch(e){}
    persistTrack(tr);
    if (tracks[currentIndex] === tr){ lyricsData = data; lyricsCurIdx = -1; renderLyricsLines(); }
    return true;
  }
  async function resetGeneratedLyrics(id){
    const tr = tracks.find(function(x){ return x.id === id; });
    if (!tr) return null;
    const current = lyricsCache.has(id) ? lyricsCache.get(id) : tr.lyricsData;
    const backup = current && current.generated ? current.previousLyrics : null;
    if (backup && !backup.generated && (Array.isArray(backup.synced) || Array.isArray(backup.plain))){
      tr.lyricsData = backup;
      lyricsCache.set(id, backup);
      try { localStorage.setItem('playerLyricsV2:' + id, JSON.stringify(backup)); } catch(e){}
      persistTrack(tr);
      if (tracks[currentIndex] === tr){ lyricsData = backup; lyricsCurIdx = -1; renderLyricsLines(); }
      return backup;
    }
    tr.lyricsData = null;
    lyricsCache.delete(id);
    try { localStorage.removeItem('playerLyricsV2:' + id); } catch(e){}
    persistTrack(tr);
    if (tracks[currentIndex] === tr){
      lyricsData = null; lyricsCurIdx = -1; renderLyricsLines();
      return fetchLyrics(tr);
    }
    return true;
  }
  /* ---- end Pulsar editor: lyrics offset ---- */'''

LYRICS_RENDERER = r'''  /* Pulsar editor: word lyrics renderer */
  function lyricsWordDuration(line, index){
    const word = line.words[index];
    const own = Number(word && word.d);
    if (Number.isFinite(own) && own > 0) return own;
    const next = line.words[index + 1];
    if (next && Number(next.t) > Number(word.t)) return Number(next.t) - Number(word.t);
    const lineDuration = Number(line.d);
    if (Number.isFinite(lineDuration) && lineDuration > 0){
      const remaining = Number(line.t) + lineDuration - Number(word.t);
      if (remaining > 0) return remaining;
    }
    return 0;
  }
  function renderLyricsLines(){
    if (!lyricsBox) return;
    lyricsBox.hidden = !lyricsOn;
    if (document.body.classList) document.body.classList.toggle('lyrics-side', !!lyricsOn);
    lyricsBox.innerHTML = '';
    lyricsCurIdx = -1;
    if (!lyricsData){ lyricsBox.innerHTML = '<div class="lyrics-empty">Brak tekstu</div>'; return; }
    if (lyricsData.synced){
      lyricsData.synced.forEach(function(l, i){
        const d = document.createElement('div');
        d.className = 'lyrics-line'; d.dataset.i = String(i); d.dataset.t = String(l.t);
        if (Array.isArray(l.words) && l.words.length){
          d.classList.add('lyrics-line-words');
          l.words.forEach(function(word, wordIndex){
            const span = document.createElement('span');
            span.className = 'lyrics-word'; span.dataset.t = String(word.t); span.dataset.d = String(lyricsWordDuration(l, wordIndex)); span.textContent = word.txt;
            span.style.setProperty('--word-progress', '0%');
            d.appendChild(span);
          });
        } else d.textContent = l.txt;
        d.addEventListener('click', function(){ audio.currentTime = Math.max(0, l.t + lyricsOffset()); updateLyricsHighlight(true); });
        lyricsBox.appendChild(d);
      });
      updateLyricsHighlight(true);
      ensureLyricsWordClock();
    } else {
      (lyricsData.plain || []).forEach(function(txt){
        const d = document.createElement('div'); d.className = 'lyrics-line lyrics-plain'; d.textContent = txt;
        lyricsBox.appendChild(d);
      });
    }
  }
  function lyricsHasWords(){
    return !!(lyricsData && Array.isArray(lyricsData.synced) && lyricsData.synced.some(function(line){ return Array.isArray(line.words) && line.words.length; }));
  }
  var lyricsWordFrame = 0, lyricsWordLast = 0;
  function lyricsWordClock(timestamp){
    lyricsWordFrame = 0;
    if (!lyricsOn || audio.paused || !lyricsHasWords()) return;
    if (timestamp - lyricsWordLast >= 33){
      lyricsWordLast = timestamp;
      updateLyricsHighlight(false);
    }
    lyricsWordFrame = requestAnimationFrame(lyricsWordClock);
  }
  function ensureLyricsWordClock(){
    if (!lyricsWordFrame && lyricsOn && !audio.paused && lyricsHasWords()) lyricsWordFrame = requestAnimationFrame(lyricsWordClock);
  }
  audio.addEventListener('play', ensureLyricsWordClock);
  audio.addEventListener('seeked', function(){ updateLyricsHighlight(true); ensureLyricsWordClock(); });
  function updateLyricsHighlight(force){
    if (!lyricsOn || !lyricsData || !lyricsData.synced || !lyricsBox) return;
    const t = (audio.currentTime || 0) - lyricsOffset();
    const arr = lyricsData.synced;
    let idx = -1;
    for (let i = 0; i < arr.length; i++){ if (arr[i].t <= t + 0.05) idx = i; else break; }
    if (idx !== lyricsCurIdx || force){
      const prev = lyricsBox.querySelector('.lyrics-line.active');
      if (prev) prev.classList.remove('active');
      lyricsCurIdx = idx;
      if (idx >= 0){
        const el = lyricsBox.querySelector('.lyrics-line[data-i="' + idx + '"]');
        if (el){
          el.classList.add('active');
          if (typeof el.scrollIntoView === 'function'){ try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch(e){} }
        }
      }
    }
    if (idx < 0) return;
    const active = lyricsBox.querySelector('.lyrics-line[data-i="' + idx + '"]');
    if (!active || !active.classList.contains('lyrics-line-words')) return;
    active.querySelectorAll('.lyrics-word').forEach(function(span){
      const start = Number(span.dataset.t);
      let duration = Number(span.dataset.d);
      if (!(duration > 0)){
        // The last word often has no explicit end in Lyricsfile/enhanced LRC.
        // Bound it by the next real line, or by the real audio end for the final line.
        const nextLine = arr[idx + 1];
        const track = tracks[currentIndex];
        const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? Number(audio.duration) : Number(track && track.durMs) / 1000;
        const boundary = nextLine ? Number(nextLine.t) : mediaDuration - lyricsOffset();
        if (Number.isFinite(boundary) && boundary > start) duration = boundary - start;
      }
      let progress = 0;
      if (t >= start) progress = duration > 0 ? Math.max(0, Math.min(1, (t - start) / duration)) : 1;
      span.classList.toggle('sung', progress > 0);
      span.style.setProperty('--word-progress', String(Math.round(progress * 1000) / 10) + '%');
    });
  }
  /* end word-synced lyrics rendering */'''

LYRICSPLUS_BEGIN = "      /* ---- Pulsar editor: Lyrics+ fallback ---- */"
LYRICSPLUS_END = "      /* ---- end Pulsar editor: Lyrics+ fallback ---- */"
LYRICSPLUS_FALLBACK = r'''      /* ---- Pulsar editor: Lyrics+ fallback ---- */
      // LRCLIB stays first. Lyrics+ is consulted only when real word timing
      // is still missing; a lesser result never replaces better LRCLIB data.
      if (!data || !data.wordSync){
        let plusData = null;
        for (const c of cands){
          if (!c.artist) continue;
          const plusUrl = 'https://lyricsplus.prjktla.my.id/v2/lyrics/get?title=' + encodeURIComponent(c.title)
            + '&artist=' + encodeURIComponent(c.artist)
            + (track.album ? '&album=' + encodeURIComponent(track.album) : '')
            + (dur ? '&duration=' + dur : '');
          const hit = await netJson(plusUrl, 14000);
          const parsed = parseLyricsPlus(hit);
          if (parsed){
            const picked = hit && (hit.selectedSongMetadata || hit.processingTime && hit.processingTime.selectedSongMetadata);
            parsed.source = 'lyricsplus';
            parsed.provider = String(hit && hit.metadata && hit.metadata.source || picked && picked.source || '');
            parsed.sourceDuration = Number(picked && picked.duration || hit && hit.metadata && hit.metadata.duration) || 0;
            if (!plusData || (parsed.synced && !plusData.synced)) plusData = parsed;
            if (parsed.wordSync){ plusData = parsed; break; }
          }
        }
        if (plusData && (!data || (plusData.wordSync && !data.wordSync) || (!data.synced && plusData.synced))) data = plusData;
      }
      /* ---- end Pulsar editor: Lyrics+ fallback ---- */'''

WORD_STYLE_BEGIN = "  <!-- Pulsar editor: word lyrics styles -->"
WORD_STYLE_END = "  <!-- end Pulsar editor: word lyrics styles -->"
WORD_LYRICS_STYLE = '''  <!-- Pulsar editor: word lyrics styles -->
  <style>
  .lyrics-line .lyrics-word { color: inherit; }
  .lyrics-line.active .lyrics-word { color: rgba(255,255,255,.36); text-shadow: none; }
  .lyrics-line.active .lyrics-word.sung {
    background-image: linear-gradient(90deg, #fff 0%, #fff var(--word-progress, 100%), rgba(255,255,255,.36) var(--word-progress, 100%), rgba(255,255,255,.36) 100%);
    background-clip: text; -webkit-background-clip: text;
    color: transparent; -webkit-text-fill-color: transparent; text-shadow: none;
  }
  </style>
  <!-- end Pulsar editor: word lyrics styles -->'''

EDITOR_API = r'''    /* ---- Pulsar editor: library bridge ---- */
    __editor: {
      current: function(){
        const tr = tracks[currentIndex];
        if (!tr) return null;
        return {
          id: tr.id, index: currentIndex, file: tr.file, lrcFile: tr.lrcFile || null,
          title: tr.title || '', artist: tr.artist || '', srcPath: tr.srcPath || '',
          duration: isFinite(audio.duration) ? audio.duration : (Number(tr.durMs || 0) / 1000)
        };
      },
      importEdited: function(file, sourceId, opts){
        const source = tracks.find(function(x){ return x.id === sourceId; });
        if (!source || !file) return null;
        opts = opts || {};
        if (opts.path){ try { file.__srcPath = String(opts.path); } catch(e){} }
        const before = new Set(tracks.map(function(x){ return x.id; }));
        const files = [file];
        if (opts.lrcText){
          try { files.push(new File([String(opts.lrcText)], file.name.replace(/\.[^.]+$/, '') + '.lrc', { type: 'text/plain;charset=utf-8' })); } catch(e){}
        }
        addFilesToLibrary(files);
        const imported = tracks.find(function(x){ return !before.has(x.id) && x.file && x.file.name === file.name && x.file.size === file.size; });
        if (!imported) return null;
        imported.title = String(opts.title || ((source.title || file.name.replace(/\.[^.]+$/, '')) + ' (edycja)'));
        imported.artist = source.artist || imported.artist;
        imported.album = source.album || '';
        imported.year = source.year || '';
        imported.folder = source.folder || imported.folder;
        imported.coverBlob = source.coverBlob || source.matchedImg || null;
        imported.matchedImg = null;
        imported.coverUrl = imported.coverBlob ? URL.createObjectURL(imported.coverBlob) : null;
        imported.resolved = true;
        imported.srcPath = String(opts.path || '');
        imported.durMs = Math.round(Math.max(0, Number(opts.duration) || 0) * 1000);
        imported.netId = '';
        imported.netLink = '';
        if (opts.lyrics && Array.isArray(opts.lyrics.synced) && opts.lyrics.synced.length){
          const lines = opts.lyrics.synced.map(function(line){
            return { t: Math.max(0, Number(line && line.t) || 0), txt: String(line && line.txt || '') };
          }).sort(function(a, b){ return a.t - b.t; });
          imported.lyricsData = { synced: lines, plain: null, source: 'lrc' };
          lyricsCache.set(imported.id, imported.lyricsData);
        }
        persistTrack(imported);
        rebuildQueue();
        renderLibrary();
        return imported.id;
      }
    },
    /* ---- end Pulsar editor: library bridge ---- */'''


def _replace_block(html: str, begin: str, end: str, block: str, anchor: str, insert_before: bool = False) -> str:
    pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if pattern.search(html):
        return pattern.sub(lambda _: block, html, count=1)
    if html.count(anchor) != 1:
        raise ValueError(f"Nie znaleziono dokładnie jednego zaczepu: {anchor[:80]!r}")
    replacement = block + "\n" + anchor if insert_before else anchor + block + "\n"
    return html.replace(anchor, replacement, 1)


def _replace_section(html: str, start: str, end: str, block: str) -> str:
    # Akceptuj także jeden przejściowy build, w którym parser był bez wcięcia.
    alternate = start[2:] if start.startswith("  ") else start
    if html.count(start) == 1:
        pass
    elif alternate != start and html.count(alternate) == 1:
        start = alternate
    else:
        raise ValueError(f"Nie znaleziono jednoznacznej sekcji runtime: {start[:70]!r}")
    if html.count(end) != 1:
        raise ValueError(f"Nie znaleziono końca sekcji runtime: {end[:70]!r}")
    first = html.index(start)
    last = html.index(end, first + len(start))
    return html[:first] + block.rstrip() + "\n" + html[last:]


def _replace_named_section(html: str, marker: str, legacy_start: str, end: str, block: str) -> str:
    bare_marker = marker.lstrip()
    if bare_marker not in html:
        return _replace_section(html, legacy_start, end, block)
    # Od najwcześniejszego markera usuwamy także przejściowe duplikaty.
    first = html.index(bare_marker)
    first = html.rfind("\n", 0, first) + 1
    if html.count(end) != 1:
        raise ValueError(f"Nie znaleziono końca sekcji runtime: {end[:70]!r}")
    last = html.index(end, first + len(bare_marker))
    return html[:first] + block.rstrip() + "\n" + html[last:]


def _replace_once(html: str, old: str, new: str) -> str:
    if new in html:
        return html
    if html.count(old) != 1:
        raise ValueError(f"Zaczep runtime występuje {html.count(old)}x zamiast 1x: {old[:100]!r}")
    return html.replace(old, new, 1)


def _patch_lyrics_methods(html: str) -> str:
    """Wymienia cały ogon __lyrics, także w starszych/partialnych buildach."""
    owner = "    __lyrics: {\n"
    anchor = "      data: () => lyricsData, parse: parseLRC,"
    if html.count(owner) != 1 or html.count(anchor) != 1:
        raise ValueError("Nie znaleziono jednoznacznego API __lyrics")
    start = html.index(anchor, html.index(owner))
    end = html.index("    },", start)
    return html[:start] + LYRICS_METHODS + html[end:]


def apply_editor_runtime_patches(html: str) -> str:
    html = _replace_block(
        html, HELPER_BEGIN, HELPER_END, LYRICS_HELPER,
        "  const lyricsBox = document.getElementById('lyricsBox');\n",
    )
    html = _replace_block(html, API_BEGIN, API_END, EDITOR_API, "    __export:", insert_before=True)
    html = _replace_named_section(html, "  /* Pulsar editor: word-synced lyrics parser", "  function parseLRC(text){", "  function lyricsSetBox(html){", LYRICS_PARSER)
    html = _replace_block(html, WORD_STYLE_BEGIN, WORD_STYLE_END, WORD_LYRICS_STYLE, "</head>", insert_before=True)

    html = _replace_once(
        html,
        "d.addEventListener('click', function(){ audio.currentTime = l.t; updateLyricsHighlight(true); });",
        "d.addEventListener('click', function(){ audio.currentTime = Math.max(0, l.t + lyricsOffset()); updateLyricsHighlight(true); });",
    )
    html = _replace_once(
        html,
        "  function updateLyricsHighlight(force){\n    if (!lyricsOn || !lyricsData || !lyricsData.synced || !lyricsBox) return;\n    const t = audio.currentTime || 0;",
        "  function updateLyricsHighlight(force){\n    if (!lyricsOn || !lyricsData || !lyricsData.synced || !lyricsBox) return;\n    const t = (audio.currentTime || 0) - lyricsOffset();",
    )
    html = _replace_named_section(html, "  /* Pulsar editor: word lyrics renderer */", "  function renderLyricsLines(){", "  function refreshLyrics(track){", LYRICS_RENDERER)
    if "/* Pulsar editor: LRCLIB word sync */" not in html:
        html = _replace_once(
            html,
            "        if (hit.instrumental) return { synced: null, plain: ['(Instrumental)'], source: 'lrclib' };\n        if (hit.syncedLyrics){",
            "        if (hit.instrumental) return { synced: null, plain: ['(Instrumental)'], source: 'lrclib' };\n"
            "        /* Pulsar editor: LRCLIB word sync */\n"
            "        if (hit.hasWordSync && hit.lyricsfile){\n"
            "          const wordLines = parseLyricsfile(hit.lyricsfile);\n"
            "          if (wordLines.some(function(line){ return Array.isArray(line.words) && line.words.length; })) return { synced: wordLines, plain: null, source: 'lrclib', wordSync: true };\n"
            "        }\n"
            "        if (hit.syncedLyrics){",
        )
    html = _replace_once(
        html,
        "          if (wordLines.some(function(line){ return Array.isArray(line.words) && line.words.length; })) return { synced: wordLines, plain: null, source: 'lrclib', wordSync: true };",
        "          if (wordLines.some(function(line){ return Array.isArray(line.words) && line.words.length; })) return { synced: wordLines, plain: null, source: 'lrclib', wordSync: true, sourceDuration: Number(hit.duration) || 0 };",
    )
    html = _replace_once(
        html,
        "        if (hit.syncedLyrics){ const sv = parseLRC(hit.syncedLyrics); if (sv.length) return { synced: sv, plain: null, source: 'lrclib' }; }",
        "        if (hit.syncedLyrics){ const sv = parseLRC(hit.syncedLyrics); if (sv.length) return { synced: sv, plain: null, source: 'lrclib', sourceDuration: Number(hit.duration) || 0 }; }",
    )
    html = _replace_once(
        html,
        "        if (hit.plainLyrics){ const pl = String(hit.plainLyrics).split(/\\r?\\n/).filter(x => x.trim()); if (pl.length) return { synced: null, plain: pl, source: 'lrclib' }; }",
        "        if (hit.plainLyrics){ const pl = String(hit.plainLyrics).split(/\\r?\\n/).filter(x => x.trim()); if (pl.length) return { synced: null, plain: pl, source: 'lrclib', sourceDuration: Number(hit.duration) || 0 }; }",
    )
    html = _replace_once(
        html,
        "          for (let k = 0; k < Math.min(3, rs.length); k++){\n            data = pickFrom(rs[k]);",
        "          /* Pulsar editor: prefer LRCLIB word sync among the same three duration candidates */\n"
        "          const bestLyrics = rs.slice(0, 3).sort(function(a, b){ return Number(!!b.hasWordSync) - Number(!!a.hasWordSync); });\n"
        "          for (let k = 0; k < bestLyrics.length; k++){\n            data = pickFrom(bestLyrics[k]);",
    )
    html = _replace_block(
        html, LYRICSPLUS_BEGIN, LYRICSPLUS_END, LYRICSPLUS_FALLBACK,
        "    }\n    lyricsData = data;\n    lyricsCurIdx = -1;", insert_before=True,
    )
    html = _patch_lyrics_methods(html)
    html = _replace_once(
        html,
        "        srcPath: track.srcPath || '', // ścieżka oryginału na dysku — edytor tagów może go zaktualizować\n",
        "        srcPath: track.srcPath || '', // ścieżka oryginału na dysku — edytor tagów może go zaktualizować\n"
        "        lyricsData: track.lyricsData || null, // dopasowane napisy utworu zapisanego w edytorze audio\n",
    )
    html = _replace_once(
        html,
        "        fav: !!item.fav, plays: item.plays || 0, lastPlay: item.lastPlay || 0, srcPath: item.srcPath || '',\n",
        "        fav: !!item.fav, plays: item.plays || 0, lastPlay: item.lastPlay || 0, srcPath: item.srcPath || '',\n"
        "        lyricsData: item.lyricsData || null,\n",
    )
    # Ignore line-only cache entries written before the multi-source resolver.
    html = _replace_once(
        html,
        "localStorage.getItem('playerLyrics:' + track.id)",
        "localStorage.getItem('playerLyricsV2:' + track.id)",
    )
    html = _replace_once(
        html,
        "    if (!lyricsCache.has(track.id)){\n      try { const ser = localStorage.getItem('playerLyricsV2:' + track.id);",
        "    if (!lyricsCache.has(track.id) && track.lyricsData) lyricsCache.set(track.id, track.lyricsData);\n"
        "    if (!lyricsCache.has(track.id)){\n      try { const ser = localStorage.getItem('playerLyricsV2:' + track.id);",
    )
    html = _replace_once(
        html,
        "localStorage.setItem('playerLyrics:' + track.id, ser)",
        "localStorage.setItem('playerLyricsV2:' + track.id, ser)",
    )
    return html


def editor_runtime_patched(html: str) -> bool:
    needles = [
        HELPER_BEGIN, HELPER_END, API_BEGIN, API_END,
        "const t = (audio.currentTime || 0) - lyricsOffset();",
        "audio.currentTime = Math.max(0, l.t + lyricsOffset())",
        "offset: () => lyricsOffset(), setOffset: v => setLyricsOffset(v)",
        "forTrack: id => { const tr = tracks.find(x => x.id === id)",
        "applyFor: (id, data, options) => applyGeneratedLyrics(id, data, !!(options && options.allowSourceWordSync))",
        "if (!allowSourceWordSync && previous && !previous.generated",
        "resetFor: id => resetGeneratedLyrics(id)",
        "lyricsData: track.lyricsData || null",
        "lyricsData: item.lyricsData || null",
        "track.lyricsData) lyricsCache.set(track.id, track.lyricsData)",
        "Pulsar editor: word-synced lyrics parser",
        "Pulsar editor: word lyrics renderer",
        "function lyricsWordDuration(line, index)",
        "span.style.setProperty('--word-progress', '0%')",
        "const boundary = nextLine ? Number(nextLine.t) : mediaDuration - lyricsOffset();",
        "background-clip: text; -webkit-background-clip: text;",
        "Pulsar editor: LRCLIB word sync",
        "Pulsar editor: prefer LRCLIB word sync",
        LYRICSPLUS_BEGIN,
        LYRICSPLUS_END,
        WORD_STYLE_BEGIN,
        WORD_STYLE_END,
        "parseWords: parseLyricsfile",
        "parsePlus: parseLyricsPlus",
    ]
    return all(html.count(needle) == 1 for needle in needles) and html.count("playerLyricsV2:") >= 2
