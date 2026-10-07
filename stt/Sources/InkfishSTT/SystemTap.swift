import AudioToolbox
import CoreAudio
import Foundation

/// `inkfish-stt tap`: the Mac's output audio (Teams, Zoom, Meet…) via a Core
/// Audio process tap (macOS 14.2+). Audio only — needs "System Audio Recording
/// Only", never Screen Recording. Streams mono Float32 little-endian PCM on
/// stdout; the first stderr line is `RATE <hz>`. Runs until stdin closes or
/// SIGTERM.
@available(macOS 14.2, *)
enum SystemTap {
  static func osCheck(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw STTError("\(what) failed (OSStatus \(status))", code: 5) }
  }

  static func defaultOutputUID() throws -> String {
    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var dev = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try osCheck(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev),
                "default output device")
    addr.mSelector = kAudioDevicePropertyDeviceUID
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try osCheck(AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &uid), "output device UID")
    guard let s = uid?.takeRetainedValue() else { throw STTError("output device has no UID", code: 5) }
    return s as String
  }

  static func run() throws -> Never {
    let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    desc.uuid = UUID()
    desc.name = "Inkfish meeting capture"
    desc.isPrivate = true
    desc.muteBehavior = .unmuted

    var tap = AudioObjectID(kAudioObjectUnknown)
    let st = AudioHardwareCreateProcessTap(desc, &tap)
    guard st == noErr else {
      throw STTError("system audio tap refused (OSStatus \(st)) — allow Inkfish under System Audio Recording Only", code: 13)
    }

    var addr = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var fmt = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try osCheck(AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &fmt), "tap format")

    let outUID = try defaultOutputUID()
    let agg: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Inkfish Tap",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
      kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]
      ]
    ]
    var aggID = AudioObjectID(kAudioObjectUnknown)
    try osCheck(AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID), "aggregate device")

    let channels = max(1, Int(fmt.mChannelsPerFrame))
    let interleaved = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let out = FileHandle.standardOutput
    let queue = DispatchQueue(label: "inkfish.tap.out")

    var proc: AudioDeviceIOProcID?
    try osCheck(AudioDeviceCreateIOProcIDWithBlock(&proc, aggID, nil) { _, input, _, _, _ in
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
          for f in 0..<frames { mono[f] += src[f] }
        }
        let n = Float(abl.count)
        for f in 0..<frames { mono[f] /= n }
      }
      let data = mono.withUnsafeBufferPointer { Data(buffer: $0) }
      queue.async { try? out.write(contentsOf: data) }
    }, "IO proc")

    let cleanup: () -> Void = {
      if let proc { AudioDeviceStop(aggID, proc); AudioDeviceDestroyIOProcID(aggID, proc) }
      AudioHardwareDestroyAggregateDevice(aggID)
      AudioHardwareDestroyProcessTap(tap)
    }
    try osCheck(AudioDeviceStart(aggID, proc), "start capture")
    FileHandle.standardError.write("RATE \(Int(fmt.mSampleRate))\n".data(using: .utf8)!)

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
    cleanup()
    exit(0)
  }
}
