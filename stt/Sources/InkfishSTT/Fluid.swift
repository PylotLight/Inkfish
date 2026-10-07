// FluidAudio engines (CoreML on the Apple Neural Engine). Models download from
// Hugging Face on `prepare` and are cached by FluidAudio in
// ~/Library/Application Support/FluidAudio/Models.
import CoreML
import FluidAudio
import Foundation

enum Fluid {
  enum Model: String, CaseIterable {
    case v2 = "parakeet-v2"
    case v3 = "parakeet-v3"
    case ultra = "parakeet-ultra"
    case redux = "parakeet-redux"
    case phonon2 = "phonon-2"
    case flash = "parakeet-flash"
    case nemotron = "nemotron-multilingual"
    case cohere = "cohere-transcribe"

    var name: String {
      switch self {
      case .v2: return "Parakeet v2 · English"
      case .v3: return "Parakeet v3 · Multilingual"
      case .ultra: return "Parakeet Ultra"
      case .redux: return "Parakeet Redux"
      case .phonon2: return "Phonon-2 · English"
      case .flash: return "Parakeet Flash"
      case .nemotron: return "Nemotron 3.5 · Multilingual"
      case .cohere: return "Cohere Transcribe"
      }
    }

    var subtitle: String {
      switch self {
      case .v2: return "NVIDIA Parakeet TDT 0.6B v2 — fastest, best English recall"
      case .v3: return "NVIDIA Parakeet TDT 0.6B v3 — fast, 25 European languages"
      case .ultra: return "Moondream post-trained v3 — most accurate Parakeet"
      case .redux: return "Moondream 1.58-bit v3 — smallest download"
      case .phonon2: return "Fermion five-value v3 — fast English on the ANE"
      case .flash: return "NVIDIA Parakeet TDT-CTC 110M — tiny and quick"
      case .nemotron: return "NVIDIA Nemotron 3.5 streaming — ~40 languages"
      case .cohere: return "Cohere Transcribe 03-2026 — highest accuracy, slowest"
      }
    }

    var family: String {
      switch self {
      case .cohere: return "cohere"
      default: return "nvidia"
      }
    }

    var size: String {
      switch self {
      case .v2: return "~440 MB"
      case .v3: return "~480 MB"
      case .ultra: return "~630 MB"
      case .redux: return "~220 MB"
      case .phonon2: return "~360 MB"
      case .flash: return "~110M params"
      case .nemotron: return "0.6B params"
      case .cohere: return "~2 GB"
      }
    }

    var languages: String {
      switch self {
      case .v2, .phonon2, .flash: return "English"
      case .v3, .ultra, .redux: return "25 languages"
      case .nemotron: return "~40 languages"
      case .cohere: return "14 languages"
      }
    }

    var asrVersion: AsrModelVersion? {
      switch self {
      case .v2: return .v2
      case .v3: return .v3
      case .ultra: return .ultra
      case .redux: return .redux
      case .phonon2: return .phonon2
      case .flash: return .tdtCtc110m
      case .nemotron, .cohere: return nil
      }
    }

    /// Encoder placement. Redux's 2-bit encoder takes 5–25 min to compile for
    /// the Neural Engine on first load (FluidAudio docs: 320–1585 s), longer
    /// than any sane timeout, so the compile never finished and cached — the
    /// "stuck warming up" / "transcription timed out" bug. On the GPU it
    /// decompresses in-kernel: loads in ~1 s and runs faster per window.
    /// Everything else keeps FluidAudio's default (ANE).
    var encoderUnits: MLComputeUnits? { self == .redux ? .cpuAndGPU : nil }

    var placement: String { self == .redux ? "GPU" : "Neural Engine" }

    /// Hugging Face repo for the models that need a non-default encoder placement.
    var repo: Repo { .parakeetRedux }

    /// Redux / Phonon-2 / Cohere q8 use macOS 15 Core ML ops.
    var minMacOS15: Bool { self == .redux || self == .phonon2 || self == .cohere }

    var supported: Bool {
      if minMacOS15, #unavailable(macOS 15) { return false }
      return true
    }
  }

  static var modelsRoot: URL { MLModelConfigurationUtils.defaultModelsDirectory() }

  // MARK: per-model locations

  static func nemotronLanguage(_ opts: Options) -> String {
    opts.locale.language.languageCode?.identifier ?? "auto"
  }

  static func nemotronDir(_ opts: Options) -> URL {
    modelsRoot.appendingPathComponent(Repo.nemotronMultilingual.folderName)
      .appendingPathComponent(StreamingNemotronMultilingualAsrManager.languageDirectory(for: nemotronLanguage(opts)))
      .appendingPathComponent("2240ms")
  }

