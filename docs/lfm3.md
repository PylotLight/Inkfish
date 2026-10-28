# LFM3 for embedded document intelligence

Liquid AI announced LFM3 on 2026-10-27 as a family of compact, edge-oriented models. For document processing, the relevant candidates are the text-only **LFM3-1.7B** for text already extracted from notes and documents, and **LFM3-VL-2B** for pages, charts and other visual inputs. This page uses model-specific Hugging Face cards as the source of truth; the general model-library page may lag new releases.

## The text model: LFM3-1.7B

The official [LFM3-1.7B card](https://huggingface.co/LiquidAI/LFM3-1.7B) describes a 1.73B-parameter text model with a 256K context window, 16 languages, structured output and tool calling. It is the best first candidate for Inkfish's current cleanup, organising and summary tasks because those tasks receive text rather than images.

The official [GGUF card](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) lists Q4_0 at about 1.05 GB and Q4_K_M at about 1.1 GB. These are checkpoint sizes, not Inkfish process-memory or end-to-end latency measurements. The model card recommends `temperature=0.1`, `top_k=50` and `repetition_penalty=1.1` for general use. Reasoning is enabled by default; the model card says disabling it can be inconsistent, so benchmark the exact serving configuration.

## The vision model: LFM3-VL-2B

The [LFM3-VL-2B card](https://huggingface.co/LiquidAI/LFM3-VL-2B) describes a 1.92B vision-language model that accepts text, images and video, with document reading and chart understanding among its visual tasks. It is a natural future candidate for scanned pages and image attachments. Its model card lists GGUF, MLX and ONNX exports, but runtime readiness differs by format: llama.cpp support is still in review, and the card says MLX-VLM, vLLM and SGLang support is in progress. ONNX artifacts can run through ONNX Runtime directly.

Inkfish does not currently pass image bytes or page crops through the embedded-intelligence contract, so the vision model is not enabled or scored by the present benchmark. Adding it needs both a multimodal request path and a fixed page-image evaluation set with known fields.

## Runtime compatibility for the current Inkfish adapter

The adapter expects a local server exposing OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`, and accepts only an advertised LFM3-1.7B text model ID. It does not bundle server software or weights.

| Runtime / format                                                   | LFM3-1.7B text status                                                                                                                                                                                                                              | Inkfish status                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [llama.cpp / GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) | The official card documents a local OpenAI-compatible `llama-server`; use an LFM3-compatible build.                                                                                                                                                | Enabled (`llama.cpp`)                                                                                                         |
| [Ollama](https://ollama.com/library/lfm3)                          | The official `lfm3` tag is published and Ollama documents local OpenAI-compatible Chat Completions.                                                                                                                                                | Enabled (`ollama`)                                                                                                            |
| [LM Studio / GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) | The official GGUF card lists LM Studio as a local app.                                                                                                                                                                                             | Enabled (`lm-studio`)                                                                                                         |
| [vLLM / BF16](https://huggingface.co/LiquidAI/LFM3-1.7B)           | The official card documents vLLM serving with Chat Completions.                                                                                                                                                                                    | Enabled (`vllm`)                                                                                                              |
| [SGLang](https://huggingface.co/LiquidAI/LFM3-1.7B)                | The official card lists SGLang, including the card's BF16, FP8 and NVFP4 variants.                                                                                                                                                                 | Enabled (`sglang`)                                                                                                            |
| [MLX-LM / MLX](https://huggingface.co/LiquidAI/LFM3-1.7B-MLX-4bit) | An MLX checkpoint exists, but its model card says LFM3 support in `mlx-lm` is still in progress.                                                                                                                                                   | Not enabled until the model-specific runtime support is confirmed.                                                            |
| [ONNX Runtime](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX)     | Official ONNX weights and direct inference instructions are available.                                                                                                                                                                             | Not enabled: Inkfish has no ONNX executor or compatible local API wrapper.                                                    |
| [UZU / lalamo](https://github.com/trymirai/uzu)                    | No LFM3 checkpoint or documented LFM3 conversion `ModelSpec` is listed in the [current converter catalogue](https://github.com/trymirai/lalamo/tree/main/lalamo/model_import/model_specs) or [Mirai model catalogue](https://trymirai.com/models). | Excluded: there is no documented LFM3 conversion path; UZU's private model format cannot load the other checkpoints directly. |

The [LFM3 launch blog](https://www.liquid.ai/blog/lfm3) reports native support across llama.cpp, MLX and vLLM and lists launch partners. For Inkfish enablement, a model-specific inference card and a usable compatible endpoint are required: the text MLX card still marks runtime support in progress, and the available ONNX path is direct inference rather than the API used by the app. The model-card status is therefore preserved rather than inferred from the broad launch announcement.

## Benchmark plan

Inkfish's current CLI benchmark runs the same 12 synthetic text-document tasks on the LFM3-1.7B text checkpoint at temperature zero. It measures task-specific extraction, action-item F1, classification accuracy and required-fact coverage; a seeded document-stratified bootstrap interval; warm-up, p50/p95 latency, throughput, optional process RSS and repeated-output consistency. These deterministic tasks do not need a judge model. Human or judge-model review can be added as a separately labelled measure for readability and nuanced faithfulness.

No actual LFM3 benchmark results are checked in: no local inference server was available in the development environment. Vendor-published size and device-performance figures are not Inkfish task-quality, memory or speed results.

## License

LFM3 model cards identify the [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE). Inkfish does not include or redistribute model weights in this endpoint adapter; review the license and source terms for any model you download.

## Sources

- [Liquid AI LFM3 launch blog](https://www.liquid.ai/blog/lfm3)
- [LFM3-1.7B text model card](https://huggingface.co/LiquidAI/LFM3-1.7B)
- [LFM3-1.7B GGUF card](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)
- [LFM3-1.7B MLX card](https://huggingface.co/LiquidAI/LFM3-1.7B-MLX-4bit)
- [LFM3-1.7B ONNX card](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX)
- [LFM3-VL-2B card](https://huggingface.co/LiquidAI/LFM3-VL-2B), [GGUF card](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF), [MLX card](https://huggingface.co/LiquidAI/LFM3-VL-2B-MLX-4bit) and [ONNX card](https://huggingface.co/LiquidAI/LFM3-VL-2B-ONNX)
- [Official Ollama LFM3 page](https://ollama.com/library/lfm3) and [local OpenAI-compatible API docs](https://docs.ollama.com/api/openai-compatibility)
- [UZU repository](https://github.com/trymirai/uzu), [lalamo ModelSpec catalogue](https://github.com/trymirai/lalamo/tree/main/lalamo/model_import/model_specs) and [Mirai model catalogue](https://trymirai.com/models)
