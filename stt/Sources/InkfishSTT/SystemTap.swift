import AudioToolbox
import CoreAudio
import Foundation

/// `inkfish-stt tap [--apps id1,id2]`: the Mac's output audio via a Core Audio
/// process tap (macOS 14.2+). Audio only — needs "System Audio Recording
/// Only", never Screen Recording.
///
/// Without `--apps` it taps everything the Mac plays (minus nothing). With
/// `--apps` it taps only the processes whose owning app's bundle id is listed
/// (every helper PID of Microsoft Teams, Chrome…), so music in another app
/// stays out of the meeting. The process set is re-resolved whenever Core
/// Audio's process list changes (app restarted, a new helper started its
/// audio), and while none of the apps is around the stream simply goes quiet
/// (the app pads silence) instead of failing.
///
/// stdout: mono Float32 little-endian PCM. stderr: first `RATE <hz>`, then a
/// `SOURCES {json}` line whenever what's being tapped changes.
/// Runs until stdin closes or SIGTERM.
@available(macOS 14.2, *)
final class SystemTap {
  static func osCheck(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw STTError("\(what) failed (OSStatus \(status))", code: 5) }
  }

  static let permissionHint = "allow Inkfish under Privacy & Security › Screen & System Audio Recording › System Audio Recording Only"

  static func defaultOutput() throws -> AudioObjectID {
    var addr = AudioApps.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
    var dev = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try osCheck(AudioObjectGetPropertyData(AudioApps.system, &addr, 0, nil, &size, &dev), "default output device")
    return dev
  }

  static func deviceUID(_ dev: AudioObjectID) throws -> String {
    guard let s = AudioApps.string(dev, kAudioDevicePropertyDeviceUID) else { throw STTError("output device has no UID", code: 5) }
    return s
  }

  static func nominalRate(_ dev: AudioObjectID) -> Double {
    var addr = AudioApps.address(kAudioDevicePropertyNominalSampleRate)
    var r: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    return AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &r) == noErr && r > 0 ? r : 48_000
  }

  /// nil = all system audio.
  let targets: Set<String>?
  let out = FileHandle.standardOutput
  /// Serial: every state change and every stdout write happens here.
  let queue = DispatchQueue(label: "inkfish.tap")

  /// The rate announced on `RATE` — fixed for the session; taps built later at
  /// another rate (output device switched) are resampled to it.
  var rate: Double = 0
  var tap = AudioObjectID(kAudioObjectUnknown)
  var tapUUID = UUID()
  var agg = AudioObjectID(kAudioObjectUnknown)
  var proc: AudioDeviceIOProcID?
  var tapped: [AudioObjectID] = []
  var lastSources = ""
  var lastError = ""
  // Linear resampler state (only used when the tap's rate ≠ `rate`).
  var rsPos: Double = 0
  var rsLast: Float = 0

  init(targets: Set<String>?) { self.targets = targets }

  // MARK: tap lifecycle (on `queue`, except the initial build)

  func makeDescription(_ objects: [AudioObjectID]?) -> CATapDescription {
    let desc = objects.map { CATapDescription(stereoMixdownOfProcesses: $0) }
      ?? CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    desc.uuid = tapUUID
    desc.name = "Inkfish meeting capture"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted
    return desc
  }

  /// Build tap + private aggregate device + IO proc. `deliver: false` is the
  /// permission probe: it starts (so macOS asks now, not mid-meeting) and
  /// throws the samples away.
  @discardableResult
  func build(_ objects: [AudioObjectID]?, deliver: Bool = true) throws -> Double {
    tapUUID = UUID()
    let desc = makeDescription(objects)
    var newTap = AudioObjectID(kAudioObjectUnknown)
    let st = AudioHardwareCreateProcessTap(desc, &newTap)
    guard st == noErr else {
      throw STTError("system audio tap refused (OSStatus \(st)) — \(Self.permissionHint)", code: 13)
    }
    tap = newTap

    var addr = AudioApps.address(kAudioTapPropertyFormat)
    var fmt = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    do {
      try Self.osCheck(AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &fmt), "tap format")
      let outUID = try Self.deviceUID(try Self.defaultOutput())
      let dict: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Inkfish Tap",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceMainSubDeviceKey: outUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
        kAudioAggregateDeviceTapListKey: [
          [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapUUID.uuidString]
        ]
      ]
      var newAgg = AudioObjectID(kAudioObjectUnknown)
      try Self.osCheck(AudioHardwareCreateAggregateDevice(dict as CFDictionary, &newAgg), "aggregate device")
      agg = newAgg
    } catch {
      teardown()
      throw error
    }

    let channels = max(1, Int(fmt.mChannelsPerFrame))
    let interleaved = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let tapRate = fmt.mSampleRate > 0 ? fmt.mSampleRate : 48_000
    let q = queue
    var newProc: AudioDeviceIOProcID?
    let st2 = AudioDeviceCreateIOProcIDWithBlock(&newProc, agg, nil) { [weak self] _, input, _, _, _ in
      guard deliver else { return }
      let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
      guard let first = abl.first, let p0 = first.mData else { return }
      var mono: [Float]
      if interleaved {
        let frames = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * channels)
        let src = p0.assumingMemoryBound(to: Float.self)
        mono = [Float](repeating: 0, count: frames)
        for f in 0..<frames {
          var s: Float = 0
          for c in 0..<channels { s += src[f * channels + c] }
          mono[f] = s / Float(channels)
        }
      } else {
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        mono = [Float](repeating: 0, count: frames)
        for buf in abl {
          guard let d = buf.mData else { continue }
          let src = d.assumingMemoryBound(to: Float.self)
          for f in 0..<min(frames, Int(buf.mDataByteSize) / MemoryLayout<Float>.size) { mono[f] += src[f] }
        }
        let n = Float(max(1, abl.count))
        for f in 0..<frames { mono[f] /= n }
      }
      q.async { self?.write(mono, from: tapRate) }
    }
    do {
      try Self.osCheck(st2, "IO proc")
      proc = newProc
      try Self.osCheck(AudioDeviceStart(agg, proc), "start capture")
    } catch {
      teardown()
      throw error
    }
    tapped = objects ?? []
    rsPos = 0
    rsLast = 0
    return tapRate
  }

  func teardown() {
    if let p = proc, agg != kAudioObjectUnknown {
      AudioDeviceStop(agg, p)
      AudioDeviceDestroyIOProcID(agg, p)
    }
    proc = nil
    if agg != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(agg) }
    agg = AudioObjectID(kAudioObjectUnknown)
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    tap = AudioObjectID(kAudioObjectUnknown)
    tapped = []
  }

  /// Swap the tapped process set in place (keeps the aggregate device and the
  /// stream running). False when Core Audio won't — caller rebuilds.
  func retarget(_ objects: [AudioObjectID]) -> Bool {
    guard tap != kAudioObjectUnknown else { return false }
    let desc = makeDescription(objects)
    var addr = AudioApps.address(kAudioTapPropertyDescription)
    var ref: CATapDescription = desc
    let st = withUnsafeMutablePointer(to: &ref) { ptr in
      AudioObjectSetPropertyData(tap, &addr, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), ptr)
    }
    if st == noErr { tapped = objects }
    return st == noErr
  }

  // MARK: output

  func write(_ mono: [Float], from tapRate: Double) {
    guard rate > 0 else { return }
    let samples = abs(tapRate - rate) < 0.5 ? mono : resample(mono, ratio: tapRate / rate)
    guard !samples.isEmpty else { return }
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    try? out.write(contentsOf: data)
  }

  /// Linear interpolation across buffer boundaries (`rsLast` = previous
  /// buffer's final sample, `rsPos` = next read position relative to it).
  func resample(_ x: [Float], ratio: Double) -> [Float] {
    guard !x.isEmpty, ratio > 0 else { return [] }
    var y: [Float] = []
    y.reserveCapacity(Int(Double(x.count) / ratio) + 2)
    var pos = rsPos
    while true {
      let i = Int(pos)
      if i + 1 > x.count { break }
      let a: Float = i == 0 ? rsLast : x[i - 1]
      let b = x[i]
      let frac = Float(pos - Double(i))
      y.append(a + (b - a) * frac)
      pos += ratio
    }
    rsPos = pos - Double(x.count)
    rsLast = x[x.count - 1]
    return y
  }

  func status(_ line: String) {
    FileHandle.standardError.write("\(line)\n".data(using: .utf8)!)
  }

  struct SourceApp: Encodable { let id: String; let name: String; let pids: [Int32] }
  struct Sources: Encodable {
    let mode: String
    let apps: [SourceApp]
    /// Targeted, but none of the apps has audio processes yet.
    let waiting: Bool
    let error: String
  }

  func reportSources(_ procs: [AudioProc]) {
    var byApp: [String: (String, [Int32])] = [:]
    var order: [String] = []
    for p in procs {
      if byApp[p.appId] == nil { order.append(p.appId); byApp[p.appId] = (p.appName, []) }
      byApp[p.appId]?.1.append(p.pid)
    }
    let apps = order.map { SourceApp(id: $0, name: byApp[$0]?.0 ?? $0, pids: (byApp[$0]?.1 ?? []).sorted()) }
    let s = Sources(mode: targets == nil ? "all" : "apps", apps: apps, waiting: targets != nil && procs.isEmpty,
                    error: lastError)
    guard let data = try? JSONEncoder().encode(s), let json = String(data: data, encoding: .utf8) else { return }
    if json == lastSources { return }
    lastSources = json
    status("SOURCES \(json)")
  }

  // MARK: targeting

  func matches() -> [AudioProc] {
    guard let targets else { return [] }
    return AudioApps.list().filter { targets.contains($0.appId) || targets.contains($0.bundleId) }
  }

  /// Process list changed (or output device switched): follow the apps.
  func reresolve(forceRebuild: Bool = false) {
    guard targets != nil else {
      if forceRebuild {
        teardown()
        do { try build(nil); lastError = "" } catch { lastError = "\(error)" }
      }
      return
    }
    let procs = matches()
    let objs = procs.map { $0.object }.sorted()
    defer { reportSources(procs) }
    if objs == tapped.sorted() && tap != kAudioObjectUnknown && !forceRebuild { return }
    if objs.isEmpty {
      teardown()
      return
    }
    if !forceRebuild && retarget(objs) { return }
    teardown()
    do {
      try build(objs)
      lastError = ""
    } catch {
      lastError = "\(error)"
    }
  }

  func run() throws -> Never {
    // Initial build on `queue` so no samples are written before `rate` is set.
    try queue.sync {
      let outDev = try Self.defaultOutput()
      if targets == nil {
        rate = try build(nil)
        status("RATE \(Int(rate))")
        reportSources([])
      } else {
        let procs = matches()
        if procs.isEmpty {
          // Nothing to tap yet: probe once so the permission prompt (or a
          // refusal) happens now, then wait quietly for the app's audio.
          try build(nil, deliver: false)
          teardown()
          rate = Self.nominalRate(outDev)
        } else {
          rate = try build(procs.map { $0.object })
        }
        status("RATE \(Int(rate))")
        reportSources(procs)
      }
    }

    // Follow the apps: processes come and go (Teams restarts, a browser tab's
    // audio helper spins up), and the output device can change (AirPods).
    var listAddr = AudioApps.address(kAudioHardwarePropertyProcessObjectList)
    let onList: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.reresolve() }
    AudioObjectAddPropertyListenerBlock(AudioApps.system, &listAddr, queue, onList)
    var devAddr = AudioApps.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
    let onDev: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.reresolve(forceRebuild: true) }
    AudioObjectAddPropertyListenerBlock(AudioApps.system, &devAddr, queue, onDev)

    signal(SIGTERM, SIG_IGN)
    signal(SIGPIPE, SIG_IGN)
    let done = DispatchSemaphore(value: 0)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    term.setEventHandler { done.signal() }
    term.resume()
    // Parent gone → stdin closes → stop.
    DispatchQueue.global().async {
      while !FileHandle.standardInput.availableData.isEmpty {}
      done.signal()
    }
    done.wait()
    queue.sync {
      AudioObjectRemovePropertyListenerBlock(AudioApps.system, &listAddr, queue, onList)
      AudioObjectRemovePropertyListenerBlock(AudioApps.system, &devAddr, queue, onDev)
      teardown()
    }
    exit(0)
  }
}
