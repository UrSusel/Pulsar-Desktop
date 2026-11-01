#!/usr/bin/env python3
"""Pulsar experimental desktop lyrics alignment (Stable-TS + Faster-Whisper).

The file is read from resources.neu and written to the user's AI cache by the
native bridge. Heavy imports are deliberately lazy so --check and unit tests do
not need PyTorch. Audio is decoded locally by PyAV through Faster-Whisper.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

VERSION = 1
DEFAULT_MODEL = "base"
ALLOWED_MODELS = {"tiny", "base", "small"}
ALLOWED_LANGUAGES = {
    "en", "pl", "de", "es", "fr", "it", "pt", "nl", "uk", "ru", "ja", "ko", "zh",
}
MAX_LINES = 2000
MAX_CHARACTERS = 200_000


class AlignmentError(RuntimeError):
    pass


def _text_key(value: object) -> str:
    return "".join(str(value or "").split())


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_request(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise AlignmentError("Niepoprawne żądanie dopasowania")
    audio_path = str(raw.get("audio_path") or "").strip()
    if not audio_path:
        raise AlignmentError("Brak ścieżki audio")
    source = raw.get("lines")
    if not isinstance(source, list):
        raise AlignmentError("Brak tekstu do dopasowania")
    lines = [str(line or "").strip() for line in source]
    lines = [line for line in lines if line]
    if not lines or len(lines) > MAX_LINES or sum(map(len, lines)) > MAX_CHARACTERS:
        raise AlignmentError("Tekst jest pusty lub zbyt duży")
    language = str(raw.get("language") or "").lower().strip()
    if language not in ALLOWED_LANGUAGES:
        raise AlignmentError("Wybierz obsługiwany język tekstu")
    model = str(raw.get("model") or DEFAULT_MODEL).lower().strip()
    if model not in ALLOWED_MODELS:
        raise AlignmentError("Nieobsługiwany model AI")
    model_root = str(raw.get("model_root") or "").strip()
    if not model_root:
        raise AlignmentError("Brak folderu modeli AI")
    audio_start = raw.get("audio_start", 0)
    audio_end = raw.get("audio_end")
    if not _finite(audio_start) or audio_start < 0:
        raise AlignmentError("Niepoprawny początek zakresu audio")
    if audio_end is not None and (not _finite(audio_end) or audio_end <= audio_start):
        raise AlignmentError("Niepoprawny koniec zakresu audio")
    return {
        "audio_path": audio_path,
        "lines": lines,
        "language": language,
        "model": model,
        "model_root": model_root,
        "audio_start": float(audio_start),
        "audio_end": float(audio_end) if audio_end is not None else None,
    }


def _segment_words(segment: dict, time_offset: float = 0) -> list[dict]:
    words = []
    for raw in segment.get("words") or []:
        if not isinstance(raw, dict):
            continue
        text = raw.get("word")
        start = raw.get("start")
        if not isinstance(text, str) or not text or not _finite(start) or start < 0:
            continue
        item = {"t": round(float(start + time_offset), 3), "txt": text}
        end = raw.get("end")
        if _finite(end) and end > start:
            item["d"] = round(float(end - start), 3)
        words.append(item)
    previous = -1.0
    for word in words:
        if word["t"] < previous:
            return []
        previous = word["t"]
    return words


def convert_result(result: dict, source_lines: list[str], time_offset: float = 0) -> dict:
    """Convert Stable-TS output without ever estimating missing timestamps."""
    segments = result.get("segments") if isinstance(result, dict) else None
    if not isinstance(segments, list) or not segments:
        raise AlignmentError("AI nie zwróciło żadnych fragmentów")
    output = []
    probabilities = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        words = _segment_words(segment, time_offset)
        start = segment.get("start")
        if _finite(start) and start >= 0:
            start = float(start + time_offset)
        else:
            start = words[0]["t"] if words else None
        if start is None:
            continue
        returned_text = str(segment.get("text") or "").strip()
        source_text = source_lines[index].strip() if index < len(source_lines) else ""
        if source_text and len(segments) == len(source_lines) and (
            _text_key(returned_text) == _text_key(source_text)
            or _text_key("".join(w["txt"] for w in words)) == _text_key(source_text)
        ):
            text = source_text
        else:
            text = returned_text or source_text
        if not text:
            continue
        item = {"t": round(float(start), 3), "txt": text}
        end = segment.get("end")
        if _finite(end) and end > start - time_offset:
            item["d"] = round(float(end - (start - time_offset)), 3)
        if words and _text_key("".join(w["txt"] for w in words)) == _text_key(text):
            item["words"] = words
            for raw in segment.get("words") or []:
                probability = raw.get("probability") if isinstance(raw, dict) else None
                if _finite(probability) and 0 <= probability <= 1:
                    probabilities.append(float(probability))
        output.append(item)
    if not output:
        raise AlignmentError("AI nie zwróciło poprawnych znaczników czasu")
    output.sort(key=lambda line: line["t"])
    expected_words = sum(len(line.split()) for line in source_lines)
    aligned_words = sum(len(line.get("words") or []) for line in output)
    if not aligned_words:
        raise AlignmentError("AI nie wyznaczyło wiarygodnych czasów słów")
    coverage = min(1.0, aligned_words / max(1, expected_words))
    if coverage < 0.4:
        raise AlignmentError("AI dopasowało zbyt małą część tekstu — wynik odrzucono")
    return {
        "version": VERSION,
        "lines": output,
        "word_count": aligned_words,
        "expected_words": expected_words,
        "coverage": round(coverage, 4),
        "mean_probability": round(sum(probabilities) / len(probabilities), 4) if probabilities else None,
    }


def _decode_smoke() -> None:
    """Decode a tiny PCM buffer; imports alone miss PyAV API incompatibilities."""
    import io  # noqa: PLC0415
    import wave  # noqa: PLC0415
    from faster_whisper.audio import decode_audio  # noqa: PLC0415

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 1600)
    buffer.seek(0)
    audio = decode_audio(buffer, sampling_rate=16000)
    if getattr(audio, "size", 0) < 1600:
        raise AlignmentError("PyAV nie zdekodował kontrolnego fragmentu audio")


def check_environment() -> dict:
    import stable_whisper  # noqa: PLC0415
    import faster_whisper  # noqa: PLC0415
    import av  # noqa: PLC0415
    pyav_version = str(getattr(av, "__version__", "unknown"))
    try:
        pyav_major = int(pyav_version.split(".", 1)[0])
    except ValueError:
        pyav_major = 0
    if pyav_major >= 19:
        raise AlignmentError("PyAV 19 jest niezgodny z Faster-Whisper 1.2.1 — wymagany jest av<19")
    _decode_smoke()
    return {
        "ok": True,
        "stable_ts": str(getattr(stable_whisper, "__version__", "unknown")),
        "faster_whisper": str(getattr(faster_whisper, "__version__", "unknown")),
        "pyav": pyav_version,
    }


def run_alignment(raw_request: dict) -> dict:
    request = validate_request(raw_request)
    if not Path(request["audio_path"]).is_file():
        raise AlignmentError("Plik audio nie istnieje")
    Path(request["model_root"]).mkdir(parents=True, exist_ok=True)

    # These imports install with stable-ts[fw]. PyAV bundles its codec libraries,
    # so the desktop feature does not depend on a system FFmpeg installation.
    import stable_whisper  # noqa: PLC0415
    from faster_whisper.audio import decode_audio  # noqa: PLC0415

    decoded = decode_audio(request["audio_path"], sampling_rate=16000)
    audio_start = request["audio_start"]
    audio_end = request["audio_end"]
    first = int(round(audio_start * 16000))
    last = int(round(audio_end * 16000)) if audio_end is not None else int(getattr(decoded, "size", 0))
    last = min(int(getattr(decoded, "size", 0)), last)
    audio = decoded[first:last]
    if getattr(audio, "size", 0) < 16000:
        raise AlignmentError("Wybrany fragment jest zbyt krótki do analizy (minimum 1 s)")
    threads = max(1, min(8, (os.cpu_count() or 2) // 2))
    import torch  # noqa: PLC0415
    torch.set_num_threads(threads)
    model = stable_whisper.load_faster_whisper(
        request["model"], device="cpu", compute_type="int8",
        download_root=request["model_root"], cpu_threads=threads, num_workers=1,
    )
    result = model.align(
        audio, "\n".join(request["lines"]), language=request["language"],
        original_split=True, only_voice_freq=True, nonspeech_skip=5.0,
        failure_threshold=0.8, verbose=None,
    )
    if result is None:
        raise AlignmentError("AI nie potrafiło dopasować tego tekstu")
    payload = convert_result(result.to_dict(), request["lines"], time_offset=audio_start)
    payload.update({
        "engine": "stable-ts",
        "backend": "faster-whisper",
        "model": request["model"],
        "language": request["language"],
        "duration": round(float(audio.size) / 16000.0, 3),
        "audio_start": audio_start,
        "audio_end": audio_end,
    })
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--request")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        if args.check:
            result = check_environment()
            print(json.dumps(result, ensure_ascii=False))
            return 0
        if not args.request or not args.output:
            raise AlignmentError("Wymagane są --request i --output")
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        result = run_alignment(request)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return 0
    except Exception as exc:  # Keep the native UI readable; no giant traceback.
        if os.environ.get("PULSAR_AI_DEBUG") == "1":
            import traceback  # noqa: PLC0415
            traceback.print_exc()
        print("PULSAR_AI_ERROR: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
