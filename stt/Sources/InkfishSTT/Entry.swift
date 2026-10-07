// inkfish-stt — Inkfish's bundled transcription helper (spawned by the app).
//
//   inkfish-stt engines                         → [Engine] JSON
//   inkfish-stt transcribe <audio> --engine ID  → {text, segments, engine, ms}
//   inkfish-stt prepare --engine ID             → downloads models, {ok}
//   inkfish-stt remove --engine ID              → deletes downloaded models, {ok}
//   inkfish-stt ai status                       → Apple Intelligence availability JSON
//   inkfish-stt ai run   (JSON request on stdin) → cleanup / organise / summarise JSON
//   options: --locale en-AU, --allow-network (apple-speech only)
//
// Engines: apple-speech (SFSpeechRecognizer), apple-analyzer (SpeechAnalyzer,
// macOS 26), and the FluidAudio CoreML/ANE models in Fluid.swift.
// Errors → stderr + non-zero exit.
import Foundation
import FluidAudio

struct Segment: Encodable { let start: Double; let end: Double; let text: String }

struct Transcript: Encodable {
  var text: String
  var segments: [Segment]
  var engine: String = ""
  var ms: Int = 0
  /// What actually ran (framework, compute units, model) — shown in the app to validate the engine.
  var runtime: String = ""
}

struct Engine: Encodable {
  let id: String
  let name: String
  /// Can run on this Mac at all.
  let available: Bool
  /// Runs now without a download / settings change.
  let ready: Bool
  /// Current status line ("Downloaded", "Needs macOS 26", fix-it hints).
  let detail: String
  var subtitle: String = ""
  /// "apple" | "nvidia" | "cohere" — drives the badge.
  var family: String = "apple"
  var size: String = ""
  var languages: String = ""
  var downloadable: Bool = false
  /// Bytes on disk once downloaded (0 otherwise).
  var bytes: Int64 = 0
}

/// `prepare` progress for the app: one `PROGRESS {json}` line per update on stderr.
///
/// FluidAudio's `fractionCompleted` covers the whole operation: repo loads give
/// the download the first half and Core ML compile the second (weight 0.5),
/// subdirectory loads (Nemotron) are all download (weight 1.0). The app wants
/// each phase on its own 0–100% bar, so rescale here: `fraction` is progress
/// within the current phase.
func progressLine(downloadWeight w: Double) -> ProgressHandler {
  return { p in
    var phase = "downloading"
    var files = 0
    var total = 0
    switch p.phase {
    case .listing: phase = "listing"
    case .downloading(let done, let all): files = done; total = all
    case .compiling: phase = "compiling"
    }
    let raw = max(0, min(1, p.fractionCompleted.isFinite ? p.fractionCompleted : 0))
    let f: Double
    switch phase {
    case "downloading": f = w > 0 ? min(1, raw / w) : raw
    case "compiling": f = w < 1 ? max(0, min(1, (raw - w) / (1 - w))) : 1
    default: f = 0
    }
    let line = "PROGRESS {\"fraction\":\(f),\"overall\":\(raw),\"phase\":\"\(phase)\",\"files\":\(files),\"total\":\(total)}\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
  }
}

struct Options {
  var locale: Locale = .current
  var allowNetwork = ProcessInfo.processInfo.environment["INKFISH_STT_ALLOW_NETWORK"] == "1"
}

struct STTError: Error, CustomStringConvertible {
  let description: String
  let code: Int32
  init(_ d: String, code: Int32 = 4) { description = d; self.code = code }
}

/// Where JSON replies go. `quietStdout()` repoints fd 1 at stderr so library
/// chatter (FluidAudio/Core ML `print`s, os logs) can't land in the reply and
/// break the app's JSON.parse — which used to make it treat the whole raw
/// output as the transcript.
var replyOut = FileHandle.standardOutput

func quietStdout() {
  fflush(stdout)
  let saved = dup(STDOUT_FILENO)
  guard saved >= 0 else { return }
  dup2(STDERR_FILENO, STDOUT_FILENO)
  replyOut = FileHandle(fileDescriptor: saved, closeOnDealloc: false)
}

func emit<T: Encodable>(_ value: T) {
  let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
  fflush(stdout)
  replyOut.write(data)
  replyOut.write(Data("\n".utf8))
}

