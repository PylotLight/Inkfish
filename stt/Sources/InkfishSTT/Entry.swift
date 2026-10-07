// inkfish-stt — Inkfish's bundled transcription helper (spawned by the app).
//
//   inkfish-stt engines                         → [Engine] JSON
//   inkfish-stt transcribe <audio> --engine ID  → {text, segments, engine, ms}
//   inkfish-stt prepare --engine ID             → downloads models, {ok}
//   inkfish-stt remove --engine ID              → deletes downloaded models, {ok}
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
let progressLine: ProgressHandler = { p in
  var phase = "downloading"
  var files = 0
  var total = 0
  switch p.phase {
  case .listing: phase = "listing"
  case .downloading(let done, let all): files = done; total = all
  case .compiling: phase = "compiling"
  }
  let f = max(0, min(1, p.fractionCompleted.isFinite ? p.fractionCompleted : 0))
  let line = "PROGRESS {\"fraction\":\(f),\"phase\":\"\(phase)\",\"files\":\(files),\"total\":\(total)}\n"
  FileHandle.standardError.write(line.data(using: .utf8)!)
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

func emit<T: Encodable>(_ value: T) {
  let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
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
    do {
      switch cmd {
      case "engines":
        emit(await listEngines(opts))
      case "tap":
        guard #available(macOS 14.2, *) else { throw STTError("system audio capture needs macOS 14.2+", code: 64) }
        try SystemTap.run()
      case "prepare":
        guard let model = Fluid.Model(rawValue: engine) else {
          if engine == "apple-analyzer" { try await AppleAnalyzer.prepare(opts); emit(["ok": true]); return }
          throw STTError("nothing to prepare for \(engine)", code: 64)
        }
        try await Fluid.prepare(model, opts, progress: progressLine)
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
          fail("usage: inkfish-stt engines | transcribe <audio> --engine ID | prepare --engine ID", 64)
        }
      }
    } catch let e as STTError {
      fail(e.description, e.code)
    } catch {
      fail("\(engine): \(error.localizedDescription)", 4)
    }
  }
}
