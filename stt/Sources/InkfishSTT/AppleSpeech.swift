// Apple Speech (SFSpeechRecognizer). On-device; macOS requires Siri or
// Dictation to be enabled for it to run.
import Foundation
import Speech

enum AppleSpeech {
  static func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not asked yet"
    @unknown default: return "unknown"
    }
  }

  static func recognizer(_ opts: Options) -> SFSpeechRecognizer? {
    SFSpeechRecognizer(locale: opts.locale) ?? SFSpeechRecognizer()
  }

  static func engine(_ opts: Options) -> Engine {
    guard let r = recognizer(opts) else {
      return Engine(id: "apple-speech", name: "Apple Speech", available: false, ready: false,
                    detail: "No recognizer for \(opts.locale.identifier)")
    }
    let auth = SFSpeechRecognizer.authorizationStatus()
    let ready = r.isAvailable && r.supportsOnDeviceRecognition && auth != .denied && auth != .restricted
    let detail: String
    if auth == .denied || auth == .restricted {
      detail = "Speech Recognition \(authName(auth)) in System Settings › Privacy & Security"
    } else if !r.supportsOnDeviceRecognition {
      detail = "No on-device model for \(r.locale.identifier) — turn on Dictation in Keyboard settings"
    } else if !r.isAvailable {
      detail = "Unavailable — turn on Siri or Dictation in System Settings"
    } else {
      detail = "Built in, on-device · needs Siri or Dictation enabled"
    }
    return Engine(id: "apple-speech", name: "Apple Speech", available: true, ready: ready, detail: detail)
  }

  static func authorize() async -> SFSpeechRecognizerAuthorizationStatus {
    let s = SFSpeechRecognizer.authorizationStatus()
    if s != .notDetermined { return s }
    return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
  }

  static func transcribe(_ url: URL, _ opts: Options) async throws -> Transcript {
    let auth = await authorize()
    guard auth == .authorized else {
      throw STTError("Speech Recognition \(authName(auth)) — allow Inkfish in System Settings › Privacy & Security › Speech Recognition", code: 2)
    }
    guard let r = recognizer(opts) else { throw STTError("No speech recognizer for \(opts.locale.identifier)", code: 3) }
    guard r.isAvailable else { throw STTError("Apple Speech unavailable — turn on Siri or Dictation in System Settings", code: 3) }
    let onDevice = r.supportsOnDeviceRecognition
    if !onDevice && !opts.allowNetwork {
      throw STTError("No on-device model for \(r.locale.identifier) — turn on Dictation in System Settings › Keyboard", code: 3)
    }
    r.queue = OperationQueue()
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = onDevice
    request.addsPunctuation = true

    let final: SFSpeechRecognitionResult? = try await withCheckedThrowingContinuation { c in
      var done = false
      _ = r.recognitionTask(with: request) { result, error in
        if done { return }
        if let result, result.isFinal { done = true; c.resume(returning: result) }
        else if let error {
          done = true
          // 1110 = no speech detected → empty transcript, not an error.
          if (error as NSError).code == 1110 { c.resume(returning: nil) } else { c.resume(throwing: error) }
        }
      }
    }
    guard let final else { return Transcript(text: "", segments: []) }

    // Group word segments into phrases split on pauses > 0.8 s.
    var segments: [Segment] = []
    var words: [String] = []
    var start = 0.0, end = 0.0
    for s in final.bestTranscription.segments {
      if !words.isEmpty && s.timestamp - end > 0.8 {
        segments.append(Segment(start: start, end: end, text: words.joined(separator: " ")))
        words = []
      }
      if words.isEmpty { start = s.timestamp }
      words.append(s.substring)
      end = s.timestamp + s.duration
    }
    if !words.isEmpty { segments.append(Segment(start: start, end: end, text: words.joined(separator: " "))) }
    return Transcript(text: final.bestTranscription.formattedString, segments: segments)
  }
}
