/*
 * Pulsar Editor — czysta logika cięcia audio i przeliczania napisów.
 * Moduł nie korzysta z DOM ani Neutralino, dzięki czemu może być testowany w Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulsarEditorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_CUT = 0.01;

  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, places) {
    const k = Math.pow(10, places == null ? 3 : places);
    return Math.round((value + Number.EPSILON) * k) / k;
  }

  /** Sortuje, przycina do utworu i scala nachodzące wycinki. */
  function normalizeCuts(cuts, duration) {
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('INVALID_DURATION');
    const sorted = (Array.isArray(cuts) ? cuts : []).map(function (cut) {
      const start = clamp(finite(cut && cut.start, NaN), 0, dur);
      const end = clamp(finite(cut && cut.end, NaN), 0, dur);
      return { start: start, end: end };
    }).filter(function (cut) {
      return Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end - cut.start >= MIN_CUT;
    }).sort(function (a, b) { return a.start - b.start || a.end - b.end; });

    const out = [];
    sorted.forEach(function (cut) {
      const last = out[out.length - 1];
      if (last && cut.start <= last.end + 0.000001) last.end = Math.max(last.end, cut.end);
      else out.push({ start: cut.start, end: cut.end });
    });
    return out;
  }

  /** Dopełnienie wycinków: fragmenty, które zostaną w nowym pliku. */
  function keptSegments(duration, cuts) {
    const dur = Number(duration);
    const normalized = normalizeCuts(cuts, dur);
    const out = [];
    let cursor = 0;
    normalized.forEach(function (cut) {
      if (cut.start - cursor >= MIN_CUT) out.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    });
    if (dur - cursor >= MIN_CUT) out.push({ start: cursor, end: dur });
    return out;
  }

  function editedDuration(duration, cuts) {
    return keptSegments(duration, cuts).reduce(function (sum, segment) {
      return sum + segment.end - segment.start;
    }, 0);
  }

  /**
   * Przelicza czas ze starej osi na nową. Zwraca null dla czasu wewnątrz
   * usuniętego zakresu. Koniec wycinka należy już do zachowanego materiału.
   */
  function mapTime(time, cuts, duration) {
    const value = Number(time);
    if (!Number.isFinite(value)) return null;
    const normalized = normalizeCuts(cuts, duration || Math.max(value, 1));
    let removed = 0;
    for (let i = 0; i < normalized.length; i++) {
      const cut = normalized[i];
      if (value >= cut.start && value < cut.end) return null;
      if (value >= cut.end) removed += cut.end - cut.start;
      else break;
    }
    return value - removed;
  }

  /** Zwraca nową tablicę; dodatnie przesunięcie opóźnia napisy. */
  function shiftLyrics(lines, offset) {
    const by = finite(offset, 0);
    return (Array.isArray(lines) ? lines : []).map(function (line) {
      return { t: round(Math.max(0, finite(line && line.t, 0) + by), 3), txt: String(line && line.txt || '') };
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /** Przesuwa linie bez utraty czasów słów i pozostałych metadanych. */
  function shiftLyricsDetailed(lines, offset, clamp) {
    const by = finite(offset, 0);
    const shifted = function (value) { const time = round(finite(value, 0) + by, 3); return clamp === false ? time : Math.max(0, time); };
    return (Array.isArray(lines) ? lines : []).map(function (line) {
      const copy = Object.assign({}, line, { t: shifted(line && line.t), txt: String(line && line.txt || '') });
      if (Array.isArray(line && line.words)) copy.words = line.words.map(function (word) {
        return Object.assign({}, word, { t: shifted(word && word.t) });
      });
      return copy;
    }).sort(function (a, b) { return a.t - b.t; });
  }

  function lyricsTextsInRange(lines, start, end, offset) {
    const from = finite(start, 0), to = finite(end, 0);
    if (!(to > from)) return [];
    return shiftLyricsDetailed(lines, offset).filter(function (line) { return line.t >= from && line.t < to && line.txt.trim(); }).map(function (line) { return line.txt.trim(); });
  }

  /** Scala wynik częściowego AI z zachowanymi liniami poza zakresem. */
  function mergeLyricsRange(lines, aligned, start, end, offset) {
    const from = finite(start, 0), to = finite(end, 0);
    if (!(to > from)) throw new Error('INVALID_LYRICS_RANGE');
    const kept = shiftLyricsDetailed(lines, offset).filter(function (line) { return line.t < from || line.t >= to; });
    const inserted = shiftLyricsDetailed(aligned, 0).filter(function (line) { return line.t >= from && line.t < to; });
    return kept.concat(inserted).sort(function (a, b) { return a.t - b.t; });
  }

  function firstLyricsTime(lines) {
    let first = Infinity;
    (Array.isArray(lines) ? lines : []).forEach(function (line) {
      const words = Array.isArray(line && line.words) ? line.words.filter(function (word) { return Number.isFinite(Number(word && word.t)); }) : [];
      if (words.length) first = Math.min(first, Number(words[0].t));
      else if (Number.isFinite(Number(line && line.t))) first = Math.min(first, Number(line.t));
    });
    return Number.isFinite(first) ? first : null;
  }

  /** Najpierw stosuje ręczne przesunięcie, potem skraca oś po wycięciach. */
  function remapLyrics(lines, cuts, offset, duration) {
    const by = finite(offset, 0);
    const normalized = normalizeCuts(cuts, duration);
    const out = [];
    (Array.isArray(lines) ? lines : []).forEach(function (line) {
      const original = finite(line && line.t, NaN);
      if (!Number.isFinite(original)) return;
      const mapped = mapTime(original + by, normalized, duration);
      if (mapped === null) return;
      out.push({ t: round(Math.max(0, mapped), 3), txt: String(line && line.txt || '') });
    });
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  function lrcTimestamp(seconds) {
    const centis = Math.max(0, Math.round(finite(seconds, 0) * 100));
    const minutes = Math.floor(centis / 6000);
    const secs = Math.floor((centis % 6000) / 100);
    const frac = centis % 100;
    return String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0') + '.' + String(frac).padStart(2, '0');
  }

  function formatLRC(lines) {
    return (Array.isArray(lines) ? lines : []).slice().sort(function (a, b) { return a.t - b.t; }).map(function (line) {
      return '[' + lrcTimestamp(line.t) + '] ' + String(line.txt || '').trim();
    }).join('\n') + ((lines && lines.length) ? '\n' : '');
  }

  /**
   * Wykrywa ciszę na próbkach PCM. Domyślnie: RMS poniżej -45 dB,
   * co najmniej 0,6 s, z niewielkim marginesem ochronnym na brzegach.
   */
  function detectSilence(buffer, options) {
    if (!buffer || !buffer.length || !buffer.sampleRate || !buffer.numberOfChannels) return [];
    const opts = options || {};
    const sr = buffer.sampleRate;
    const duration = buffer.length / sr;
    const threshold = finite(opts.threshold, Math.pow(10, finite(opts.db, -45) / 20));
    const minDuration = Math.max(0.1, finite(opts.minDuration, 0.6));
    const padding = Math.max(0, finite(opts.padding, 0.03));
    const blockSize = Math.max(1, Math.round(sr * finite(opts.window, 0.02)));
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));

    const silentBlocks = [];
    for (let start = 0; start < buffer.length; start += blockSize) {
      const end = Math.min(buffer.length, start + blockSize);
      let sum = 0;
      let count = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const data = channels[ch];
        for (let i = start; i < end; i++) {
          const sample = data[i] || 0;
          sum += sample * sample;
          count++;
        }
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      silentBlocks.push(rms < threshold);
    }

    const raw = [];
    let run = -1;
    for (let i = 0; i <= silentBlocks.length; i++) {
      if (silentBlocks[i] && run < 0) run = i;
      if (!silentBlocks[i] && run >= 0) {
        const start = run * blockSize / sr;
        const end = Math.min(duration, i * blockSize / sr);
        if (end - start >= minDuration) raw.push({ start: start, end: end });
        run = -1;
      }
    }
    return normalizeCuts(raw.map(function (cut) {
      return { start: cut.start + padding, end: cut.end - padding };
    }).filter(function (cut) { return cut.end - cut.start >= minDuration; }), duration);
  }

  /** Szczyty do rysowania fali — jedna wartość na koszyk. */
  function waveformPeaks(buffer, buckets) {
    if (!buffer || !buffer.length || !buffer.numberOfChannels) return new Float32Array(0);
    const count = Math.max(1, Math.min(buffer.length, Math.round(buckets || 1200)));
    const out = new Float32Array(count);
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
    for (let bucket = 0; bucket < count; bucket++) {
      const start = Math.floor(bucket * buffer.length / count);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * buffer.length / count));
      let peak = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const data = channels[ch];
        for (let i = start; i < end && i < buffer.length; i++) peak = Math.max(peak, Math.abs(data[i] || 0));
      }
      out[bucket] = peak;
    }
    return out;
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  /**
   * Skleja zachowane próbki i zapisuje WAV PCM 16-bit. Na wewnętrznych
   * łączeniach stosuje krótkie (5 ms) tłumienia, aby ograniczyć trzaski.
   * Zwraca ArrayBuffer gotowy do zapisu lub opakowania w Blob.
   */
  function renderCutWav(buffer, cuts, options) {
    if (!buffer || !buffer.length || !buffer.sampleRate || !buffer.numberOfChannels) throw new Error('INVALID_AUDIO_BUFFER');
    const sr = buffer.sampleRate;
    const duration = buffer.length / sr;
    const normalized = normalizeCuts(cuts, duration);
    const kept = keptSegments(duration, normalized);
    const channels = Math.max(1, buffer.numberOfChannels);
    const opts = options || {};
    const joinFadeFrames = Math.max(0, Math.round(sr * finite(opts.joinFadeMs != null ? opts.joinFadeMs : opts.fadeMs, 5) / 1000));
    const fadeInFrames = Math.max(0, Math.round(sr * finite(opts.fadeInMs, 0) / 1000));
    const fadeOutFrames = Math.max(0, Math.round(sr * finite(opts.fadeOutMs, 0) / 1000));
    const segments = kept.map(function (segment, index) {
      return {
        start: clamp(Math.round(segment.start * sr), 0, buffer.length),
        end: clamp(Math.round(segment.end * sr), 0, buffer.length),
        fadeIn: index > 0 ? joinFadeFrames : fadeInFrames,
        fadeOut: index < kept.length - 1 ? joinFadeFrames : fadeOutFrames
      };
    }).filter(function (segment) { return segment.end > segment.start; });
    const frames = segments.reduce(function (sum, segment) { return sum + segment.end - segment.start; }, 0);
    if (!frames) throw new Error('EMPTY_OUTPUT');
    const dataSize = frames * channels * 2;
    if (dataSize + 36 > 0xffffffff) throw new Error('WAV_TOO_LARGE');

    const output = new ArrayBuffer(44 + dataSize);
    const view = new DataView(output);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const data = [];
    for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
    let offset = 44;
    segments.forEach(function (segment) {
      const length = segment.end - segment.start;
      const fadeIn = Math.min(segment.fadeIn, Math.floor(length / 2));
      const fadeOut = Math.min(segment.fadeOut, Math.floor(length / 2));
      for (let frame = segment.start; frame < segment.end; frame++) {
        let gain = 1;
        if (fadeIn && frame < segment.start + fadeIn) gain = Math.min(gain, (frame - segment.start) / fadeIn);
        if (fadeOut && frame >= segment.end - fadeOut) gain = Math.min(gain, (segment.end - frame - 1) / fadeOut);
        for (let ch = 0; ch < channels; ch++) {
          const sample = clamp((data[ch][frame] || 0) * gain, -1, 1);
          view.setInt16(offset, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
          offset += 2;
        }
      }
    });
    return output;
  }

  function safeFileName(name) {
    const cleaned = String(name || 'utwor').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s{2,}/g, ' ').trim();
    return (cleaned || 'utwor').slice(0, 150);
  }

  /**
   * Argumenty natywnego eksportu FFmpeg. Ścieżki pozostają osobnymi
   * argumentami; warstwa desktopowa cytuje je dla Windows/POSIX.
   */
  function buildFfmpegArgs(options) {
    const opts = options || {};
    if (!opts.inputPath || !opts.outputPath) throw new Error('MISSING_PATH');
    const duration = finite(opts.duration, 0);
    const segments = Array.isArray(opts.segments) && opts.segments.length ? opts.segments.map(function (segment) {
      const start = Math.max(0, finite(segment && segment.start, 0));
      const end = Math.max(start, finite(segment && segment.end, start));
      return { start: start, end: end };
    }).filter(function (segment) { return segment.end - segment.start >= MIN_CUT; }) : (duration > 0 ? [{ start: 0, end: duration }] : []);
    if (!segments.length) throw new Error('EMPTY_OUTPUT');
    const format = /^(mp3|flac)$/i.test(String(opts.format)) ? String(opts.format).toLowerCase() : 'wav';
    const joinMs = Math.max(0, finite(opts.joinFadeMs != null ? opts.joinFadeMs : opts.fadeMs, 5));
    const firstMs = Math.max(0, finite(opts.fadeInMs, 0));
    const lastMs = Math.max(0, finite(opts.fadeOutMs, 0));
    const time = function (value) { return Math.max(0, value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0'); };
    const filters = [];
    const labels = [];
    segments.forEach(function (segment, index) {
      const length = segment.end - segment.start;
      const fadeIn = Math.min(index > 0 ? joinMs : firstMs, length * 500) / 1000;
      const fadeOut = Math.min(index < segments.length - 1 ? joinMs : lastMs, length * 500) / 1000;
      let chain = '[0:a]atrim=start=' + time(segment.start) + ':end=' + time(segment.end) + ',asetpts=PTS-STARTPTS';
      if (fadeIn > 0) chain += ',afade=t=in:st=0:d=' + time(fadeIn);
      if (fadeOut > 0) chain += ',afade=t=out:st=' + time(Math.max(0, length - fadeOut)) + ':d=' + time(fadeOut);
      const label = '[pae' + index + ']';
      filters.push(chain + label);
      labels.push(label);
    });
    filters.push(labels.join('') + 'concat=n=' + segments.length + ':v=0:a=1[out]');
    const args = ['-hide_banner', '-y', '-i', String(opts.inputPath), '-vn', '-filter_complex', filters.join(';'), '-map', '[out]'];
    if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '192k');
    else if (format === 'flac') args.push('-c:a', 'flac', '-compression_level', '5');
    else args.push('-c:a', 'pcm_s16le');
    if (opts.title) args.push('-metadata', 'title=' + String(opts.title));
    if (opts.artist) args.push('-metadata', 'artist=' + String(opts.artist));
    args.push(String(opts.outputPath));
    return args;
  }

  function editedFileName(name, suffix, format) {
    const base = String(name || 'utwor').replace(/\.[^.]+$/, '');
    const ext = /^(mp3|flac)$/i.test(String(format)) ? String(format).toLowerCase() : 'wav';
    return safeFileName(base + (suffix || ' (edycja)')) + '.' + ext;
  }

  return {
    MIN_CUT: MIN_CUT,
    normalizeCuts: normalizeCuts,
    keptSegments: keptSegments,
    editedDuration: editedDuration,
    mapTime: mapTime,
    shiftLyrics: shiftLyrics,
    shiftLyricsDetailed: shiftLyricsDetailed,
    lyricsTextsInRange: lyricsTextsInRange,
    mergeLyricsRange: mergeLyricsRange,
    firstLyricsTime: firstLyricsTime,
    remapLyrics: remapLyrics,
    formatLRC: formatLRC,
    lrcTimestamp: lrcTimestamp,
    detectSilence: detectSilence,
    waveformPeaks: waveformPeaks,
    renderCutWav: renderCutWav,
    buildFfmpegArgs: buildFfmpegArgs,
    safeFileName: safeFileName,
    editedFileName: editedFileName
  };
});
