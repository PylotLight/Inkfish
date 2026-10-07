// inkfish-stt — Apple Speech CLI for Inkfish (macOS 12+).
//
//   inkfish-stt <audio> [--json] [--locale en-AU] [--allow-network]
//   inkfish-stt --check            # prints {"available":..,"onDevice":..,"auth":..}
//
// Prints `{"text": "...", "segments": [{"start","end","text"}]}` on stdout —
// the same contract `transcribe()` (src/main/ai.ts) expects from parakeet-cli.
// On-device recognition only, unless --allow-network is passed (keeps the
// offline default). Exit codes: 2 not authorized, 3 recognizer unavailable,
// 4 recognition failed, 64 usage.
import Foundation
import Speech

struct Segment: Encodable { let start: Double; let end: Double; let text: String }
struct Output: Encodable { let text: String; let segments: [Segment]; let onDevice: Bool; let locale: String }
struct Check: Encodable { let available: Bool; let onDevice: Bool; let auth: String; let locale: String }

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(("inkfish-stt: " + msg + "\n").data(using: .utf8)!)
  exit(code)
}

func emit<T: Encodable>(_ value: T) {
  let enc = JSONEncoder()
  guard let data = try? enc.encode(value) else { fail("could not encode output", 4) }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// Spin the main run loop until `done()` (callbacks land on the main queue).
func spin(timeout: TimeInterval, _ done: () -> Bool) {
  let deadline = Date(timeIntervalSinceNow: timeout)
  while !done() && Date() < deadline {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
  }
}

func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func authorize() -> SFSpeechRecognizerAuthorizationStatus {
  var status = SFSpeechRecognizer.authorizationStatus()
  if status != .notDetermined { return status }
  var answered = false
  SFSpeechRecognizer.requestAuthorization { s in
    DispatchQueue.main.async { status = s; answered = true }
  }
  spin(timeout: 120) { answered }
  return status
}

// --- args ---------------------------------------------------------------------
var path: String?
var localeId: String?
var allowNetwork = ProcessInfo.processInfo.environment["INKFISH_STT_ALLOW_NETWORK"] == "1"
var checkOnly = false
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
  switch a {
  case "--json": break // always JSON; accepted for parakeet-cli parity
  case "--locale": localeId = it.next()
  case "--allow-network": allowNetwork = true
  case "--check": checkOnly = true
  case "-h", "--help": fail("usage: inkfish-stt <audio> [--json] [--locale en-AU] [--allow-network] | --check", 64)
  default: if path == nil && !a.hasPrefix("--") { path = a }
  }
}

let locale = Locale(identifier: localeId ?? Locale.current.identifier)
guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
  fail("no speech recognizer for locale \(locale.identifier)", 3)
}

if checkOnly {
  emit(Check(
    available: recognizer.isAvailable,
    onDevice: recognizer.supportsOnDeviceRecognition,
    auth: authName(SFSpeechRecognizer.authorizationStatus()),
    locale: recognizer.locale.identifier
  ))
  exit(0)
}

guard let path else { fail("usage: inkfish-stt <audio> [--json] [--locale en-AU]", 64) }
guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)", 64) }

let auth = authorize()
guard auth == .authorized else {
  fail("speech recognition \(authName(auth)) — allow Inkfish in System Settings › Privacy & Security › Speech Recognition", 2)
}
guard recognizer.isAvailable else { fail("speech recognizer unavailable right now", 3) }

let onDevice = recognizer.supportsOnDeviceRecognition
if !onDevice && !allowNetwork {
  fail("on-device recognition not available for \(recognizer.locale.identifier) — turn on Dictation in System Settings › Keyboard so macOS downloads the language, or set INKFISH_STT_ALLOW_NETWORK=1", 3)
}

let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
request.shouldReportPartialResults = false
request.requiresOnDeviceRecognition = onDevice
if #available(macOS 13, *) { request.addsPunctuation = true }

var finished = false
var final: SFSpeechRecognitionResult?
var failure: Error?
let task = recognizer.recognitionTask(with: request) { result, error in
  if let result, result.isFinal { final = result; finished = true }
  else if let error { failure = error; finished = true }
}
spin(timeout: 600) { finished }
if !finished { task.cancel(); fail("timed out", 4) }

guard let final else {
  // "No speech detected" is an empty transcript, not a crash.
  let ns = failure as NSError?
  if ns?.code == 1110 { emit(Output(text: "", segments: [], onDevice: onDevice, locale: recognizer.locale.identifier)); exit(0) }
  fail("recognition failed: \(failure?.localizedDescription ?? "unknown error")", 4)
}

// Group word segments into phrases split on pauses > 0.8 s.
var segments: [Segment] = []
var words: [String] = []
var segStart = 0.0
var segEnd = 0.0
for s in final.bestTranscription.segments {
  let start = s.timestamp
  let end = s.timestamp + s.duration
  if !words.isEmpty && start - segEnd > 0.8 {
    segments.append(Segment(start: segStart, end: segEnd, text: words.joined(separator: " ")))
    words = []
  }
  if words.isEmpty { segStart = start }
  words.append(s.substring)
  segEnd = end
}
if !words.isEmpty { segments.append(Segment(start: segStart, end: segEnd, text: words.joined(separator: " "))) }

emit(Output(
  text: final.bestTranscription.formattedString,
  segments: segments,
  onDevice: onDevice,
  locale: recognizer.locale.identifier
))
