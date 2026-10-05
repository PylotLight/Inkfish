# local STT sidecar (photon + parakeet-redux)

`moondream/parakeet-redux` (Hugging Face, CC-BY-4.0) — 1.58-bit ternary build
of `nvidia/parakeet-tdt-0.6b-v3`, 178 MB, ~38× realtime CPU / ~43× GPU on M2
Air via Photon (Metal on Apple GPUs, NEON/AVX elsewhere), word+segment
timestamps, built-in VAD segmentation (≤30s).

## Setup

```bash
pip install "moondream>=2.4.0"
```

First run downloads the 178 MB model from Hugging Face.

## Use

The Electron main process spawns the sidecar (`bun spawn` python photon
pattern — here `node:child_process` → `python3`):

```bash
python3 stt/transcribe.py --wav path/to/audio.wav --json
# {"text": "...", "segments": [{"start": 0.0, "end": 1.2, "text": "..."}]}
```

Without `--json`, prints plain transcript text. Missing dependency or a
failed transcription exits non-zero with the reason on stderr — the app
surfaces that as "STT unavailable" and keeps the audio asset so nothing is
lost.

Fallback: Apple Speech on short clips (reserved — needs native code, not
wired in the P0 Electron build). Keep audio → transcript separate from
transcript → summary model.

Known weakness (model card MUSAN gap): noisy rooms hurt — recommend
headphones, and keep the Teams built-in transcript import as backup path
(main window → 🎙 Meeting → Import .vtt).
