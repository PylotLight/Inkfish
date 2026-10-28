# LFM3: local models for note parsing (research)

Liquid AI's third Liquid Foundation Models, released 2026-10-27. Six models on one
shared ~2B backbone (a "tri-hybrid": gated short convolutions + sliding-window +
global attention), all edge-first: ~1 GB at 4-bit, long context, fast on Apple
silicon. This is an evaluation for Inkfish's on-device AI — the text model for
inbox cleanup/organising/summarising and per-note actions first, the other
modalities after.

Support status in third-party runtimes moves fast (LFM3 is one day old as of
writing); **re-verify the matrix below before building on it.**

## The family

| Model | Input → output | Notes |
| --- | --- | --- |
| LFM3-1.7B | text → text | 1.73B, 256K context, 128K vocab, 16 languages. Post-trained for agents, tool calling, structured output. |
| LFM3-VL-2B | text, image, video → text | 1.92B (1.73B LLM + 164M vision encoder + 25M projector), 128K context, step-by-step thinking. Docs/OCR & charts 83.9, GUI 83.1, visual grounding 77.3, embodied 64.4 — average 71.4 across 62 benchmarks, on par with Gemma 4 12B, best-in-class for its size. |
| LFM3-Audio-2B | text, audio → text, speech | 18 languages, in-house encoder + LiquidCodec; ~50 ms time-to-first-token (causal, prefills while you speak), TTS ~87× real time on an M4 Max, tool calls from audio. |
| LFM3-Omni-2B | text, image, video, audio → text, speech | Liquid's first omni model; one model in place of ASR + VLM + LLM + TTS. |
| d1-2B | text, image, video → calibrated answers | Decision model: several named questions (yes/no, choice, score) answered in a single forward pass, each with a calibrated probability. No autoregressive decoding. |
| d1-omni-2B | + audio | Same, with audio in. |

All under the **LFM Open License v1.0**: commercial use is licensed only for legal
entities with **under $10M annual revenue** (non-exempt non-profits unrestricted).
Redistribution must carry the license text and attribution. For a personal app this
is unproblematic; ship the license with the model download, keep the weights out of
the app binary (user-downloaded, like the STT models).

## Text model for note parsing

Why LFM3-1.7B fits the `intelligence.md` tasks (cleanup / organise / summarise):

- **Size/footprint:** 1.05 GB QAD Q4_0 or 1.1 GB Q4_K_M at 4-bit — half the footprint
  of the Gemma 4 E4B / Qwen3.5-4B candidates in the current "Next" plan.
- **Context:** 256K, versus the Apple Intelligence path's ~4K cap; long-note cleanup
  stops needing aggressive chunking.
- **Reliable structured output** (what the organise step is): IFEval 96.7, IFStruct
  93.7, IFBench 73.0, Multi-IF 89.1 — ahead of Gemma 4 E4B (90.0 / 78.5 / 44.6 / 81.0)
  and Qwen3.5-4B (92.5 / 87.1 / 38.2 / 80.3) in its size class.
