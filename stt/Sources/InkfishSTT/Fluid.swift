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

  static func engines(_ opts: Options) -> [Engine] {
    Model.allCases.map { m in
      let ok = m.supported
      let have = ok && isDownloaded(m, opts)
      return Engine(
        id: m.rawValue, name: m.name, available: ok, ready: have,
        detail: !ok ? "Needs macOS 15" : have ? "Downloaded" : "Download to use",
        subtitle: m.subtitle, family: m.family, size: m.size, languages: m.languages,
        downloadable: ok && !have
      )
    }
  }

  // MARK: prepare / remove / transcribe

  static func remove(_ m: Model, _ opts: Options) throws {
    let dir: URL
    if let v = m.asrVersion { dir = AsrModels.defaultCacheDirectory(for: v) }
    else if m == .nemotron { dir = nemotronDir(opts) }
    else { dir = modelsRoot.appendingPathComponent(Repo.cohereTranscribeCoreml.folderName) }
    if FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.removeItem(at: dir) }
  }

  static func prepare(_ m: Model, _ opts: Options) async throws {
    guard m.supported else { throw STTError("\(m.name) needs macOS 15", code: 3) }
    if let v = m.asrVersion {
      _ = try await AsrModels.download(version: v)
      return
    }
    switch m {
    case .nemotron:
      _ = try await StreamingNemotronMultilingualAsrManager.downloadVariant(
        languageCode: nemotronLanguage(opts), chunkMs: 2240)
    case .cohere:
      try await ModelHub.download(.cohereTranscribeCoreml, to: modelsRoot)
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
    if let v = m.asrVersion {
      let models = try await AsrModels.downloadAndLoad(version: v) // cached → load only
      let asr = AsrManager()
      try await asr.loadModels(models)
      var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
      let r = try await asr.transcribe(url, decoderState: &state)
      text = r.text
      duration = r.duration
    } else if m == .nemotron {
      let samples = try AudioConverter().resampleAudioFile(url)
      duration = Double(samples.count) / 16_000
      let mgr = StreamingNemotronMultilingualAsrManager()
      try await mgr.loadModels(from: nemotronDir(opts))
      _ = try await mgr.process(samples: samples)
      text = try await mgr.finish()
    } else {
      guard let dir = cohereDir() else { throw STTError("Cohere model files missing", code: 3) }
      let samples = try AudioConverter().resampleAudioFile(url)
      duration = Double(samples.count) / 16_000
      let code = opts.locale.language.languageCode?.identifier ?? "en"
      let lang = CohereAsrConfig.Language(rawValue: code) ?? .english
      let models = try await CoherePipeline.loadModels(encoderDir: dir, decoderDir: dir, vocabDir: dir)
      let r = try await CoherePipeline().transcribeLong(audio: samples, models: models, language: lang)
      text = r.text
    }
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return Transcript(
      text: t,
      segments: t.isEmpty ? [] : [Segment(start: 0, end: duration, text: t)],
      runtime: "Core ML (FluidAudio, Neural Engine) · \(m.name)"
    )
  }
}
