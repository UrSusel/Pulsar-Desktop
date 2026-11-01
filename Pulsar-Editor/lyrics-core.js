/* Pulsar editor: word-synced lyrics parser (LRC + LRCLIB Lyricsfile 1.0 + Lyrics+). */
function pulsarLyricsTime(minutes, seconds, fraction){
  const frac = fraction ? parseInt(String(fraction).padEnd(3, '0'), 10) / 1000 : 0;
  return parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + frac;
}
function pulsarLyricsRound(value){ return Math.round(Number(value) * 1000) / 1000; }
function pulsarLyricsDurationMs(start, end, duration){
  const startMs = Number(start), endMs = Number(end), durationMs = Number(duration);
  const value = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : (Number.isFinite(endMs) && Number.isFinite(startMs) ? endMs - startMs : 0);
  return Number.isFinite(value) && value > 0 ? pulsarLyricsRound(value / 1000) : 0;
}

function pulsarEnhancedLrcLine(body, lineTime){
  const source = String(body || '');
  const re = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
  const tags = [];
  let match;
  while ((match = re.exec(source))){
    tags.push({ index: match.index, end: re.lastIndex, t: pulsarLyricsTime(match[1], match[2], match[3]) });
  }
  if (!tags.length) return { txt: source.trim(), words: null };
  let plain = '';
  const words = [];
  const prefix = source.slice(0, tags[0].index);
  if (prefix){
    plain += prefix;
    if (prefix.trim()) words.push({ t: pulsarLyricsRound(lineTime), txt: prefix });
  }
  tags.forEach(function(tag, index){
    const until = index + 1 < tags.length ? tags[index + 1].index : source.length;
    const text = source.slice(tag.end, until);
    plain += text;
    if (text) words.push({ t: pulsarLyricsRound(tag.t), txt: text });
  });
  const txt = plain.trim();
  if (!txt || !words.some(function(word){ return word.txt.trim(); })) return { txt: txt, words: null };
  if (words.map(function(word){ return word.txt; }).join('').trim() !== txt) return { txt: txt, words: null };
  return { txt: txt, words: words };
}

function parseLRC(text){
  const out = [];
  String(text || '').split(/\r?\n/).forEach(function(line){
    const stamps = [];
    let match;
    const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    while ((match = re.exec(line))) stamps.push(pulsarLyricsTime(match[1], match[2], match[3]));
    if (!stamps.length) return;
    const parsed = pulsarEnhancedLrcLine(line.replace(re, ''), stamps[0]);
    if (!parsed.txt) return;
    stamps.forEach(function(time){
      const item = { t: pulsarLyricsRound(time), txt: parsed.txt };
      if (parsed.words) item.words = parsed.words.map(function(word){ return { t: word.t, txt: word.txt }; });
      out.push(item);
    });
  });
  out.sort(function(a, b){ return a.t - b.t; });
  return out;
}

/* Strict reader for the small YAML subset emitted by LRCLIB. Unsupported YAML
 * returns [], so the caller can safely fall back to ordinary syncedLyrics. */
