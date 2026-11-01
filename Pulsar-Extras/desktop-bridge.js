/* Pulsar Desktop — wspólny, natywny mostek FFmpeg, lokalnego AI i systemu plików. */
(function () {
  'use strict';

  const api = { available: false };
  window.__pulsarDesktopTools = api;
  if (typeof Neutralino === 'undefined') return;

  const APP_DIR = (typeof NL_PATH === 'string' && NL_PATH) ? NL_PATH : '.';
  const WINDOWS = /win/i.test(String(window.NL_OS || navigator.platform || navigator.userAgent || ''));
  let tmpDir = '';
  let ffmpegPath;
  let commandChain = Promise.resolve();

  function join(a, b) { return String(a || '').replace(/[\\/]+$/, '') + '/' + String(b || '').replace(/^[\\/]+/, ''); }
  function baseName(path) { const parts = String(path || '').split(/[\\/]/); return parts[parts.length - 1] || ''; }
  function extension(path) { const m = /\.([a-z0-9]+)$/i.exec(String(path || '')); return m ? m[1].toLowerCase() : ''; }
  function uuid() { return 'pulsar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
  function asBuffer(data) { return ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data; }
  function resultOf(result) {
    return {
      stdout: String((result && (result.stdOut != null ? result.stdOut : result.stdout)) || ''),
      stderr: String((result && (result.stdErr != null ? result.stdErr : result.stderr)) || '').trim(),
      code: result && typeof result.exitCode === 'number' ? result.exitCode : 0
    };
  }
  function quote(value) {
    const text = String(value == null ? '' : value);
    return WINDOWS ? '"' + text.replace(/["\r\n]/g, "'") + '"' : "'" + text.replace(/'/g, "'\\''") + "'";
  }
  function run(command, timeout) {
    const limit = Math.max(1000, Number(timeout) || 240000);
    const job = commandChain.then(function () {
      return Promise.race([
        Neutralino.os.execCommand(command),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('Przekroczono limit czasu polecenia')); }, limit); })
      ]);
    });
    commandChain = job.catch(function () {});
    return job;
  }
  async function stats(path) { return Neutralino.filesystem.getStats(path); }
  async function exists(path) { if (!path) return false; try { return !!(await stats(path)); } catch (e) { return false; } }
  async function mkdir(path) { try { await Neutralino.filesystem.createDirectory(path); } catch (e) {} return exists(path); }
  async function env(names) {
    for (const name of names) {
      try { const value = await Neutralino.os.getEnv(name); if (value && String(value).trim()) return String(value).trim(); } catch (e) {}
    }
    return '';
  }
  async function getTmp() {
    if (tmpDir) return tmpDir;
    const root = await env(WINDOWS ? ['TEMP', 'TMP'] : ['TMPDIR', 'XDG_CACHE_HOME', 'HOME']);
    tmpDir = join(root || join(APP_DIR, 'tmp'), 'pulsar-editor');
    await mkdir(tmpDir);
    return tmpDir;
  }
  async function tempFile(ext) { return join(await getTmp(), uuid() + '.' + String(ext || 'tmp').replace(/[^a-z0-9]/gi, '')); }
  async function resolveFfmpeg(force) {
    if (!force && ffmpegPath !== undefined) return ffmpegPath;
    const local = join(APP_DIR, WINDOWS ? 'ffmpeg.exe' : 'ffmpeg');
    if (await exists(local)) { ffmpegPath = local; return local; }
    try {
      const result = resultOf(await run(WINDOWS ? 'where ffmpeg' : 'command -v ffmpeg', 8000));
      const found = result.stdout.trim().split(/\r?\n/)[0].trim();
      ffmpegPath = result.code === 0 && found ? found : null;
    } catch (e) { ffmpegPath = null; }
    return ffmpegPath;
  }
  async function capabilities(force) {
    const ffmpeg = await resolveFfmpeg(!!force);
    return { available: true, ffmpeg: !!ffmpeg, ffmpegPath: ffmpeg || '', platform: WINDOWS ? 'windows' : 'linux' };
  }
  async function writeBlob(path, blob) {
    await Neutralino.filesystem.writeBinaryFile(path, new ArrayBuffer(0));
    for (let offset = 0; offset < blob.size; offset += 8388608) {
      const bytes = await blob.slice(offset, Math.min(blob.size, offset + 8388608)).arrayBuffer();
      await Neutralino.filesystem.appendBinaryFile(path, bytes);
    }
    return path;
  }
  async function exportAudio(job) {
    if (!job || !job.outputPath) throw new Error('Nie wybrano pliku docelowego');
    const ffmpeg = await resolveFfmpeg(false);
    if (!ffmpeg) throw new Error('FFmpeg nie jest dostępny');
    if (!window.PulsarEditorCore) throw new Error('Brak modułu eksportu');
    let input = String(job.inputPath || '');
    let temporary = '';
    if (!input) {
      if (!job.inputBlob) throw new Error('Brak źródła audio');
      input = temporary = await tempFile(extension(job.inputName) || 'audio');
      await writeBlob(input, job.inputBlob);
    }
    try {
      const args = window.PulsarEditorCore.buildFfmpegArgs(Object.assign({}, job, { inputPath: input }));
      const command = quote(ffmpeg) + ' ' + args.map(quote).join(' ');
      const result = resultOf(await run(command, Math.max(300000, Number(job.timeout) || 3600000)));
      if (result.code !== 0) throw new Error(result.stderr.split(/\r?\n/).slice(-4).join(' ') || ('FFmpeg zakończył kodem ' + result.code));
      const stat = await stats(input === job.outputPath ? '' : job.outputPath);
      if (!stat || !stat.size) throw new Error('FFmpeg nie utworzył pliku wynikowego');
      return { path: job.outputPath, size: stat.size, native: true, ffmpeg: ffmpeg };
    } finally {
      if (temporary) { try { await Neutralino.filesystem.remove(temporary); } catch (e) {} }
    }
  }
  const AI_PACKAGES = ['stable-ts[fw]==2.19.1', 'faster-whisper==1.2.1', 'av>=12,<19'];
  let aiRoot = '';
  let systemPython;
  function aiError(message, code) { const error = new Error(message); if (code) error.code = code; return error; }
  function progressOf(callback, stage) { if (typeof callback === 'function') { try { callback(stage); } catch (e) {} } }
  async function getAiRoot() {
    if (aiRoot) return aiRoot;
    let home = '';
    if (WINDOWS) home = await env(['LOCALAPPDATA', 'USERPROFILE']);
    else {
      home = await env(['XDG_CACHE_HOME']);
      if (!home) { const userHome = await env(['HOME']); if (userHome) home = join(userHome, '.cache'); }
    }
    aiRoot = join(home || await getTmp(), WINDOWS ? 'Pulsar/LyricsAI' : 'pulsar/lyrics-ai');
    await mkdir(aiRoot);
    return aiRoot;
  }
  function aiPython(root) { return join(join(root, 'env'), WINDOWS ? 'Scripts/python.exe' : 'bin/python'); }
  async function resolveSystemPython() {
    if (systemPython !== undefined) return systemPython;
    const candidates = WINDOWS ? ['py -3', 'python', 'python3'] : ['python3', 'python'];
    for (const candidate of candidates) {
      try {
        const result = resultOf(await run(candidate + ' -c ' + quote('import sys;assert sys.version_info >= (3,10);print(sys.executable)'), 15000));
        const found = result.stdout.trim().split(/\r?\n/)[0].trim();
        if (result.code === 0 && found) { systemPython = found; return found; }
      } catch (e) {}
    }
    systemPython = null;
    return null;
  }
  async function materializeAiHelper(root) {
    const response = await fetch('lyrics-aligner.py', { cache: 'no-store' });
    if (!response.ok) throw new Error('Nie można odczytać modułu AI z zasobów Pulsara');
    const source = await response.text();
    const path = join(root, 'lyrics-aligner.py');
    await Neutralino.filesystem.writeFile(path, source);
    return path;
  }
  async function checkAiEnvironment(root, python, helper) {
    const result = resultOf(await run(quote(python) + ' ' + quote(helper) + ' --check', 120000));
    return { result: result, ok: result.code === 0 && /"ok"\s*:\s*true/.test(result.stdout) };
  }
  async function ensureAiEnvironment(install, onProgress) {
    const root = await getAiRoot();
    const helper = await materializeAiHelper(root);
    let python = aiPython(root);
    if (!await exists(python)) {
      if (!install) throw aiError('Środowisko AI nie jest jeszcze zainstalowane', 'AI_SETUP_REQUIRED');
      const system = await resolveSystemPython();
      if (!system) throw new Error(WINDOWS
        ? 'Zainstaluj Python 3.10 lub nowszy z python.org i zaznacz „Add Python to PATH”, potem spróbuj ponownie'
        : 'Zainstaluj pakiety python3 i python3-venv, potem spróbuj ponownie');
      progressOf(onProgress, 'python');
      const made = resultOf(await run(quote(system) + ' -m venv ' + quote(join(root, 'env')), 180000));
      if (made.code !== 0 || !await exists(python)) {
        throw new Error(made.stderr.split(/\r?\n/).slice(-3).join(' ') || 'Nie można utworzyć środowiska Python');
      }
    }
    let check = await checkAiEnvironment(root, python, helper);
    if (!check.ok && install) {
      progressOf(onProgress, 'install');
      // A previous interrupted setup can leave python.exe without Scripts/pip.exe.
      // Use the interpreter that already passed --check and bootstrap pip if needed.
      const pipReady = resultOf(await run(quote(python) + ' -m pip --version', 30000));
      if (pipReady.code !== 0) {
        const bootstrapped = resultOf(await run(quote(python) + ' -m ensurepip --upgrade', 180000));
        if (bootstrapped.code !== 0) {
          throw new Error('Nie można przygotować pip w środowisku AI: ' + (bootstrapped.stderr.split(/\r?\n/).slice(-3).join(' ') || ('kod ' + bootstrapped.code)));
        }
      }
      const installed = resultOf(await run(quote(python) + ' -m pip install --disable-pip-version-check ' + AI_PACKAGES.map(quote).join(' '), 3600000));
      if (installed.code !== 0) {
        throw new Error('Instalacja AI nie powiodła się: ' + (installed.stderr.split(/\r?\n/).slice(-4).join(' ') || ('kod ' + installed.code)));
      }
      check = await checkAiEnvironment(root, python, helper);
    }
    if (!check.ok) {
      throw aiError('Moduły AI nie są gotowe: ' + (check.result.stderr.split(/\r?\n/).slice(-2).join(' ') || 'wymagana instalacja'), 'AI_SETUP_REQUIRED');
    }
    return { root: root, python: python, helper: helper };
  }
  async function lyricsAiCapabilities() {
    try {
      const root = await getAiRoot();
      const python = aiPython(root);
      if (!await exists(python)) {
        return { available: true, ready: false, needsInstall: true, model: 'base', platform: WINDOWS ? 'windows' : 'linux' };
      }
      const helper = await materializeAiHelper(root);
      const check = await checkAiEnvironment(root, python, helper);
      return {
        available: true, ready: check.ok, needsInstall: !check.ok, model: 'base',
        platform: WINDOWS ? 'windows' : 'linux',
        error: check.ok ? '' : check.result.stderr.split(/\r?\n/).slice(-2).join(' ')
      };
    } catch (error) {
      return { available: true, ready: false, needsInstall: true, model: 'base', error: String(error && error.message || error) };
    }
  }
  function aiTextKey(value) { return String(value || '').replace(/\s+/g, ''); }
  function normalizeAiResult(raw, job) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.lines) || !raw.lines.length) throw new Error('AI zwróciło niepoprawny wynik');
    const lines = [];
    for (const item of raw.lines) {
      if (!item || typeof item.t !== 'number' || !Number.isFinite(item.t) || item.t < 0 || typeof item.txt !== 'string' || !item.txt.trim()) continue;
      const line = { t: Math.round(Number(item.t) * 1000) / 1000, txt: item.txt };
      if (typeof item.d === 'number' && Number.isFinite(item.d) && item.d > 0) line.d = Math.round(item.d * 1000) / 1000;
      if (Array.isArray(item.words) && item.words.length) {
        let previous = -1;
        const words = [];
        for (const word of item.words) {
          if (!word || typeof word.t !== 'number' || !Number.isFinite(word.t) || word.t < previous || word.t < 0 || typeof word.txt !== 'string' || !word.txt) { words.length = 0; break; }
          previous = Number(word.t);
          const normalized = { t: Math.round(previous * 1000) / 1000, txt: word.txt };
          if (typeof word.d === 'number' && Number.isFinite(word.d) && word.d > 0) normalized.d = Math.round(word.d * 1000) / 1000;
          words.push(normalized);
        }
        if (words.length && aiTextKey(words.map(function (word) { return word.txt; }).join('')) === aiTextKey(line.txt)) line.words = words;
      }
      lines.push(line);
    }
    lines.sort(function (a, b) { return a.t - b.t; });
    const wordCount = lines.reduce(function (sum, line) { return sum + (line.words ? line.words.length : 0); }, 0);
    const expected = (job.lines || []).reduce(function (sum, text) { return sum + String(text || '').trim().split(/\s+/).filter(Boolean).length; }, 0);
    const coverage = Math.min(1, wordCount / Math.max(1, expected));
    if (!lines.length || !wordCount) throw new Error('AI nie wyznaczyło wiarygodnych czasów słów');
    if (coverage < 0.4) throw new Error('AI dopasowało zbyt małą część tekstu — wynik odrzucono');
    return {
      synced: lines, plain: null, source: 'ai', provider: 'Pulsar AI · Stable-TS',
      wordSync: true, generated: true, experimental: true,
      engine: 'stable-ts', backend: 'faster-whisper', model: String(raw.model || job.model || 'base'),
      language: String(raw.language || job.language || ''), coverage: Math.round(coverage * 1000) / 1000,
      meanProbability: typeof raw.mean_probability === 'number' && Number.isFinite(raw.mean_probability) ? raw.mean_probability : null,
      duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : null,
      alignmentRange: Number.isFinite(job.audioStart) && Number.isFinite(job.audioEnd) ? { start: job.audioStart, end: job.audioEnd } : null,
      generatedAt: new Date().toISOString()
    };
  }
  async function alignLyrics(job, onProgress) {
    if (!job || !Array.isArray(job.lines) || !job.lines.some(function (line) { return String(line || '').trim(); })) throw new Error('Brak tekstu do dopasowania');
    if (job.hasSourceWordSync && !job.allowSourceWordSync) throw new Error('Zastąpienie źródłowego word-sync wymaga ręcznego potwierdzenia');
    const partial = job.audioStart != null || job.audioEnd != null;
    if (partial && (!Number.isFinite(job.audioStart) || !Number.isFinite(job.audioEnd) || job.audioStart < 0 || job.audioEnd <= job.audioStart)) throw new Error('Niepoprawny zakres dopasowania');
    progressOf(onProgress, 'prepare');
    const setup = await ensureAiEnvironment(true, onProgress);
    let input = String(job.inputPath || '');
    let temporary = '';
    const requestPath = await tempFile('json');
    const outputPath = await tempFile('json');
    if (!input) {
      if (!job.inputBlob) throw new Error('Brak źródła audio');
      input = temporary = await tempFile(extension(job.inputName) || 'audio');
      await writeBlob(input, job.inputBlob);
    }
    try {
      const modelRoot = join(setup.root, 'models');
      await mkdir(modelRoot);
      const request = {
        audio_path: input, lines: job.lines, language: job.language,
        model: job.model || 'base', model_root: modelRoot
      };
      if (partial) { request.audio_start = job.audioStart; request.audio_end = job.audioEnd; }
      await Neutralino.filesystem.writeFile(requestPath, JSON.stringify(request));
      progressOf(onProgress, 'align');
      const command = quote(setup.python) + ' ' + quote(setup.helper) + ' --request ' + quote(requestPath) + ' --output ' + quote(outputPath);
      const result = resultOf(await run(command, Math.max(3600000, Number(job.timeout) || 7200000)));
      if (result.code !== 0) throw new Error(result.stderr.split(/\r?\n/).slice(-4).join(' ') || ('AI zakończyło kodem ' + result.code));
      const raw = JSON.parse(await Neutralino.filesystem.readFile(outputPath));
      const data = normalizeAiResult(raw, job);
      progressOf(onProgress, 'done');
      return data;
    } finally {
      for (const path of [temporary, requestPath, outputPath]) {
        if (path) { try { await Neutralino.filesystem.remove(path); } catch (e) {} }
      }
    }
  }

  async function defaultBackupDirectory() {
    if (WINDOWS) {
      const home = await env(['USERPROFILE']);
      return join(home || APP_DIR, 'Documents/Pulsar/Backups');
    }
    const home = await env(['HOME']);
    return join(home || APP_DIR, 'Pulsar/Backups');
  }

  const fs = {
    stats: stats,
    exists: exists,
    mkdir: mkdir,
    remove: function (path) { return Neutralino.filesystem.remove(path); },
    read: function (path) { return Neutralino.filesystem.readBinaryFile(path); },
    write: function (path, data) { return Neutralino.filesystem.writeBinaryFile(path, asBuffer(data)); },
    append: function (path, data) { return Neutralino.filesystem.appendBinaryFile(path, asBuffer(data)); },
    writeBlob: writeBlob,
    list: function (path) { return Neutralino.filesystem.readDirectory(path); },
    folderDialog: function (title) { return Neutralino.os.showFolderDialog(title || 'Wybierz folder'); },
    saveDialog: function (title, name, ext, label) {
      return Neutralino.os.showSaveDialog(title, { defaultPath: name, filters: [{ name: label || ext, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] })
        .then(function (path) { if (!path) return ''; path = String(path); return /\.[a-z0-9]+$/i.test(path) ? path : path + '.' + ext; });
    },
    join: join,
    baseName: baseName
  };

  Object.assign(api, {
    available: true,
    capabilities: capabilities,
    lyricsAiCapabilities: lyricsAiCapabilities,
    alignLyrics: alignLyrics,
    tempFile: tempFile,
    exportAudio: exportAudio,
    defaultBackupDirectory: defaultBackupDirectory,
    fs: fs
  });
})();
