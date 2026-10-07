// Apple SpeechAnalyzer + SpeechTranscriber (macOS 26). Compiled only with the
// macOS 26 SDK (Swift 6.2+); older toolchains get a stub that reports
// "unavailable" so the helper still builds everywhere.
import AVFoundation
import Foundation
#if compiler(>=6.2)
import Speech
#endif

enum AppleAnalyzer {
  static let id = "apple-analyzer"
  static let name = "Apple Speech · macOS 26+"
  static let subtitle = "SpeechAnalyzer — Apple's new on-device transcriber"

  static func engine(_ opts: Options) async -> Engine {
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
      let locale = await SpeechTranscriber.supportedLocale(equivalentTo: opts.locale)
      guard let locale else {
        return Engine(id: id, name: name, available: false, ready: false,
                      detail: "Language \(opts.locale.identifier) not supported", subtitle: subtitle)
      }
      return Engine(id: id, name: name, available: true, ready: true,
                    detail: "Ready · fetches language assets on first use",
                    subtitle: subtitle, size: "Built in", languages: locale.identifier)
    }
    return Engine(id: id, name: name, available: false, ready: false, detail: "Needs macOS 26", subtitle: subtitle)
    #else
    return Engine(id: id, name: name, available: false, ready: false, detail: "Built without the macOS 26 SDK", subtitle: subtitle)
    #endif
  }

  static func prepare(_ opts: Options) async throws {
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
      _ = try await makeTranscriber(opts)
      return
    }
    #endif
    throw STTError("SpeechAnalyzer needs macOS 26", code: 3)
  }

  #if compiler(>=6.2)
  @available(macOS 26, *)
  static func makeTranscriber(_ opts: Options) async throws -> SpeechTranscriber {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: opts.locale) else {
      throw STTError("SpeechAnalyzer doesn't support \(opts.locale.identifier)", code: 3)
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await install.downloadAndInstall()
    }
    return transcriber
  }
  #endif

  static func transcribe(_ url: URL, _ opts: Options) async throws -> Transcript {
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
      let transcriber = try await makeTranscriber(opts)
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let collect = Task { () throws -> String in
        var parts: [String] = []
        for try await result in transcriber.results {
          parts.append(String(result.text.characters))
        }
        return parts.joined(separator: " ")
      }
      let file = try AVAudioFile(forReading: url)
      if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
      } else {
        await analyzer.cancelAndFinishNow()
      }
      let text = try await collect.value.trimmingCharacters(in: .whitespacesAndNewlines)
      let dur = Double(file.length) / file.processingFormat.sampleRate
      return Transcript(text: text, segments: text.isEmpty ? [] : [Segment(start: 0, end: dur, text: text)])
    }
    #endif
    throw STTError("SpeechAnalyzer needs macOS 26", code: 3)
  }
}