function parseLyricsfile(text){
  const source = String(text || '');
  if (!source || source.length > 256 * 1024) return [];
  const rows = source.split(/\r?\n/);
  if (rows.length > 12000) return [];
  const out = [];
  let inLines = false, inWords = false;
  let line = null, word = null, version = '';

  function scalar(raw){
    let value = String(raw || '').trim();
    if (!value) return '';
    if (value[0] === '"'){
      if (value.length < 2 || value[value.length - 1] !== '"') throw new Error('YAML_STRING');
      return JSON.parse(value);
    }
    if (value[0] === "'"){
      if (value.length < 2 || value[value.length - 1] !== "'") throw new Error('YAML_STRING');
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (/^[|>]/.test(value)) throw new Error('YAML_BLOCK_STRING');
    return value.replace(/\s+#.*$/, '').trim();
  }
  function milliseconds(raw){
    const value = scalar(raw);
    if (!/^\d{1,9}$/.test(value)) throw new Error('YAML_TIME');
    return Number(value);
  }
  function finishWord(){
    if (!word || !line) return;
    if (!word.hasText || !Number.isFinite(word.start)) throw new Error('YAML_WORD');
    const item = { t: pulsarLyricsRound(word.start / 1000), txt: word.text };
    const duration = pulsarLyricsDurationMs(word.start, word.end, word.duration);
    if (duration) item.d = duration;
    line.words.push(item);
    word = null;
  }
  function finishLine(){
    if (!line) return;
    finishWord();
    if (!line.hasText || !Number.isFinite(line.start)) throw new Error('YAML_LINE');
    const txt = line.text;
    if (txt.trim()){
      let words = line.words;
      if (words.length){
        let previous = -1;
        const ordered = words.every(function(item){ const ok = item.t >= previous; previous = item.t; return ok; });
        if (!ordered || words.map(function(item){ return item.txt; }).join('').trim() !== txt.trim()) words = [];
      }
      const item = { t: pulsarLyricsRound(line.start / 1000), txt: txt };
      const duration = pulsarLyricsDurationMs(line.start, line.end, line.duration);
      if (duration) item.d = duration;
      if (words.length) item.words = words;
      out.push(item);
    }
    line = null; word = null; inWords = false;
  }
  function assign(target, key, raw, isWord){
    if (key === 'text') { target.text = scalar(raw); target.hasText = true; }
    else if (key === 'start_ms') target.start = milliseconds(raw);
    else if (key === 'end_ms') target.end = milliseconds(raw);
    else if (key === 'duration_ms') target.duration = milliseconds(raw);
    else if (!isWord && key === 'words') {
      const value = String(raw || '').trim();
      if (value === '[]') inWords = false;
      else if (!value) inWords = true;
      else throw new Error('YAML_WORDS');
    } else throw new Error('YAML_FIELD');
  }

  try {
    rows.forEach(function(raw){
      const trimmed = raw.trim();
      if (!trimmed || trimmed[0] === '#' || trimmed === '---' || trimmed === '...') return;
      const top = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
      if (top){
        finishLine(); inLines = top[1] === 'lines'; inWords = false;
        if (top[1] === 'version') version = scalar(top[2] || '');
        return;
      }
      if (!inLines) return;
      let match = raw.match(/^  -(?:\s+(.*))?$/);
      if (match){
        finishLine(); line = { text: '', hasText: false, start: NaN, words: [] }; word = null; inWords = false;
        if (match[1]){
          const field = match[1].match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
          if (!field) throw new Error('YAML_LINE_ITEM');
          assign(line, field[1], field[2] || '', false);
        }
        return;
      }
      match = raw.match(/^      -(?:\s+(.*))?$/);
      if (match){
        if (!line || !inWords) throw new Error('YAML_WORD_ITEM');
        finishWord(); word = { text: '', hasText: false, start: NaN };
        if (match[1]){
          const field = match[1].match(/^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
          if (!field) throw new Error('YAML_WORD_FIELD');
          assign(word, field[1], field[2] || '', true);
        }
        return;
      }
      match = raw.match(/^    ([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
      if (match){
        if (!line) throw new Error('YAML_ORPHAN_LINE');
        if (match[1] !== 'words') { finishWord(); inWords = false; }
        assign(line, match[1], match[2] || '', false);
        return;
      }
      match = raw.match(/^        ([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
      if (match){
        if (!line || !word || !inWords) throw new Error('YAML_ORPHAN_WORD');
        assign(word, match[1], match[2] || '', true);
        return;
      }
      throw new Error('YAML_INDENT');
    });
    finishLine();
    if (version !== '1.0') return [];
    out.sort(function(a, b){ return a.t - b.t; });
    return out;
  } catch (e) {
    return [];
  }
}

/* Lyrics+ v2 returns source timestamps in milliseconds. "syllabus" may
 * contain words or timed parts of words; never invent missing timestamps. */
function parseLyricsPlus(payload){
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.lyrics)) return null;
  if (!payload.lyrics.length || payload.lyrics.length > 5000) return null;
  const type = String(payload.type || '');
  const timed = type === 'Line' || type === 'Word' || type === 'Syllable';
  if (!timed){
    const plain = payload.lyrics.map(function(line){ return String(line && line.text || ''); }).filter(function(text){ return !!text.trim(); });
    return plain.length ? { synced: null, plain: plain, wordSync: false } : null;
  }
  const out = [];
  let hasWords = false;
  payload.lyrics.forEach(function(line){
    if (!line || typeof line.time !== 'number' || !Number.isFinite(line.time) || line.time < 0) return;
    const words = [];
    if (type !== 'Line' && Array.isArray(line.syllabus)){
      line.syllabus.forEach(function(part, index, all){
        if (!part || typeof part.time !== 'number' || !Number.isFinite(part.time) || part.time < 0 || typeof part.text !== 'string' || !part.text) return;
        let text = part.text;
        // Background vocals may directly precede the main vocal without a space.
        if (part.isBackground && all[index + 1] && !/\s$/.test(text)) text += ' ';
        const item = { t: pulsarLyricsRound(part.time / 1000), txt: text };
        const duration = pulsarLyricsDurationMs(part.time, null, part.duration);
        if (duration) item.d = duration;
        words.push(item);
      });
    }
    const txt = (words.length ? words.map(function(word){ return word.txt; }).join('') : String(line.text || '')).trim();
    if (!txt) return;
    const item = { t: pulsarLyricsRound(line.time / 1000), txt: txt };
    const duration = pulsarLyricsDurationMs(line.time, null, line.duration);
    if (duration) item.d = duration;
    if (words.length){
      let previous = -1;
      const ordered = words.every(function(word){ const ok = word.t >= previous; previous = word.t; return ok; });
      if (ordered){ item.words = words; hasWords = true; }
    }
    out.push(item);
  });
  if (!out.length) return null;
  out.sort(function(a, b){ return a.t - b.t; });
  return { synced: out, plain: null, wordSync: hasWords };
}

if (typeof module === 'object' && module.exports){
  module.exports = { parseLRC: parseLRC, parseLyricsfile: parseLyricsfile, parseLyricsPlus: parseLyricsPlus };
}
