// Parakeet TDT family via FluidAudio (CoreML, Neural Engine). Models download
// from Hugging Face on first prepare and are cached by FluidAudio in
// ~/Library/Application Support/FluidAudio/Models.
import FluidAudio
import Foundation

enum Parakeet {
  enum Variant: String, CaseIterable {
    case v3 = "parakeet-v3"
    case redux = "parakeet-redux"
    case ultra = "parakeet-ultra"
    case v2 = "parakeet-v2"

    var version: AsrModelVersion {
      switch self {
      case .v3: return .v3
      case .redux: return .redux
      case .ultra: return .ultra
      case .v2: return .v2
      }
    }

    var name: String {
      switch self {
      case .v3: return "Parakeet v3"
      case .redux: return "Parakeet Redux"
      case .ultra: return "Parakeet Ultra"
      case .v2: return "Parakeet v2 (English)"
      }
    }

    var blurb: String {
      switch self {
      case .v3: return "NVIDIA multilingual (25 langs) · ~480 MB"
      case .redux: return "Moondream 1.58-bit · smallest · ~220 MB"
      case .ultra: return "Moondream post-trained v3 · most accurate"
      case .v2: return "English-only, best recall on rare words"
      }
    }

    /// Redux's compressed encoder uses macOS 15 Core ML ops.
    var supported: Bool {
      if self == .redux, #unavailable(macOS 15) { return false }
      return true
    }
  }

  static func cacheDir(_ v: Variant) -> URL { AsrModels.defaultCacheDirectory(for: v.version) }

  static func isDownloaded(_ v: Variant) -> Bool {
    AsrModels.modelsExist(at: cacheDir(v), version: v.version)
  }

  static func engines() -> [Engine] {
    Variant.allCases.map { v in
      let ok = v.supported
      let have = ok && isDownloaded(v)
      return Engine(
        id: v.rawValue, name: v.name, available: ok, ready: have,
        detail: !ok ? "Needs macOS 15" : have ? "\(v.blurb) · downloaded" : "\(v.blurb) · download to use"
      )
    }
  }

  static func prepare(_ v: Variant) async throws {
    guard v.supported else { throw STTError("\(v.name) needs macOS 15", code: 3) }
    _ = try await AsrModels.downloadAndLoad(version: v.version)
  }

  static func transcribe(_ url: URL, _ v: Variant) async throws -> Transcript {
    guard v.supported else { throw STTError("\(v.name) needs macOS 15", code: 3) }
    guard isDownloaded(v) else { throw STTError("\(v.name) isn't downloaded yet — download it in Settings › Transcription", code: 3) }
    let models = try await AsrModels.downloadAndLoad(version: v.version) // cached → load only
    let asr = AsrManager()
    try await asr.loadModels(models)
    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
    let r = try await asr.transcribe(url, decoderState: &state)
    let text = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
    return Transcript(text: text, segments: text.isEmpty ? [] : [Segment(start: 0, end: r.duration, text: text)])
  }
}
