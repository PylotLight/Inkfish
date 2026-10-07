# Benchmark clips

All 16 kHz mono. Reference transcripts live in `src/shared/sttBench.ts`.

## Quick

`librispeech-1272.wav` — 79.42 s, 14 utterances of clean read English (one US speaker) with 0.5 s gaps.
Source: LibriSpeech dev-clean, speaker 1272 (utterance ids in `sttBench.ts`).

## Deep

| File | Length | What |
| --- | --- | --- |
| `aus-pilbara.flac` | 60 s | Australian English — Pilbara Minerals quarterly call (mining operations, figures, disfluent speech) |
| `aus-syrah.flac` | 66 s | Australian English — Syrah Resources call (EV / graphite markets, many numbers) |
| `aus-goldroad.flac` | 60 s | Australian English — Gold Road Resources call (finance, two speakers) |
| `librispeech-other.flac` | 102 s | LibriSpeech test-other — 13 different speakers, harder read speech |

The earnings-call clips are consecutive segments from Earnings-22 with any segment marked `[inaudible]` left out,
joined with 0.4 s gaps. Scoring spells out numbers and ignores fillers (uh, um) on both sides.

## Licences

- LibriSpeech © Vassil Panayotov et al., CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), openslr.org/12.
- Earnings-22 © Rev.com (Del Rio et al., 2022), CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/),
  via huggingface.co/datasets/distil-whisper/earnings22 (files 4482983, 4482976, 4482968). The `aus-*.flac` excerpts
  are adapted (trimmed and joined) and are shared under the same CC BY-SA 4.0 licence.
