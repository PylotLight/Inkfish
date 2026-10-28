# Intelligence: embedded models for document tasks

Inkfish can use Apple Foundation Models or a managed local LFM3 model for document cleanup, organising and summaries. Model inference runs locally. Inkfish bundles the pinned `llama.cpp` server at build/development time; model weights are not bundled and are downloaded only when requested, after the user explicitly accepts the LFM Open License v1.0.

## Apple Intelligence

- **Model:** Apple's on-device Foundation Model on supported Apple silicon Macs with macOS 26.
- **Where it runs:** the `inkfish-stt` helper (`stt/Sources/InkfishSTT/Intelligence.swift`). It reports availability and accepts JSON tasks for cleanup, organising or summarising.
- **Guided generation:** typed Swift output structures provide cleaned notes, projects, tags and summaries.
- **Fallback:** if the selected model is unavailable or a request fails, Inkfish retains the raw capture and continues with the rules path.

## Managed local LFM3

Inkfish manages two Q4_K_M GGUF models through the bundled `llama.cpp` b11946 `llama-server` on macOS ARM64:

| Model                       | Repository and quantization                                                          | Files (exact size; SHA-256)                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text: LFM3-1.7B             | [LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) `Q4_K_M`   | `LFM3-1.7B-Q4_K_M.gguf` — 1,099,627,808 bytes; `3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4`                                                                                                                         |
| Vision-language: LFM3-VL-2B | [LiquidAI/LFM3-VL-2B-GGUF](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF) `Q4_K_M` | `LFM3-VL-2B-Q4_K_M.gguf` — 1,099,627,808 bytes; `56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb`; `mmproj-LFM3-VL-2B-Q8_0.gguf` — 203,031,872 bytes; `c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab` |

The text model is used for text tasks. The VL model supports visual document input; its image content is passed as a local base64 data URL using the OpenAI-compatible `image_url` message field. Video input is not included. The existing loopback endpoint route for LFM3-1.7B text remains; only `llama.cpp` is enabled for VL.

The managed server archive is the official macOS ARM64 asset from [llama.cpp b11946](https://github.com/ggml-org/llama.cpp/releases/tag/b11946), 16,438,371 bytes, SHA-256 `d618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed`. That tag includes the merged [LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252), merge `19cce6919992fdffd92e0ac152caaf1e2b8f254e`; the tag comparison is 8 commits ahead and 0 behind. macOS ARM64 is the only bundled binary. A minimum macOS version and signing/notarization status have not been verified and are not specified here.

Weights are governed by the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE), also included with the macOS app. Inkfish does not bundle weights. It prompts for explicit license acceptance before downloading a requested model; consult the license for its terms.

MLX and ONNX have checkpoint artifacts, but Inkfish has no implemented in-app runtime path for them. vLLM and SGLang are not supported for VL in Inkfish. UZU is blocked because no verified LFM3 checkpoint or conversion specification is available.

## Set up the managed runtime

In **Settings → Intelligence**, choose **llama.cpp (managed)**, select the text or VL model, review and accept the LFM Open License, then choose **Download model**. Downloads are stored in Inkfish app data, not in the notes vault. The text weights are about 1.10 GB; the VL model plus projector are about 1.30 GB. Inkfish checks the expected byte size and SHA-256 before using each file, and requires extra free disk space while downloading. The shown memory estimates assume an 8k context: roughly 4 GB for text and 6 GB for VL; actual memory use depends on the Mac. To avoid starting under severe memory pressure, the managed runtime requires at least 2.5 GB free for text or 4 GB for VL.

The pinned server is currently bundled only for macOS Apple silicon. It starts on demand or from Settings, binds to `127.0.0.1` on a temporary local port, disables llama.cpp's Web UI, allows one request slot with an 8k context, and stops after 10 minutes idle or when Inkfish quits. A normal quit waits for the server and any model download process to stop; if a child cannot be stopped, Inkfish stays open and shows an error. Before using the managed endpoint, Inkfish verifies that the launched process owns the listening port and that `/v1/models` advertises the selected model; it repeats the ownership check before sending a task. On macOS this uses the system `lsof` process/socket listing. Image processing reads only PNG/JPEG assets already in the vault (up to two images, 4 MB each); remote URLs are not fetched or sent. Other verified local API profiles support text only and require the server to advertise the exact LFM3 model ID.

## Deterministic benchmark

The CLI benchmark runs versioned synthetic tasks and reports deterministic task scoring, latency/speed, repeated-run consistency and optional server RSS. Tasks cover text-document work and include a visual-document task. Text scores include exact extracted fields with declared normalization, action-item precision/recall/F1, classification labels and required-fact coverage. It also reports task-stratified bootstrap confidence intervals where applicable. Latency includes warm-up/first-request and p50/p95; throughput is reported when available. RSS is sampled when a process ID is supplied and does not represent all GPU/unified-memory use.

Start the model in Settings first; use the local API URL and PID shown there. The managed benchmark requires the PID so it can verify that the endpoint belongs to the expected process. For example, with the text model running:

```sh
bun run bench:intelligence -- --engine llama.cpp-managed --url "http://127.0.0.1:$PORT/v1" --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M --pid "$PID" --runs 3
```

For the vision task, start **LFM3-VL-2B** and use `--model LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M`. The runner validates and sends generated synthetic invoice PNGs; it does not use personal documents. The JSON report records each case and run, exact/coverage scores, p50/p95 latency, output tokens per second, model-output repeatability, a document-stratified 95% score interval and optional server-process RSS.

Synthetic cases are reproducible but small and may not represent real documents or users' workloads. Phrase-based summary coverage can miss valid paraphrases and does not judge readability or nuanced faithfulness. Use a representative held-out set and human review for those qualities; confidence intervals help show uncertainty but cannot fix an unrepresentative sample. No real model scores are published here: they should not be claimed until a user runs the benchmark with actual weights.

## Sources

- [LFM3-1.7B GGUF model card](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)
- [LFM3-VL-2B model card](https://huggingface.co/LiquidAI/LFM3-VL-2B) and [GGUF model card](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF)
- [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE)
- [llama.cpp b11946 release](https://github.com/ggml-org/llama.cpp/releases/tag/b11946) and [LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252)
- [LFM3 implementation details](lfm3.md); [local LLM feature architecture](local-llm.md)