- **Tool calling:** BFCL V4 71.4, above Qwen3.5-9B (62.8) and LFM2.5-2.6B (55.9);
  agentic post-training (WebArena-Verified 38.4 vs LFM2.5's 3.0).
- **Edge speed:** Liquid's benchmarks (Q4_0 GGUF, 32K context, llama.cpp): ≥2.5×
  faster prefill and ≥1.8× faster decode than every compared 2B-class model on M5
  Max, AMD Ryzen AI Max+ and iPhone 17 Pro, with the least memory.

Caveats: limited parametric knowledge (use retrieval for knowledge-heavy work), not
for complex multi-step reasoning or agentic coding. **Thinking is on by default** in
the chat template — set `enable_thinking: false` (llama.cpp: `--reasoning off`, or
per-request) for the JSON parsing tasks, or pay for reasoning tokens on every
capture. Recommended sampling (from the model card): `temp 0.1, top_k 50,
repetition_penalty 1.1` for general use.

## Runtimes on Apple silicon (status 2026-10-28)

| Runtime | LFM3 support | Fit for Inkfish |
| --- | --- | --- |
| llama.cpp (Metal, GGUF) | ✅ in release **b11945** (text+VL+audio+omni+d1 arch support merged 10-27) | Bundle a pinned MIT binary, run `llama-server` on a loopback port → OpenAI-compatible. Best readiness. Verify the release build's minimum macOS against the app's 12+ floor. |
| Ollama | ✅ in the official library (tags: tools, thinking); served via its MLX runner on Apple silicon | **Zero code**: `ollama pull lfm3` — existing `ai-discovery` + OpenAI provider picks it up on loopback. Best validation path. |
| LM Studio | ✅ via its llama.cpp runtime (GGUF) | User-installed option, same discovery path. |
| MLX (mlx-swift / mlx-lm) | ❌ "in progress" per Liquid's cards; nothing landed in ml-explore/mlx yet | 973 MB official 4-bit. When it lands it matches the documented "MLX Swift in the same helper" plan (in-process, typed API). Watch. |
| ONNX Runtime | ✅ official ONNX card | WebGPU path documented: `onnxruntime-web/webgpu` with `model_q4f16` (1.38 GB), prefill in ≤256-token chunks. Runs in the renderer with no native binary (the app already ships WebGPU STT); Metal/CoreML EP also possible. Expect slower WebGPU decode than Metal. |
| uzu (trymirai; Rust + Metal, MIT, 2.9k★) | ❌ its `lalamo` JAX converter has LFM2.5 (merged 10-22); LFM3 needs a new ModelSpec | **Strongest embed pattern so far**: Swift SPM binding (0.6.13) via uniffi, in-process (no subprocess), built-in model download with progress, JSON-grammar structured output (the Swift example derives the grammar from `@Generable` types — the same pattern `Intelligence.swift` uses), tool calling, TTS, shared weight instances, OpenAI-compatible server mode. Watch; becomes the leading embedded candidate if `lalamo` adds LFM3. |
| Splash (incoai; Apache-2.0) | ❌ model-specific: Qwen3.8/3.6, Ornith, Flash-Next, Flint, Prism Bonsai only; requires M3+ / macOS 26.4 | The "fast big model" tier (DFlash-2 speculative decoding, hand-tuned kernels, 2.5–5× vs llama.cpp on its targets). No LFM3, floor too new. |
| Kapitsa (nace-ai; Apache-2.0) | ❌ Qwen, Nemotron, Flint only; macOS 14+ | Same tier (KFlash tree speculative decoding, fastest decode in most of its 37 measured pairs). No LFM3. |

The speed advantages that make Splash/Kapitsa/uzu interesting (speculative decoding,
specialized kernels) matter for 27B+ models. A 1.7B model in ~1 GB runs comfortably
on any of these runtimes, so for LFM3 choose on **readiness and integration
ergonomics, not tok/s**: llama.cpp/Ollama today, uzu or mlx-swift once upstream
lands LFM3 support.

## Prior art: FluidVoice's Fluid Intelligence

FluidVoice's dictation post-processing ("Fluid Intelligence") is the closest existing
example of embedded model intelligence for note-like content: a local model (~3.5 GB,
a Gemma fine-tune, "Fluid-1") downloaded during onboarding, doing smart formatting,
context-aware capitalisation and post-processing, with per-app prompt sets. The
runtime is **private** ("keeping Fluid Intelligence private for now") and the repo is
GPLv3 (since 2026-02-23), so nothing is vendorable into MIT Inkfish — only the
pattern. LFM3-1.7B fills that slot better: 1 GB instead of 3.5 GB, 256K instead of
~4K context, stronger at structured output.

## Recommended path

1. **Validate (zero code).** `ollama pull lfm3`, point the existing AI provider at
   it (loopback discovery). Benchmark organise/cleanup/summarise quality and latency
   against Apple Intelligence on real inbox captures; check the `--reasoning off`
   latency delta.
2. **Embed v1.** Bundle a pinned llama.cpp release (Metal) as a second helper beside
   `inkfish-stt`; download Q4_K_M (1.1 GB) into app data via the existing
   model-download + SOCKS routing; serve OpenAI-compatible on a random loopback
   port, spawn on demand, idle-reap. Expose as a new provider kind and an
   Intelligence engine option — a fully local model on any Mac, no Apple
   Intelligence dependency.
3. **Watch (revisit in weeks).** LFM3 landing in `lalamo`/uzu (best ergonomics) or
   in mlx-swift/mlx-lm (fits the documented MLX plan). If one lands before v1 is
   done, prefer it over the subprocess.
4. **Phase 2, after the text path works.**
   - **VL-2B** for images in notes (1.59 GB MLX 4-bit / GGUF / ONNX): docs/OCR 83.9,
     GUI 83.1, charts, grounding — caption/OCR pasted images, parse screenshots.
     Same runtime options; a WebGPU Space (webml-community/LFM3-VL-2B-WebGPU) proves
     the in-browser route works.
   - **d1-2B** for routing: single-pass multi-question decisions with calibrated
     probabilities — real `confidence` values, which the Apple Intelligence path
     currently can't provide (it hardcodes 0.6 for any valid pick).
   - **Audio-2B / Omni-2B** later: a third STT engine (18 languages, live ASR,
     tool calls from audio) and meeting-audio understanding / TTS; Omni adds video.

## Sources

- Liquid AI blog: <https://www.liquid.ai/blog/lfm3> (HF mirror: <https://huggingface.co/blog/LiquidAI/lfm3>)
- Model cards: [LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) · [GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) · [MLX-4bit](https://huggingface.co/LiquidAI/LFM3-1.7B-MLX-4bit) · [ONNX](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX) · [VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B) · [VL-2B MLX-4bit](https://huggingface.co/LiquidAI/LFM3-VL-2B-MLX-4bit) · [collection](https://huggingface.co/collections/LiquidAI/lfm3)
- [License text](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE)
- llama.cpp: [PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252) (text+VL), [#31257](https://github.com/ggml-org/llama.cpp/pull/31257) (audio+omni), [#31275](https://github.com/ggml-org/llama.cpp/pull/31275) (d1) — merged 2026-10-27; release b11945
- Ollama: lfm3 in the [library](https://ollama.com/library) (0.40.x; [GGUF fixes PR #19344](https://github.com/ollama/ollama/pull/19344))
- Engines: [trymirai/uzu](https://github.com/trymirai/uzu) · [trymirai/lalamo](https://github.com/trymirai/lalamo) · [incoai/splash](https://github.com/incoai/splash) · [nace-ai/kapitsa](https://github.com/nace-ai/kapitsa) · [altic-dev/FluidVoice](https://github.com/altic-dev/FluidVoice)