func fail(_ msg: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data("\(msg)\n".utf8))
  exit(code)
}

func listEngines(_ opts: Options) async -> [Engine] {
  var out = [AppleSpeech.engine(opts)]
  out.append(await AppleAnalyzer.engine(opts))
  out.append(contentsOf: Fluid.engines(opts))
  return out
}

func transcribe(_ url: URL, engine: String, _ opts: Options) async throws -> Transcript {
  let t0 = Date()
  var r: Transcript
  switch engine {
  case "apple-speech": r = try await AppleSpeech.transcribe(url, opts)
  case "apple-analyzer": r = try await AppleAnalyzer.transcribe(url, opts)
  default:
    guard let model = Fluid.Model(rawValue: engine) else { throw STTError("unknown engine \(engine)", code: 64) }
    r = try await Fluid.transcribe(url, model, opts)
  }
  r.engine = engine
  r.ms = Int(Date().timeIntervalSince(t0) * 1000)
  return r
}

@main
struct InkfishSTT {
  static func main() async {
    var args = Array(CommandLine.arguments.dropFirst())
    var opts = Options()
    var engine = "apple-speech"
    var positional: [String] = []
    while !args.isEmpty {
      let a = args.removeFirst()
      switch a {
      case "--engine": engine = args.isEmpty ? engine : args.removeFirst()
      case "--locale": if !args.isEmpty { opts.locale = Locale(identifier: args.removeFirst()) }
      case "--allow-network": opts.allowNetwork = true
      case "--json": break
      default: positional.append(a)
      }
    }
    let cmd = positional.first ?? ""
    // `tap` streams raw PCM on stdout; every other command replies with one JSON line.
    if cmd != "tap" { quietStdout() }
    do {
      switch cmd {
      case "engines":
        emit(await listEngines(opts))
      case "ai":
        // Apple Intelligence (Foundation Models) — see Intelligence.swift.
        switch positional.dropFirst().first ?? "status" {
        case "status":
          emit(Intelligence.status())
        case "run":
          let data = FileHandle.standardInput.readDataToEndOfFile()
          guard let req = try? JSONDecoder().decode(IntelRequest.self, from: data) else {
            throw STTError("ai run: expected a JSON request on stdin", code: 64)
          }
          emit(try await Intelligence.run(req))
        default:
          throw STTError("usage: inkfish-stt ai status | ai run", code: 64)
        }
      case "tap":
        guard #available(macOS 14.2, *) else { throw STTError("system audio capture needs macOS 14.2+", code: 64) }
        try SystemTap.run()
      case "prepare":
        guard let model = Fluid.Model(rawValue: engine) else {
          if engine == "apple-analyzer" { try await AppleAnalyzer.prepare(opts); emit(["ok": true]); return }
          throw STTError("nothing to prepare for \(engine)", code: 64)
        }
        // Nemotron downloads a subdirectory (no compile phase); the rest are repo loads.
        try await Fluid.prepare(model, opts, progress: progressLine(downloadWeight: model == .nemotron ? 1.0 : 0.5))
        emit(["ok": true])
      case "remove":
        guard let model = Fluid.Model(rawValue: engine) else { throw STTError("nothing to remove for \(engine)", code: 64) }
        try Fluid.remove(model, opts)
        emit(["ok": true])
      case "transcribe":
        guard positional.count > 1 else { fail("usage: inkfish-stt transcribe <audio> --engine ID", 64) }
        let url = URL(fileURLWithPath: positional[1])
        guard FileManager.default.fileExists(atPath: url.path) else { fail("no such file: \(url.path)", 64) }
        emit(try await transcribe(url, engine: engine, opts))
      default:
        // Legacy form: inkfish-stt <audio> [--json]
        if !cmd.isEmpty, FileManager.default.fileExists(atPath: cmd) {
          emit(try await transcribe(URL(fileURLWithPath: cmd), engine: engine, opts))
        } else {
          fail("usage: inkfish-stt engines | transcribe <audio> --engine ID | prepare --engine ID | ai status | ai run", 64)
        }
      }
    } catch let e as STTError {
      fail(e.description, e.code)
    } catch {
      fail("\(engine): \(error.localizedDescription)", 4)
    }
  }
}
