#!/usr/bin/env python3
"""Inkfish STT sidecar: wav -> transcript segments via moondream/parakeet-redux.

Model: `moondream/parakeet-redux` (HF, CC-BY-4.0) — 1.58-bit ternary build of
`nvidia/parakeet-tdt-0.6b-v3`, 178 MB, ~38x realtime CPU / ~43x GPU on M2 Air
via Photon (Metal on Apple GPUs, NEON/AVX elsewhere), word+segment timestamps,
built-in VAD segmentation (<=30s).

Usage:
    python3 stt/transcribe.py --wav path/to/audio.wav [--json]

With `--json` (used by the Electron main process) prints:
    {"text": "...", "segments": [{"start": 0.0, "end": 1.2, "text": "..."}]}

Without it, prints plain transcript text.

Requires: `pip install "moondream>=2.4.0"`. First run downloads the 178 MB
model from Hugging Face. If photon/moondream is missing, exits non-zero with
the pip hint on stderr — the app surfaces that as "STT unavailable".
"""

import argparse
import json
import sys


def fail(msg: str) -> "NoReturn":
    from typing import NoReturn  # noqa: PLC0415

    print(f"stt: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Transcribe wav via parakeet-redux")
    ap.add_argument("--wav", required=True, help="input audio file (wav/mp3/m4a)")
    ap.add_argument("--json", action="store_true", help="emit JSON with segments")
    args = ap.parse_args()

    try:
        import moondream as md  # type: ignore
    except ImportError:
        fail('photon not installed — run: pip install "moondream>=2.4.0"')

    try:
        model = md.photon("moondream/parakeet-redux")
        result = model.transcribe(args.wav)
    except Exception as e:  # keep the sidecar contract: stderr + non-zero
        fail(f"transcription failed: {e}")

    # Photon returns segments with start/end + text; be liberal in shape.
    segments: list[dict] = []
    text_parts: list[str] = []
    items = result.get("segments", [result]) if isinstance(result, dict) else result
    for seg in items if isinstance(items, list) else []:
        if not isinstance(seg, dict):
            text_parts.append(str(seg))
            continue
        t = str(seg.get("text", "")).strip()
        if t:
            text_parts.append(t)
            segments.append(
                {
                    "start": float(seg.get("start", 0.0)),
                    "end": float(seg.get("end", 0.0)),
                    "text": t,
                }
            )
    text = " ".join(text_parts).strip()
    if not text and isinstance(result, dict) and result.get("text"):
        text = str(result["text"]).strip()

    if args.json:
        print(json.dumps({"text": text, "segments": segments}))
    else:
        print(text)


if __name__ == "__main__":
    main()
