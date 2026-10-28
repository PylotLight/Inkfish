# LFM3 for embedded document intelligence

Inkfish supports two Liquid Foundation Models for local document work: **LFM3-1.7B** for text and **LFM3-VL-2B** for images. Both now have managed llama.cpp/GGUF and ONNX Runtime paths. Model weights are not bundled: Inkfish downloads only a model the user requests, after explicit acceptance of the LFM Open License v1.0.

## Managed models and formats

| Model                      | llama.cpp package                                                                                                 | ONNX package                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| LFM3-1.7B text             | `LFM3-1.7B-Q4_K_M.gguf` from [LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF)            | Q4 decoder `onnx/model_q4.onnx` plus its external weight data from [LiquidAI/LFM3-1.7B-ONNX](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX)          |
| LFM3-VL-2B vision-language | Q4_K_M decoder and Q8_0 `mmproj` from [LiquidAI/LFM3-VL-2B-GGUF](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF) | Q4 decoder plus the paired Q8 vision encoder and their external data from [LiquidAI/LFM3-VL-2B-ONNX](https://huggingface.co/LiquidAI/LFM3-VL-2B-ONNX) |

The app’s central [LFM catalog](../src/shared/lfm-catalog.ts) records the source repository, every required file, exact byte size and SHA-256 for each managed package, including tokenizer and processor metadata. Downloads are resumable and each file is verified before it is made available for inference. Invalid files are removed and must be downloaded again. Model files remain in Inkfish app data and are not committed to the repository.

## Runtime and platform limits

The managed ONNX path runs in Inkfish’s main process using ONNX Runtime Node’s **CPU execution provider**, with Transformers.js supplying the LFM3 tokenizer and image preprocessing. Inkfish implements the LFM3 graph loop directly, including `logits_to_keep`, cache tensors and the VL vision-encoder layout; it does not rely on an ONNX server preset. Remote model loading is disabled after startup. Inference and document images stay on-device. The runtime serializes requests, limits context and generated tokens, checks available memory before loading, and unloads an idle model after 10 minutes. The app expects roughly 4.5 GB RAM for the text model and 6.5 GB when the VL model is loaded with image processing; actual use depends on context and image size. ONNX Runtime Node 1.30 does not support cancelling a native graph call mid-run, so the inference timeout is checked between calls and again when each call returns. If shutdown is still waiting on a native inference after 30 seconds, Inkfish keeps the app open and asks you to wait and try quitting again.

Managed ONNX is currently enabled only on **macOS Apple silicon** and does not use a Mac GPU execution provider. The app keeps **macOS 14 as its minimum deployment target**; CI builds native components with Xcode 27 on macOS 27. The llama.cpp runtime remains a separate managed child server, pinned to [llama.cpp b11946](https://github.com/ggml-org/llama.cpp/releases/tag/b11946), which includes [LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252). Both managed runtimes stop or unload after 10 minutes idle.

The [Liquid AI ONNX deployment guide](https://docs.liquid.ai/deployment/on-device/onnx) currently documents LFM2-family examples rather than a ready-made LFM3 Node implementation. Inkfish’s ONNX adapter is based on the official LFM3 graphs and model cards and was validated with those exact packages; this is not a claim that Liquid AI’s guide itself documents LFM3-on-Node support. LFM3-VL accepts PNG and JPEG images only, with at most two images per request and the existing 4 MB per-image limit. Video is not supported.

Inkfish also retains loopback endpoints for externally managed local servers where their model support is verified. UZU remains blocked: there is no verified LFM3 checkpoint or converter specification. MLX has not been integrated as a managed runtime, and LFM2/UZU checkpoints are outside this feature’s scope.

## License and downloads

Both ONNX and GGUF model packages use the [LFM Open License v1.0](../licenses/LFM-OPEN-LICENSE.txt), available in the [official LFM3 ONNX repository](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX/blob/main/LICENSE). The license text ships with the macOS app; model weights do not. Read the license for its terms, including applicable commercial-use conditions, before accepting the download prompt.

## Benchmarking

Run the benchmark after the desired ONNX model has been downloaded. Because the standalone Bun process does not know Electron’s app-data path, point `INKFISH_DATA` at the app’s existing data directory (normally `~/Library/Application Support/Inkfish` on macOS): `INKFISH_DATA="$HOME/Library/Application Support/Inkfish" bun run bench:intelligence -- --engine onnx-managed --runs 3`. For the image model, add `--model LiquidAI/LFM3-VL-2B-ONNX`. The text model runs text-document cases; the VL model also runs the fixed visual-invoice cases. The benchmark reports deterministic task-specific extraction, action-item, classification and fact-coverage scores, document-stratified bootstrap intervals, latency, output speed, repeatability/similarity and process RSS. ONNX RSS is sampled from the benchmark process itself because tokenizer and inference sessions run in-process. Server-backed engines can sample a server process with `--pid`.

The benchmark uses synthetic fixed cases and primarily math/rule-based scoring rather than an LLM judge. Phrase-based summary scoring can miss valid paraphrases and cannot fully assess faithfulness or readability. These results are reproducible checks, not proof of production quality. Use representative held-out documents and human review when those qualities matter. No platform-comparable performance or accuracy results are published here; the earlier validation was a Linux CPU smoke test, not an Apple-silicon benchmark.

## Official references

- [LFM3-1.7B GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) and [LFM3-1.7B ONNX](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX)
- [LFM3-VL-2B](https://huggingface.co/LiquidAI/LFM3-VL-2B), [GGUF package](https://huggingface.co/LiquidAI/LFM3-VL-2B-GGUF) and [ONNX package](https://huggingface.co/LiquidAI/LFM3-VL-2B-ONNX)
- [LFM Open License v1.0](../licenses/LFM-OPEN-LICENSE.txt) ([official ONNX repository license](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX/blob/main/LICENSE))
- [Liquid AI ONNX deployment guide](https://docs.liquid.ai/deployment/on-device/onnx)
- [ONNX Runtime Node documentation](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [llama.cpp b11946 release](https://github.com/ggml-org/llama.cpp/releases/tag/b11946) and [LFM3 support PR #31252](https://github.com/ggml-org/llama.cpp/pull/31252)
- [Intelligence feature and benchmark notes](intelligence.md)