  /// Cohere files land either in the repo folder or its q8 subfolder.
  static func cohereDir() -> URL? {
    let base = modelsRoot.appendingPathComponent(Repo.cohereTranscribeCoreml.folderName)
    for dir in [base, base.appendingPathComponent("q8")] {
      let ok = ModelNames.CohereTranscribe.requiredModels.allSatisfy {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path)
      }
      if ok { return dir }
    }
    return nil
  }

  static func isDownloaded(_ m: Model, _ opts: Options) -> Bool {
    if let v = m.asrVersion { return AsrModels.modelsExist(at: AsrModels.defaultCacheDirectory(for: v), version: v) }
    switch m {
    case .nemotron:
      return FileManager.default.fileExists(
        atPath: nemotronDir(opts).appendingPathComponent(ModelNames.NemotronMultilingualStreaming.metadata).path)
    case .cohere: return cohereDir() != nil
    default: return false
    }
  }

  /// Where a model's files live on disk.
  static func modelDir(_ m: Model, _ opts: Options) -> URL {
    if let v = m.asrVersion { return AsrModels.defaultCacheDirectory(for: v) }
    if m == .nemotron { return nemotronDir(opts) }
    return modelsRoot.appendingPathComponent(Repo.cohereTranscribeCoreml.folderName)
  }

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
      let have = ok && isDownloaded(m, opts)
      return Engine(
        id: m.rawValue, name: m.name, available: ok, ready: have,
        detail: !ok ? "Needs macOS 15" : have ? "Downloaded" : "Download to use",
        subtitle: m.subtitle, family: m.family, size: m.size, languages: m.languages,
        downloadable: ok && !have,
        bytes: have ? dirSize(modelDir(m, opts)) : 0
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

  static func remove(_ m: Model, _ opts: Options) throws {
    let dir = modelDir(m, opts)
    if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
  }

  /// Downloads resume across runs: FluidAudio streams into `<file>.partial`
  /// with HTTP Range, so killing this process is a pause and `prepare` again
  /// continues where it stopped.
  static func prepare(_ m: Model, _ opts: Options, progress: ProgressHandler? = nil) async throws {
    guard m.supported else { throw STTError("\(m.name) needs macOS 15", code: 3) }
    if let v = m.asrVersion {
      let dir = AsrModels.defaultCacheDirectory(for: v)
      if let units = m.encoderUnits {
        // Don't use AsrModels.download here: after fetching it *loads* every
        // file on the Neural Engine to warm the cache, and for Redux's 2-bit
        // encoder that ANE compile takes 5–25 min (stuck at "Optimising for
        // the Neural Engine · 0%"). Fetch the raw files + vocab instead, then
        // load once with the encoder on the GPU.
        if !AsrModels.modelsExist(at: dir, version: v) {
          try await ModelHub.download(m.repo, to: dir.deletingLastPathComponent(), progressHandler: progress)
          try await ensureVocab(m, dir)
        }
        _ = try await AsrModels.load(from: dir, version: v, encoderComputeUnits: units, progressHandler: progress)
        return
      }
      _ = try await AsrModels.download(version: v, progressHandler: progress)
      // Load once now so any Core ML compile happens during the download
      // (no timeout) instead of on the first transcription; it's cached after.
      _ = try await AsrModels.load(from: dir, version: v, encoderComputeUnits: m.encoderUnits)
      return
    }
    switch m {
    case .nemotron:
      _ = try await StreamingNemotronMultilingualAsrManager.downloadVariant(
        languageCode: nemotronLanguage(opts), chunkMs: 2240, progressHandler: progress)
    case .cohere:
      try await ModelHub.download(.cohereTranscribeCoreml, to: modelsRoot, progressHandler: progress)
      guard cohereDir() != nil else {
        throw STTError("Cohere downloaded but its model files weren't found under \(modelsRoot.path)", code: 4)
      }
    default: break
    }
  }

  static func transcribe(_ url: URL, _ m: Model, _ opts: Options) async throws -> Transcript {
    guard m.supported else { throw STTError("\(m.name) needs macOS 15", code: 3) }
    guard isDownloaded(m, opts) else {
      throw STTError("\(m.name) isn't downloaded yet — download it in Settings › Voice Engine", code: 3)
    }
    let text: String
    var duration = 0.0
    let t0 = Date()
    var loadMs = 0
    if let v = m.asrVersion {
      // Already on disk (checked above) → load only. Never downloadAndLoad:
      // its download step re-runs an ANE warm-up compile when anything is
      // missing, which for Redux ignores the GPU placement below.
      let models = try await AsrModels.load(
        from: AsrModels.defaultCacheDirectory(for: v), version: v, encoderComputeUnits: m.encoderUnits)
      let asr = AsrManager()
      try await asr.loadModels(models)
      loadMs = Int(Date().timeIntervalSince(t0) * 1000)
      var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
      let r = try await asr.transcribe(url, decoderState: &state)
      text = r.text
      duration = r.duration
    } else if m == .nemotron {
      let samples = try AudioConverter().resampleAudioFile(url)
      duration = Double(samples.count) / 16_000
      let mgr = StreamingNemotronMultilingualAsrManager()
      try await mgr.loadModels(from: nemotronDir(opts))
      loadMs = Int(Date().timeIntervalSince(t0) * 1000)
      _ = try await mgr.process(samples: samples)
      text = try await mgr.finish()
    } else {
      guard let dir = cohereDir() else { throw STTError("Cohere model files missing", code: 3) }
      let samples = try AudioConverter().resampleAudioFile(url)
      duration = Double(samples.count) / 16_000
      let code = opts.locale.language.languageCode?.identifier ?? "en"
      let lang = CohereAsrConfig.Language(rawValue: code) ?? .english
      let models = try await CoherePipeline.loadModels(encoderDir: dir, decoderDir: dir, vocabDir: dir)
      loadMs = Int(Date().timeIntervalSince(t0) * 1000)
      let r = try await CoherePipeline().transcribeLong(audio: samples, models: models, language: lang)
      text = r.text
    }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return Transcript(
      text: t,
      segments: t.isEmpty ? [] : [Segment(start: 0, end: duration, text: t)],
      loadMs: loadMs,
      runtime: "Core ML (FluidAudio, \(m.placement)) · \(m.name)"
    )
  }
}
