# Local LLM runtimes (implementation plan)

> **Status: implementation plan** (written 2026-10-28, action in a dedicated
> session/worktree). When done, convert this file into a feature doc in the
> style of [docs/stt-options.md](stt-options.md) — or delete it.
>
> Research and rationale: [docs/lfm3.md](lfm3.md). The STT engine system this
> mirrors: `src/main/stt.ts`, `src/shared/stt.ts`, `scripts/bench-stt.ts`,
> `src/renderer/src/views/voice/`.

## Goal

Give Inkfish **local LLM engines** for note processing (cleanup / organise /
summarise — the `intelligence` path), with:

1. **Multiple runtimes**, pluggable behind one interface. **llama.cpp is the
   primary runtime, implemented in this plan.** Ollama is **not** a runtime
   here (the user doesn't use it; the existing loopback *discovery* for
   user-installed servers in `src/main/ai-discovery.ts` stays untouched).
   MLX / ONNX / uzu are designed-for, not implemented — they land as new
   runtime modules when upstream LFM3 support exists (see "Later").
2. **An in-app benchmark modeled on Settings › Voice Engine**: engine list with
   Download / Pause / Resume / Delete / Activate, a Quick/Deep benchmark that
   runs every ready engine on the same yardstick, and a comparison table.
3. **Wiring into the intelligence chain** so the active local engine does
   cleanup/organise/summarise on capture, on any Mac — no Apple Intelligence
   dependency, nothing leaves the machine.

First model: **LFM3-1.7B** (Liquid AI, 2026-10-27): 1.73B, ~1.1 GB at Q4_K_M,
256K context, strong structured output (IFEval 96.7). LFM Open License v1.0 —
commercial use licensed only for entities under $10M annual revenue;
redistribution must carry the license text. Weights are **user-downloaded**
(never in the app binary); the license text ships with the app.

## Architecture

Everything mirrors the STT engine system, with one structural difference:
STT engines run inside the bundled Swift helper; LLM runtimes are **external
binaries** (llama.cpp is C++/Metal), so the runtime module spawns and manages
a child process instead of a helper command.

```
src/shared/llm.ts            contracts: LlmRuntime, LlmEngine, LlmPrefs, status, auto-pick
src/shared/llm-models.ts     model catalog (LFM3-1.7B; per-runtime formats, URLs, sizes, license)
src/shared/llmBench.ts       bench samples + scoring (mirrors src/shared/sttBench.ts)
src/main/llm.ts              engine list / prepare / remove / downloads / prefs / status
src/main/llm-runtimes/       one module per runtime
  llama-cpp.ts               v1 runtime: pinned binary, server lifecycle, OpenAI-compatible chat
src/renderer/src/views/llm/  Settings › Local LLM (mirrors src/renderer/src/views/voice/)
  LlmEngineSettings.tsx      the tab: active engine, other engines, download source, bench
  EngineRow.tsx              one engine row (adapted from voice/EngineRow.tsx)
  BenchControls.tsx          Quick/Deep bench + compare table (adapted from voice/BenchControls.tsx)
  helpers.ts                 Run/Score types, localStorage keys, labels
scripts/fetch-llama.ts       pinned llama.cpp release → llm/bin/ (gitignored), checksum-verified
scripts/bench-llm.ts         CLI benchmark (mirrors scripts/bench-stt.ts)
llm/                         pinned binary dir (gitignored; bundled as Resources/bin/llama/)
  licenses/LFM-OPEN.txt      LFM Open License v1.0 text (committed — redistribution requirement)
```

### Runtime abstraction

