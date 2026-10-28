# LFM3 for embedded document intelligence

Liquid AI's LFM3 family includes compact models for language and visual tasks. Inkfish supports the LFM3-1.7B text model for text already extracted from notes and documents, and LFM3-VL-2B for visual document input, through its managed `llama.cpp` path. Model weights are not bundled; users request a download only after explicitly accepting the LFM Open License v1.0.

## Supported managed models

Inkfish manages these two Q4_K_M GGUF models:

| Model                      | Model source                                                                                                                       | Files                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LFM3-1.7B text             | [GGUF repository](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)                                                                  | `LFM3-1.7B-Q4_K_M.gguf` — 1,099,627,808 bytes; SHA-256 `3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4`                                                                                                                                 |
| LFM3-VL-2B vision-language | [VL model card](https://huggingface.co/LiquidAI/LFM3-VL-2B) and [GGUF repository](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF) | `LFM3-VL-2B-Q4_K_M.gguf` — 1,099,627,808 bytes; SHA-256 `56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb`; `mmproj-LFM3-VL-2B-Q8_0.gguf` — 203,031,872 bytes; SHA-256 `c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab` |

The VL image path sends local base64 data URLs through OpenAI-compatible `image_url` content. Video support is not included. Inkfish retains its loopback endpoint route for LFM3-1.7B text; only `llama.cpp` is enabled for VL.

## Runtime

Inkfish bundles the pinned macOS ARM64 `llama-server` archive from [llama.cpp b11946](https://github.com/ggml-org/llama.cpp/releases/tag/b11946) at build/development time. The archive is 16,438,371 bytes with SHA-256 `d618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed`. The b11946 tag includes merged [LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252), merge `19cce6919992fdffd92e0ac152caaf1e2b8f254e`; comparing the tag shows it is 8 commits ahead and 0 behind. This is the only bundled binary architecture. The minimum macOS version and signing/notarization status are unverified.

MLX and ONNX checkpoint artifacts exist, but Inkfish has no implemented in-app MLX or ONNX runtime path. vLLM and SGLang VL are not supported. UZU is blocked because there is no verified LFM3 checkpoint or conversion specification; do not infer support from other checkpoint formats.

## License and downloads

The models use the [LFM Open License v1.0](../licenses/LFM-OPEN-LICENSE.txt), copied from the [official LFM3 model repository](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE). The license text ships with the macOS app; model weights do not. Inkfish downloads only a model the user requests, and only after explicit license acceptance. Read the license for its terms.

## Benchmarking

The deterministic benchmark evaluates synthetic text-document tasks and includes a visual-document task. It measures task scores alongside latency/speed, repeatability and optional server RSS. Confidence intervals (including task-stratified bootstrap intervals where applicable) help express sampling uncertainty; they do not make the synthetic cases representative. These small, fixed cases are useful for reproducible checks, not proof of production quality. Phrase-based summary scoring may miss paraphrases and cannot assess nuanced faithfulness or readability. Use representative held-out material and human review when those qualities matter.

No real model benchmark results are published here. A user must run the benchmark with actual downloaded weights before reporting model scores; vendor size/performance claims are not Inkfish benchmark results.

## Official references

- [LFM3-1.7B GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)
- [LFM3-VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B) and [LFM3-VL-2B GGUF](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF)
- [LFM Open License v1.0](../licenses/LFM-OPEN-LICENSE.txt) ([official source](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE))
- [llama.cpp b11946 release](https://github.com/ggml-org/llama.cpp/releases/tag/b11946)
- [llama.cpp LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252)
- [Intelligence feature and benchmark notes](intelligence.md)
