# Intelligence: embedded LFM3 for document text

Inkfish can use Apple Foundation Models or a user-run local LFM3 text model for cleanup, organising and summaries. The local adapter is restricted to loopback OpenAI-compatible endpoints; it does not install runtimes or download weights.

## Apple Intelligence (existing path)

- **Model:** Apple's on-device Foundation Model, available on supported Apple silicon Macs with macOS 26.
- **Where it runs:** the bundled `inkfish-stt` helper (`stt/Sources/InkfishSTT/Intelligence.swift`). The helper reports availability and accepts JSON tasks for cleanup, organising or summarising.
- **Guided generation:** typed Swift output structures provide cleaned notes, projects, tags and summaries without parsing free-form prose.
- **Context:** cleanup splits long notes into chunks; organising reads a bounded excerpt.
- **Fallback:** if the selected model is unavailable or a request fails, Inkfish retains the raw capture and continues with the existing rules path.

## Local LFM3-1.7B text adapter

The local path currently accepts the **LFM3-1.7B text checkpoint only**. The saved model ID must be advertised by the server's `GET /v1/models` response and identify that text checkpoint; other model IDs are rejected before Inkfish sends document text. The local endpoint must use `localhost`, `127.0.0.1` or `::1`, and the adapter sends no API key.

The endpoint presets are manually managed: you install the runtime, download a licensed checkpoint and start its server. Inkfish does not package the model or runtime binaries.