```ts
// src/shared/llm.ts
export const LLM_RUNTIME_IDS = ['llama-cpp'] as const   // + 'mlx' | 'onnx' | 'uzu' later
export type LlmRuntimeId = (typeof LLM_RUNTIME_IDS)[number]

export interface LlmRuntime {
  id: LlmRuntimeId
  name: string            // 'llama.cpp (Metal)'
  /** Binary present (bundled release) and runnable on this Mac. */
  available: boolean
  detail: string          // status line / fix-it hint for the UI
  /** Weight format this runtime loads. */
  format: 'gguf' | 'mlx' | 'onnx'
}

export interface LlmEngine {
  /** '<model>:<runtime>', e.g. 'lfm3-1.7b:llama-cpp' — mirrors STT engine ids. */
  id: string
  model: string           // 'lfm3-1.7b'
  runtime: LlmRuntimeId
  name: string            // 'LFM3-1.7B · llama.cpp'
  available: boolean      // can run on this Mac at all (macOS floor, arch)
  ready: boolean          // weights on disk + runtime available
  detail: string
  size?: string           // '1.1 GB'
  bytes?: number          // on disk, once downloaded
  downloadable: boolean
  contextWindow?: number  // 256_000
  license?: string        // 'LFM Open License v1.0'
}
```

- **Engine = model × runtime.** The catalog (`llm-models.ts`) lists models; the
  runtime registry lists runtimes; `listEngines()` is the cross product, with
  one row per (model, runtime) the catalog declares. v1: one model (LFM3-1.7B)
  × one runtime (llama.cpp) = one engine.
- **Auto-pick** mirrors `pickAutoEngine` (`src/shared/stt.ts`):

```ts
/** Auto-pick order among *ready* engines when the user hasn't chosen one. */
export const LLM_AUTO_ORDER = ['lfm3-1.7b:llama-cpp']
export function pickAutoLlmEngine<T extends { id: string; ready: boolean }>(engines: T[]): T | undefined {
  for (const id of LLM_AUTO_ORDER) {
    const e = engines.find((x) => x.id === id && x.ready)
    if (e) return e
  }
  return undefined
}
```

- **Adding a runtime later** (the pluggable part): add the id to
  `LLM_RUNTIME_IDS`, a module in `src/main/llm-runtimes/` implementing
  `LlmRuntimeBackend` (below), and the model's formats in the catalog. Nothing
  else changes — engines, downloads, UI, bench and wiring are all driven by the
  registry.

```ts
// src/main/llm-runtimes/llama-cpp.ts implements:
export interface LlmRuntimeBackend {
  readonly id: LlmRuntimeId
  /** Status for listEngines(): binary present? macOS floor met? */
  status(): LlmRuntime
  /** Where this engine's weights live; null when not downloaded. */
  modelPath(engine: LlmEngine): string | null
  /** Ensure a server for this engine is up; resolves { baseUrl, port } or throws. */
  ensureServer(engine: LlmEngine): Promise<{ baseUrl: string; port: number }>
  /** One chat completion. `thinking: false` is the default for LFM3 (JSON tasks). */
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmCompletion>
  /** Kill this engine's server (idle reap, removal, quit). */
  shutdown(engineId: string): void
}
```

### Model catalog

```ts
// src/shared/llm-models.ts
export interface LlmModelFormat {
  /** Which runtime this format feeds. */
  runtime: LlmRuntimeId
  /** File name in the download dir, e.g. 'LFM3-1.7B-Q4_K_M.gguf'. */
  file: string
  url: string             // Hugging Face resolve URL
  bytes: number           // published size, for the size tag + download estimate
  size: string            // '1.1 GB'
}

export interface LlmModel {
  id: string              // 'lfm3-1.7b'
  name: string            // 'LFM3-1.7B'
  family: string          // 'liquid' — drives the badge, like SttEngine.family
  contextWindow: number   // 256_000
  maxOutputTokens?: number
  license: string         // 'LFM Open License v1.0'
  licenseUrl: string      // https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE
  /** Thinking is on by default in the chat template; JSON tasks run with it off. */
  thinkingDefault: boolean
  formats: LlmModelFormat[]
}

export const LLM_MODELS: LlmModel[] = [
  {
    id: 'lfm3-1.7b',
    name: 'LFM3-1.7B',
    family: 'liquid',
    contextWindow: 256_000,
    maxOutputTokens: 32_768,   // request cap; the model supports far more
    license: 'LFM Open License v1.0',
    licenseUrl: 'https://huggingface.co/LiquidAI/LFM3-1.7B/raw/main/LICENSE',
    thinkingDefault: true,
    formats: [
      {
        runtime: 'llama-cpp',
        file: 'LFM3-1.7B-Q4_K_M.gguf',   // verify exact file name in the GGUF repo
        url: 'https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/main/LFM3-1.7B-Q4_K_M.gguf',
        bytes: 1_100_000_000,
        size: '~1.1 GB'
      }
    ]
  }
]
```

