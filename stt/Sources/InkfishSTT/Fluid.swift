// FluidAudio engine (CoreML): Parakeet Redux. Models download from Hugging
// Face on `prepare` and are cached by FluidAudio in
// ~/Library/Application Support/FluidAudio/Models.
import CoreML
import FluidAudio
import Foundation

enum Fluid {
  enum Model: String, CaseIterable {
    case redux = "parakeet-redux"

    var name: String { "Parakeet Redux" }
    var subtitle: String { "Moondream 1.58-bit v3 — small download, 25 languages" }
    var family: String { "nvidia" }
    var size: String { "~220 MB" }
    var languages: String { "25 languages" }
    var asrVersion: AsrModelVersion { .redux }

    /// Encoder placement. Redux's 2-bit encoder takes 5–25 min to compile for
    /// the Neural Engine on first load (FluidAudio docs: 320–1585 s), longer
    /// than any sane timeout, so the compile never finished and cached — the
    /// "stuck warming up" / "transcription timed out" bug. On the GPU it
    /// decompresses in-kernel: loads in ~1 s and runs faster per window.
    var encoderUnits: MLComputeUnits { .cpuAndGPU }

    var placement: String { "GPU" }

    var repo: Repo { .parakeetRedux }

    /// Redux uses macOS 15 Core ML ops.
    var supported: Bool {
      if #unavailable(macOS 15) { return false }
      return true
    }
  }

  static func isDownloaded(_ m: Model) -> Bool {
    AsrModels.modelsExist(at: modelDir(m), version: m.asrVersion)
  }

  /// Where a model's files live on disk.
  static func modelDir(_ m: Model) -> URL { AsrModels.defaultCacheDirectory(for: m.asrVersion) }

  /// Bytes on disk under a directory (0 when missing).
  static func dirSize(_ url: URL) -> Int64 {
    let keys: [URLResourceKey] = [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .isRegularFileKey]
    guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { return 0 }
    var total: Int64 = 0
    for case let f as URL in e {
      guard let v = try? f.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
      total += Int64(v.totalFileAllocatedSize ?? v.fileAllocatedSize ?? 0)
    }
    return total
  }

  static func engines(_ opts: Options) -> [Engine] {
    Model.allCases.map { m in
      let ok = m.supported
      let have = ok && isDownloaded(m)
      return Engine(
        id: m.rawValue, name: m.name, available: ok, ready: have,
        detail: !ok ? "Needs macOS 15" : have ? "Downloaded" : "Download to use",
        subtitle: m.subtitle, family: m.family, size: m.size, languages: m.languages,
        downloadable: ok && !have,
        bytes: have ? dirSize(modelDir(m)) : 0
      )
    }
  }

  // MARK: prepare / remove / transcribe

  /// The vocab JSON isn't in the repo's required-model set, so a raw
  /// ModelHub.download skips it (FluidAudio #748). Fetch it directly.
  static func ensureVocab(_ m: Model, _ dir: URL) async throws {
    let url = dir.appendingPathComponent(ModelNames.ASR.vocabularyFile)
    if FileManager.default.fileExists(atPath: url.path) { return }
    let remote = try ModelRegistry.resolveModel(m.repo.rawValue, ModelNames.ASR.vocabularyFile)
    let data = try await ModelHub.fetchFile(from: remote, description: ModelNames.ASR.vocabularyFile)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: url, options: [.atomic])
  }

  static func remove(_ m: Model) throws {
    let dir = modelDir(m)
    if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
  }

  /// Downloads resume across runs: FluidAudio streams into `<file>.partial`
  /// with HTTP Range, so killing this process is a pause and `prepare` again
  /// continues where it stopped.
  static func prepare(_ m: Model, progress: ProgressHandler? = nil) async throws {
    guard m.supported else { throw STTError("\(m.name) needs macOS 15", code: 3) }
    let v = m.asrVersion
    let dir = modelDir(m)
    // Don't use AsrModels.download here: after fetching it *loads* every file
    // on the Neural Engine to warm the cache, and for Redux's 2-bit encoder
    // that ANE compile takes 5–25 min (stuck at "Optimising for the Neural
    // Engine · 0%"). Fetch the raw files + vocab instead, then load once with
    // the encoder on the GPU.
    if !AsrModels.modelsExist(at: dir, version: v) {
      try await ModelHub.download(m.repo, to: dir.deletingLastPathComponent(), progressHandler: progress)
      try await ensureVocab(m, dir)
    }
    _ = try await AsrModels.load(from: dir, version: v, encoderComputeUnits: m.encoderUnits, progressHandler: progress)
  }

  static func transcribe(_ url: URL, _ m: Model, _ opts: Options) async throws -> Transcript {
    guard m.supported else { throw STTError("\(m.name) needs macOS 15", code: 3) }
    guard isDownloaded(m) else {
      throw STTError("\(m.name) isn't downloaded yet — download it in Settings › Voice Engine", code: 3)
    }
    let t0 = Date()
    // Already on disk (checked above) → load only. Never downloadAndLoad: its
    // download step re-runs an ANE warm-up compile when anything is missing,
    // which ignores the GPU placement below.
    let models = try await AsrModels.load(from: modelDir(m), version: m.asrVersion, encoderComputeUnits: m.encoderUnits)
    let asr = AsrManager()
    try await asr.loadModels(models)
    let loadMs = Int(Date().timeIntervalSince(t0) * 1000)
    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
    let r = try await asr.transcribe(url, decoderState: &state)
    let t = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
    return Transcript(
      text: t,
      segments: t.isEmpty ? [] : [Segment(start: 0, end: r.duration, text: t)],
      loadMs: loadMs,
      runtime: "Core ML (FluidAudio, \(m.placement)) · \(m.name)"
    )
  }
}