| Enabled local endpoint                                      | Verified LFM3-1.7B path                                                                       | Default API URL             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| [llama.cpp](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) | GGUF; the model card documents `llama-server` and an OpenAI-compatible API                    | `http://127.0.0.1:8080/v1`  |
| [Ollama](https://ollama.com/library/lfm3)                   | Official `lfm3` text model; local OpenAI-compatible API                                       | `http://127.0.0.1:11434/v1` |
| [LM Studio](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) | The official GGUF model card lists LM Studio                                                  | `http://127.0.0.1:1234/v1`  |
| [vLLM](https://huggingface.co/LiquidAI/LFM3-1.7B)           | BF16 model card path with OpenAI-compatible Chat Completions                                  | `http://127.0.0.1:8000/v1`  |
| [SGLang](https://huggingface.co/LiquidAI/LFM3-1.7B)         | BF16, FP8 or NVFP4 variants as listed on the model card; OpenAI-compatible server             | `http://127.0.0.1:30000/v1` |
| Custom local server                                         | Any local server that actually runs the LFM3-1.7B text checkpoint and implements the same API | User supplied               |

Examples:

```sh
# llama.cpp: start an LFM3-compatible server; the exact model ID must match /v1/models
bun run bench:intelligence -- --engine llama.cpp --url http://127.0.0.1:8080/v1 --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M --runs 3

# Ollama: use the model ID reported by its local /v1/models endpoint
bun run bench:intelligence -- --engine ollama --url http://127.0.0.1:11434/v1 --model lfm3 --runs 3
```

The current model card lists BF16 weights for vLLM/SGLang/Transformers, FP8 and NVFP4 for SGLang, GGUF for llama.cpp/Ollama/LM Studio, plus MLX and ONNX artifacts. They are not all current Inkfish presets: the LFM3 MLX card says `mlx-lm` support is still in progress, so MLX is not enabled. ONNX Runtime can run the exported graph directly, but Inkfish has no ONNX execution adapter or OpenAI-compatible ONNX server, so it is not enabled either. The [official LFM3-1.7B model card](https://huggingface.co/LiquidAI/LFM3-1.7B) is the source of truth for model-specific files and runtime status; the general [Liquid model library](https://docs.liquid.ai/lfm/models/complete-library) may lag new releases.

### Why UZU is not enabled

UZU is not currently a runnable LFM3 engine. Its documented conversion path is `lalamo`, but the current [lalamo ModelSpec catalogue](https://github.com/trymirai/lalamo/tree/main/lalamo/model_import/model_specs) has no LFM3 model specification, and Mirai's [current model catalogue](https://trymirai.com/models) lists no LFM3 checkpoint. UZU uses its own converted model format, so an LFM3 GGUF, MLX or ONNX file cannot simply be loaded into it. There is no documented LFM3 conversion path to integrate safely; the UZU preset has therefore been removed rather than presented as supported.

### Vision model status

[LFM3-VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B) is the family member designed for document pages, charts and other visual inputs. Its model card describes image and video input, but it is not enabled in Inkfish yet: the current shared task contract and local adapter send text-only content, not image bytes or page crops. The VL card also marks llama.cpp support as in review and MLX-VLM, vLLM and SGLang support as in progress; ONNX artifacts can run through ONNX Runtime but are not wired into this app. A future vision benchmark should use fixed page images and deterministic gold fields, separate from the current text benchmark.

## Document benchmark

Run the same 12 versioned synthetic text-document tasks against a selected LFM3-1.7B server. The runner refuses non-LFM3-1.7B model IDs and checks that the exact ID appears in `/v1/models` before sending prompts.

```sh
bun run bench:intelligence -- --engine llama.cpp --url http://127.0.0.1:8080/v1 --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M --runs 3 --pid 1234
```

The CLI saves prompts, raw outputs and per-run metrics to `bench-intelligence-results.json` and reports:

- **Task quality:** exact invoice/receipt fields with declared normalization, precision/recall/F1 for explicit action items, exact classification labels, and required-fact coverage for grounded summaries.
- **Accuracy uncertainty:** a reproducible, seeded 10,000-resample task-stratified 95% bootstrap interval over document-level mean scores.
- **Speed:** warm-up/first-request latency, p50/p95 latency and output tokens per second. If the server omits token usage, output length gives a labelled estimate.
- **Memory:** peak process RSS sampled every 250 ms when `--pid` is provided. It does not include children or GPU/unified-memory allocations and is unavailable on Windows.
- **Consistency:** exact normalized-output rate and pairwise character-level similarity across repeated runs; JSON key order and whitespace are ignored.

These primary scores are deterministic and judge-free because each task has an answer key. Phrase-based summary coverage can miss valid paraphrases and does not score readability or nuanced faithfulness. If those qualities matter, report human review or a separately identified judge-model score alongside—not instead of—the deterministic measures. The 12 synthetic examples are a reproducible smoke benchmark, not enough to rank models for production; validate on a representative held-out set.

The published GGUF card gives model file sizes of about 1.05 GB for Q4_0 and 1.1 GB for Q4_K_M; those are checkpoint sizes, not Inkfish memory measurements. Inkfish has no real LFM3 benchmark results checked in because no local model server was available in this development environment.

## Settings and implementation boundary

Settings › Intelligence selects Apple Foundation Models or one of the verified LFM3-1.7B endpoint presets, configures the local URL and exact model ID, and provides a playground for cleanup, organising and summarising text. The status check verifies a compatible `/v1/models` response and that the selected model is advertised. A failed local request falls back to the rules path.

This is an endpoint adapter and CLI benchmark, not the planned managed runtime. The [Local LLM implementation plan](local-llm.md) still covers pinned runtime distribution, model downloads and license handling, process lifecycle, and an in-app engine comparison view.

## Sources

- [Liquid AI's LFM3 launch blog](https://www.liquid.ai/blog/lfm3)
- [LFM3-1.7B model card and runtime matrix](https://huggingface.co/LiquidAI/LFM3-1.7B)
- [LFM3-1.7B GGUF model card](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)
- [LFM3-1.7B MLX model card and status](https://huggingface.co/LiquidAI/LFM3-1.7B-MLX-4bit)
- [LFM3-1.7B ONNX model card](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX)
- [Ollama's LFM3 model page](https://ollama.com/library/lfm3) and [OpenAI-compatible API docs](https://docs.ollama.com/api/openai-compatibility)
- [LFM3-VL-2B model card](https://huggingface.co/LiquidAI/LFM3-VL-2B), [GGUF card](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF) and [ONNX card](https://huggingface.co/LiquidAI/LFM3-VL-2B-ONNX)
- [UZU's documented model format](https://github.com/trymirai/uzu), [lalamo ModelSpec catalogue](https://github.com/trymirai/lalamo/tree/main/lalamo/model_import/model_specs), and [Mirai model catalogue](https://trymirai.com/models)