(One format in v1 — Q4_K_M is the safe standard quant. The QAD Q4_0 variant
(1.05 GB) can be added as a second format later if its llama.cpp support
proves solid.)

### Downloads (reuse the STT proxy machinery)

Same pattern as `src/main/stt.ts › prepareEngine`:

- `createModelDownloadProxy(getProxySettings(), isBlocked)` from
  `src/main/model-download-proxy.ts` — loopback HTTP(S) bridge that applies
  Inkfish's per-destination SOCKS policy and keeps TLS end-to-end.
- `onProxyChanging(() => pauseAllLlmDownloadsForProxyChange())` from
  `src/main/proxy-state.ts` — pause in-flight downloads when routing changes.
- `modelDownloadEnvironment` is for child processes; the LLM download runs in
  the main process, so it goes **through the bridge** with a small client
  (task 1.5): absolute-form GET for `http:` targets, `CONNECT` + `tls.connect`
  for `https:` targets. `Range: bytes=<n>-` resume, `AbortController` pause,
  4-attempt backoff with the same `BLOCKED_RE` "Hugging Face unreachable"
  detection as stt.ts, mirror repointing (`hf-mirror.com`).
- Weights land in `appDataDir()/llm/models/<model-id>/<file>` (app data, like
  `intelligence.json` — **not** a shared dir like FluidAudio's). On first
  download, write `llm/licenses/LFM-OPEN.txt` content next to the weights
  (redistribution must carry the license text) and show the license in the UI.
- Progress events reuse the shared `DownloadProgress` type
  (`src/shared/types.ts`), broadcast on an `llm:progress` channel.

### Server lifecycle (llama.cpp)

- Binary: bundled pinned release. Dev: `llm/bin/llama-server`; packaged:
  `Resources/bin/llama/llama-server` (same `helperPath()`-style candidate
  lookup as `src/main/stt.ts › helperPath`).
- Spawn (one server per loaded model, on demand):

```
llama-server -m <gguf> --host 127.0.0.1 --port <freePort>
  --ctx-size 32768 --parallel 1 --no-webui --reasoning off
```

  - `--reasoning off`: LFM3's chat template thinks by default; every capture
    paying reasoning tokens would be a latency and JSON-validity tax. (Per
    research in docs/lfm3.md. If the pinned build lacks the flag, fall back to
    per-request `chat_template_kwargs: { enable_thinking: false }` — the task
    verifies which works in b11945.)
  - Port: bind a `net` server on `127.0.0.1:0`, read the port, close it, spawn
    with it (loopback race is acceptable).
  - Ready = `GET {base}/health` (poll, 120 s timeout — first Metal load is
    slow) or `/v1/models` listing the model.
  - Idle reap: no completion for 10 min → kill. Kill all on `app will-quit`
    (register in `src/main/index.ts` where other teardown lives) and on model
    removal.
- Chat: `POST {base}/v1/chat/completions` (llama-server is OpenAI-compatible).
  Non-streaming for intelligence tasks (we need the whole JSON reply); the
  response's `timings` object (`prompt_ms`, `text_ms`, `prompt_n`, `text_n`)
  feeds the benchmark. Sampling in the body: `temperature` (from prefs,
  default 0.2), `top_k: 50`, `repeat_penalty: 1.1` (model card),
  `max_tokens` from the model's `maxOutputTokens`, `stream: false`.

### Intelligence wiring

`IntelPrefs.provider` (`src/shared/intelligence.ts`) widens from
`'apple' | 'off'` to **`'apple' | 'local' | 'off'`** (existing values
migrate unchanged; `sanitize()` accepts `'local'`).

- `src/main/intelligence.ts › intelRun()`: when `prefs.provider === 'local'`,
  dispatch to `llmIntelRun(req)` in `src/main/llm.ts` instead of the helper.
  `llmIntelRun` resolves the active engine (prefs, else `pickAutoLlmEngine`),
  `ensureServer()`, builds the same prompt shape `Intelligence.swift` uses
  (note in `<note>` tags, style/instructions/temperature from prefs, exact
  JSON fields: `text`, `title`, `project`, `tags`, `summary`, `action_items`),
  runs with thinking off, parses the JSON (one retry with a stricter prompt on
  parse failure; still failing → throw, callers fall back to rules as today).
  Returns the shared `IntelResult` with `runtime: 'lfm3-1.7b · llama.cpp'`.
  **No chunking**: 256K context means a normal note is one request; cap the
  prompt at 32K tokens (drop the tail with a marker) instead of Apple's
  2.4k-char chunks.
- `src/main/ai.ts`:
  - `classify()` step 2: `intel.provider === 'off'` → return rules result (as
    today); `'apple'` → `intelRun` (as today); `'local'` → `llmIntelRun`
    inside the existing try/catch (unavailable → rules result).
  - `summarize()`: same dispatch.
  - `providerStatus()`: add `{ id: 'local', available: <active engine ready>,
    detail: 'LFM3-1.7B · llama.cpp — 1.1 GB, downloaded' | 'no local model
    ready — Settings › Local LLM' }`.
- `src/main/ipc.ts › route:preview`: `aiReady` gains
  `intel.provider === 'local' && intel.organize` (cheap: file-exists check).
- `IntelligenceSettings.tsx`: the "Use Apple Intelligence" switch becomes an
  **Engine** seg-row: `Apple Intelligence | Local LLM | Off`. The Local option
  is disabled with a "no local model ready — download in Settings › Local LLM"
  hint when no engine is ready. Everything below (cleanup/organise/action
  items/style/creativity/words/try-it playground) applies to both engines;
  the playground runs on whichever engine is selected.

### In-app benchmark (mirrors the STT system)

STT scores WER against a reference transcript; a text model has no WER, so the
yardstick is **task quality + speed** on the same fixed samples every run:

- `src/shared/llmBench.ts` (mirrors `sttBench.ts`):
  - `LlmBenchSample`: `{ id, label, kind, text, expectedProject?, expectedTags?, keep: string[] }`
    — messy notes with known-good outcomes. Quick = one sample (reuse
    `INTEL_SAMPLE` from `src/shared/intelligence.ts`); Deep = 4–5 samples
    (messy dictation, a meeting-ish note, a long note, a note full of to-dos).
    Samples are inline text — no assets, no downloads.
  - `LlmBenchRun` per engine per sample: `jsonValid` (organize reply parses),
    `projectMatch` (exact, like `matchProject` in intelligence.ts),
    `tagOverlap` (0..1), `retain` (fraction of `keep` keywords present in the
    cleaned text — content preservation), `ttftMs`, `tokPerSec`
    (`text_n / (text_ms/1000)` from the server's `timings`), plus `warmMs`
    (cold first run, incl. server spawn) and `loadMs`.
  - `LlmBenchMode = 'quick' | 'deep'`, `LLM_BENCH_MODES` table, `fmtTokPerSec`,
    `fmtMsShort` (the two formatters duplicated from sttBench.ts with a
    comment — cross-domain imports are worse than a 4-line duplicate).
- In-app (`views/llm/BenchControls.tsx`, adapted from `voice/BenchControls.tsx`):
  Quick/Deep segment, "Benchmark N engines" (sequential — one model at a time
  on the GPU, same rationale as the STT bench), per-engine run states,
  "Use your own note" (paste text → all ready engines run cleanup+organize on
  it, outputs + timings shown, unscored), localStorage scores
  (`inkfish.llmScores` / `.deep`, hidden list `inkfish.llmHidden` — same
  pattern as `voice/helpers.ts`).
- Comparison table (`LlmEngineSettings.tsx`, mirroring the voice bench table):
  Model · Size · Quick (org ✓/✗, retain) · Deep · tok/s · TTFT · Warm-up ·
  Load · Context. Best value per column highlighted, like the voice table.
- CLI: `scripts/bench-llm.ts` (mirrors `bench-stt.ts`): `bun run bench:llm
  [--quick|--deep] [--runs N]` → `llm-bench-results.json` (gitignored).

### What is deliberately not in this plan

- **Ollama as an embedded runtime.** Not a thing. (The existing
  `ai-discovery.ts` loopback discovery for *user-installed* servers — Ollama,
  LM Studio, LiteLLM — is untouched; that's the AI-provider feature, not the
  local engine system.)
- **The `'local'` AI-provider kind** (Settings › AI, Prompt API per-note
  actions): the documented seam (`src/shared/ai-api.ts` line 9–11) is ready for
  it, but it's a separate feature — "Later" below.
- **MLX / ONNX / uzu runtimes, and the VL / d1 / Audio / Omni models** —
  upstream LFM3 support doesn't exist yet (docs/lfm3.md matrix). The registry
  is designed for them; they're "Later".

## Tech stack

- Bun + Electron + TypeScript, arm64 macOS only (the app's existing floor).
- llama.cpp pinned release **b11945** (2026-10-28; first release with LFM3
  support) — MIT, bundled as a binary, never built from source.
- Hugging Face for weights (`LiquidAI/LFM3-1.7B-GGUF`), through the existing
  model-download proxy bridge.
- No new npm dependencies. No python/pip/Homebrew (the STT rule applies).

## File map

| File | New/changed | What |
| --- | --- | --- |
| `src/shared/llm.ts` | new | contracts + auto-pick + prefs types |
| `src/shared/llm-models.ts` | new | model catalog |
| `src/shared/llmBench.ts` | new | bench samples + scoring |
| `src/shared/llm.test.ts`, `src/shared/llm-models.test.ts`, `src/shared/llmBench.test.ts` | new | unit tests (bun test) |
| `src/main/llm.ts` | new | engines, downloads, prefs, status, `llmIntelRun` |
| `src/main/llm-runtimes/llama-cpp.ts` | new | the v1 runtime |
| `src/main/llm.test.ts` | new | download state machine + server args (injected fetch/net) |
| `src/main/ipc.ts` | changed | `llm:*` channels + `llm:progress` broadcast |
| `src/preload/index.ts` | changed | `window.api.llm` |
| `src/shared/intelligence.ts` | changed | `provider: 'apple' \| 'local' \| 'off'` |
| `src/main/intelligence.ts` | changed | dispatch local |
| `src/main/ai.ts` | changed | classify/summarize/providerStatus |
| `src/renderer/src/views/llm/*` | new | Settings › Local LLM (4 files, mirror voice/) |
| `src/renderer/src/views/Settings.tsx` | changed | new Intelligence-group tab |
| `src/renderer/src/views/IntelligenceSettings.tsx` | changed | engine seg-row |
| `scripts/fetch-llama.ts` | new | pinned release fetch + checksum |
| `scripts/bench-llm.ts` | new | CLI benchmark |
| `llm/licenses/LFM-OPEN.txt` | new | license text (committed) |
| `llm/bin/` | gitignored | fetched binaries |
| `package.json` | changed | scripts + `extraResources` for `llm/bin` |
| `.gitignore` | changed | `/llm/bin/`, `llm-bench-results.json` |
| `docs/intelligence.md`, `docs/lfm3.md`, `DEVELOPING.md` | changed | docs |

## Tasks

Each task ends in a commit. `bun test` and `bun check` must pass after every
task. "Mirror X" means: same shape and conventions as the named file, adapted
as described — read it first.

### Phase 1 — runtime + model management

- [ ] **1.1 Contracts** — `src/shared/llm.ts`: `LLM_RUNTIME_IDS`, `LlmRuntime`,
  `LlmEngine`, `LlmRequest`/`LlmCompletion` (messages, `thinking`, sampling,
  `timings`), `LlmStatus`, `LlmPrefs` (`{ engine: string }`, `''` = auto),
  `DEFAULT_LLM_PREFS`, `LLM_AUTO_ORDER`, `pickAutoLlmEngine`,
  `engineId(model, runtime)`. Test: `src/shared/llm.test.ts` (auto-pick over
  ready/not-ready lists; id round-trip).
- [ ] **1.2 Catalog** — `src/shared/llm-models.ts` per the sketch above.
  **Verify the exact GGUF file name** in
  `https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF` (file listing) and the real
  byte size; fix the URL/bytes accordingly. Test: catalog invariants (unique
  ids, every format's runtime is in `LLM_RUNTIME_IDS`, positive sizes).
- [ ] **1.3 Pinned llama.cpp** — `scripts/fetch-llama.ts` (mirror
  `scripts/build-stt.ts`): constant `LLAMA_BUILD = 'b11945'`; download
  `https://github.com/ggml-org/llama.cpp/releases/download/b11945/
  llama-b11945-bin-macos-arm64.zip` (**verify the exact asset name on the
  release page**), record its **sha256 in the script**, verify before
  extracting; `unzip -j` only `llama-server` into `llm/bin/`; skip when the
  binary is newer than a `llm/.version` stamp file (write the build id);
  no-op off macOS. `package.json`: `"llama:fetch": "bun scripts/fetch-llama.ts"`,
  add it to `build` after `build-stt`; `extraResources` gains
  `{ "from": "llm/bin", "to": "bin/llama", "filter": ["**/*"] }`; `.gitignore`
  gains `/llm/bin/`. **Verify the release's minimum macOS** (run it on the
  oldest supported Mac you have, or check the release notes); if the floor is
  above the app's 12, note it — task 1.4 uses it for `available`.
- [ ] **1.4 llama.cpp runtime** — `src/main/llm-runtimes/llama-cpp.ts`
  implementing `LlmRuntimeBackend` (interface in `src/shared/llm.ts`):
  `binaryPath()` (Resources/bin/llama/llama-server, dev `llm/bin/` — the
  `helperPath()` candidate pattern from stt.ts); `status()` (binary exists;
  macOS floor from 1.3 → `available`/`detail`); `ensureServer()` (free port,
  spawn with the args above, poll `/health` up to 120 s, track
  `{ proc, baseUrl, port, lastUse }`, 10-min idle-reap timer, `shutdown()`);
  `complete()` (non-streaming `/v1/chat/completions` via fetch, body per the
  sketch, map `timings` → `LlmCompletion`, surface HTTP errors as readable
  messages). Test: arg construction, `timings` mapping, ready-poll against a
  stub `http` server.
- [ ] **1.5 Bridge fetch** — in `src/main/llm.ts`: `bridgeFetch(target: URL,
  { method, headers, signal }): Promise<{ status, headers, body:
  ReadableStream | null }>` — `http:` → absolute-form GET through the bridge
  socket; `https:` → `CONNECT host:port` through the bridge, then
  `tls.connect({ socket, servername })`, then the request. Reuse
  `createModelDownloadProxy`/`getProxySettings`/`isProxyTransitioning`/
  `onProxyChanging` exactly as `src/main/stt.ts` does. Test: stand up a local
  `http` server + the real bridge, download a file with resume (`Range`),
  assert bytes + that a proxy-change pause aborts it.
- [ ] **1.6 Engine management** — `src/main/llm.ts`: `listEngines()` (catalog ×
  runtime registry; `ready` = weights exist + runtime available; `bytes` from
  disk; `downloadable` = has a format for a ready runtime); `prepareEngine(id,
  onProgress, mirror)` (the stt.ts download state machine, via `bridgeFetch`:
  partial file + `.partial` suffix until done, Range resume, 4-attempt backoff,
  `BLOCKED_RE`, mirror repoint, pause = abort + keep partial, write the license
  file next to the weights); `pauseDownload` / `clearDownload` /
  `removeEngine` (delete weights + license copy + `shutdown` the server if it
  was this model) / `downloadProgress()`; `onProxyChanging` hook; prefs in
  `appDataDir()/llm/local-llm.json` (load/save/sanitize like
  `intelligence.ts`); `llmStatus()` (active engine + server state);
  `llmIntelRun()` per the wiring sketch (prompt, thinking off, JSON parse +
  one retry, `IntelResult`). Test: the download state machine with an injected
  `bridgeFetch` (resume, pause, retry, blocked); prefs sanitize; `llmIntelRun`
  JSON parsing against fixture replies (valid, fenced-JSON, garbage).
- [ ] **1.7 IPC + preload** — `src/main/ipc.ts`: `llm:engines`, `llm:prepare`
  (with progress broadcast to all windows, `llm:progress`), `llm:pause`,
  `llm:clear-download`, `llm:downloads`, `llm:remove`, `llm:status`,
  `llm:prefs`, `llm:set-prefs`, `llm:run` (playground: one engine, one task,
  one text → `IntelResult`), `llm:bench` (one engine, one sample →
  `LlmBenchRun`; the renderer loops engines/samples like the voice bench).
  `src/preload/index.ts`: `llm` section mirroring the `stt` section.
- [ ] **1.8 Settings tab** — `src/renderer/src/views/llm/` (mirror
  `views/voice/`): `LlmEngineSettings.tsx` (active engine up top, others
  below, download-source select with the same Hugging Face / hf-mirror /
  custom options, a "Used for" hint line pointing at Settings › Apple
  Intelligence's engine choice), `EngineRow.tsx` (same actions: Download /
  Pause / Resume / Retry / cancel / Activate / Hide / Delete; tags: size,
  context, license, bench scores once phase 3 lands), `helpers.ts` (Run/Score
  types, `inkfish.llmScores`/`inkfish.llmHidden` keys, `sizeLabel`,
  `phaseLabel` — copy from voice/helpers.ts, swap the keys).
  `Settings.tsx`: tab `{ id: 'local-llm', label: 'Local LLM', icon: '⚡',
  group: 'Intelligence' }` after `apple-intelligence`, rendered like
  `{tab === 'voice' && <VoiceEngineSettings />}`.
- [ ] **1.9 Smoke** — manual: `bun run llama:fetch && bun run dev` → Settings
  › Local LLM → Download (watch progress through a proxy change: it must
  pause) → Activate → confirm `llm-server` is spawned on loopback and
  idle-reaped after 10 min; `llama-server` killed on quit.

### Phase 2 — intelligence wiring

- [ ] **2.1 `IntelPrefs.provider`** — `src/shared/intelligence.ts`: widen to
  `'apple' | 'local' | 'off'`; `sanitize()` accepts `'local'`; existing stored
  prefs unchanged. Test the migration in the existing intel tests (add
  `src/shared/intelligence.test.ts` if absent).
- [ ] **2.2 Dispatch** — `src/main/intelligence.ts › intelRun()`: `provider ===
  'local'` → `llmIntelRun` (from 1.6); `'apple'` → helper (unchanged).
  `intelStatus()`: for `'local'`, report the active engine's readiness as
  `{ available, reason: 'local' | 'helper' | …, detail }` so the UI's
  fix-it hints work for both.
- [ ] **2.3 Callers** — `src/main/ai.ts`: `classify()` step 2 and
  `summarize()` dispatch on `intel.provider` (local unavailable → existing
  rules fallback, capture never blocks); `providerStatus()` gains the `local`
  entry. `src/main/ipc.ts › route:preview`: `aiReady` includes local.
- [ ] **2.4 UI** — `IntelligenceSettings.tsx`: engine seg-row
  (Apple Intelligence / Local LLM / Off, with the local-disabled hint);
  playground runs on the selected engine (`window.api.intel.run` keeps its
  shape — main dispatches); the "Try it" output already shows `runtime`, which
  now reads e.g. `lfm3-1.7b · llama.cpp`.
- [ ] **2.5 Smoke** — capture a messy note with Local selected: it cleans up +
  organises on-device; with Apple selected: unchanged; with Off: rules.
  `bun test` green.

### Phase 3 — in-app benchmark

- [ ] **3.1 `src/shared/llmBench.ts`** — per the sketch: `LLM_BENCH_SAMPLE`
  (quick = `INTEL_SAMPLE`), `LLM_DEEP_SAMPLES` (4 more, written to have
  unambiguous expected projects/tags/keep-words), `LlmBenchRun`,
  `scoreLlmRun(sample, result, timings)` (jsonValid / projectMatch /
  tagOverlap / retain / ttftMs / tokPerSec), `LLM_BENCH_MODES`, `fmtTokPerSec`
  + `fmtMsShort`. Test: scoring against fixture replies (valid, fenced,
  garbage, wrong project, dropped keywords).
- [ ] **3.2 Bench UI** — `views/llm/BenchControls.tsx` (adapt
  `voice/BenchControls.tsx`: no mic/file recording — replace with "Use your
  own note" paste; sequential runs; per-engine states; localStorage scores)
  and the comparison table in `LlmEngineSettings.tsx` (columns per the
  sketch; best-per-column highlight; hidden engines excluded).
- [ ] **3.3 CLI** — `scripts/bench-llm.ts` (mirror `bench-stt.ts`: `--quick` /
  `--deep` / `--runs N` median, size table, writes `llm-bench-results.json`);
  `package.json` `"bench:llm"`; `.gitignore` `llm-bench-results.json`.
- [ ] **3.4 Smoke** — Settings › Local LLM → Benchmark 1 engine (quick, then
  deep); table + row tags update; scores survive a restart.

### Phase 4 — docs, license, polish

- [ ] **4.1 License** — `llm/licenses/LFM-OPEN.txt` (the full LFM Open License
  v1.0 text from the model card URL); written next to downloaded weights (1.6);
  shown in the engine row subtitle and the Local LLM tab hint; `docs/lfm3.md`
  note that the app now ships the license text.
- [ ] **4.2 Docs** — `docs/intelligence.md`: new "Local LLM" section (engine,
  where it's used, settings) + "Next" updated; `docs/lfm3.md`: mark the
  llama.cpp path as implemented, link here; `DEVELOPING.md` docs index: this
  file. Then **convert this plan into the feature doc** (drop the task list,
  keep Goal/Architecture/file map as the design record) or delete it.
- [ ] **4.3 Polish** — engine `detail` strings for every state (no binary,
  macOS floor, downloading, ready, server busy); memory note in the tab hint
  (~1 GB while loaded); `bun test` + `bun check` + `bun run format:check`
  green; `bun run dist:dir` builds with the llama binary in
  `Resources/bin/llama/`.

### Later (designed-for, not specced — one task each when upstream lands)

- **MLX runtime** — when mlx-swift/mlx-lm lands LFM3 (Liquid says "in
  progress"): Swift helper or `mlx_lm.server` binary; catalog format
  `LFM3-1.7B-MLX-4bit` (973 MB).
- **ONNX runtime** — official ONNX card + WebGPU path are documented today
  (`model_q4f16`, 1.38 GB, ≤256-token prefill chunks): renderer-side
  `onnxruntime-web` engine, no native binary; expect slower decode than Metal.
- **uzu runtime** — when `lalamo` adds an LFM3 ModelSpec: Swift SPM uniffi
  binding, in-process (no subprocess), built-in download + JSON-grammar
  structured output — the best ergonomics of the three.
- **`'local'` AI-provider kind** — `AI_PROVIDER_KINDS` + `createProvider`
  branch talking to the local server: per-note Prompt API actions on the local
  model (the seam is documented in `src/shared/ai-api.ts`).
- **More models** — LFM3-VL-2B (images in notes: OCR/caption/grounding),
  d1-2B (routing with calibrated confidence — fixes the hardcoded 0.6),
  Audio-2B/Omni-2B (a third STT engine; 18 languages, live ASR).

## Open questions to resolve while implementing

1. Exact llama.cpp asset name + sha256 for b11945 (release page), and its
   minimum macOS vs the app's 12 floor → drives `available` + docs.
2. Exact GGUF file name/size in `LiquidAI/LFM3-1.7B-GGUF` (Q4_K_M).
3. `--reasoning off` vs per-request `enable_thinking: false` in b11945 —
   verify which the LFM3 template honours (bench both; the plan uses the
   spawn flag).
4. Does b11945's `llama-server` include the `timings` object in
   non-streaming responses (the bench's tok/s source)? If not, time the
   request wall-clock and drop `tokPerSec` for `tokPerSecWall`.
