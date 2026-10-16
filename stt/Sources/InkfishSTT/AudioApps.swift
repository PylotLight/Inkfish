import CoreAudio
import Darwin
import Foundation

/// One Core Audio client process (an app, or one of its helpers).
/// `appId` is the owning app's bundle id — the grouping key the app and the
/// tap both use, so "Microsoft Teams" covers every Teams helper PID.
struct AudioProc: Encodable {
  let object: UInt32
  let pid: Int32
  /// As Core Audio reports it (a helper's own id, e.g. com.microsoft.teams2.helper).
  let bundleId: String
  /// Owning app's bundle id (outermost .app, else the responsible process's app).
  let appId: String
  let appName: String
  /// Path of the owning .app ('' for daemons) — the app shows its icon.
  let appPath: String
  /// Playing audio right now (kAudioProcessPropertyIsRunningOutput).
  let outputting: Bool
}

/// `inkfish-stt audio-apps`: every process Core Audio knows about, resolved to
/// its owning app. Needs no permission (it's metadata, not audio).
@available(macOS 14.2, *)
enum AudioApps {
  static let system = AudioObjectID(kAudioObjectSystemObject)

  static func address(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  }

  static func processObjects() -> [AudioObjectID] {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    let n = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: n)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
  }

  static func u32(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
    var addr = address(sel)
    var v: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : nil
  }

  static func pid(_ obj: AudioObjectID) -> pid_t? {
    var addr = address(kAudioProcessPropertyPID)
    var v: pid_t = -1
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : nil
  }

  static func string(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var addr = address(sel)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ref) == noErr, let s = ref?.takeRetainedValue() else {
      return nil
    }
    return s as String
  }

  static func execPath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4096) // PROC_PIDPATHINFO_MAXSIZE
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    return n > 0 ? String(cString: buf) : nil
  }

  /// Private libsystem call (used by Activity Monitor & co): the process TCC
  /// and the Dock treat as responsible. Resolves WebKit's shared GPU process
  /// to Safari, XPC helpers to their app. Optional — nil if it's ever removed.
  typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
  static let responsibleFn: ResponsibleFn? = {
    guard let h = dlopen(nil, RTLD_NOW), let s = dlsym(h, "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(s, to: ResponsibleFn.self)
  }()

  /// `/Applications/Microsoft Teams.app/Contents/Helpers/…` → `/Applications/Microsoft Teams.app`.
  static func outermostApp(_ path: String) -> String? {
    var acc: [Substring] = []
    for c in path.split(separator: "/", omittingEmptySubsequences: false) {
      acc.append(c)
      if c.hasSuffix(".app") { return acc.joined(separator: "/") }
    }
    return nil
  }

  static func appInfo(_ appPath: String) -> (id: String, name: String) {
    let b = Bundle(path: appPath)
    let id = b?.bundleIdentifier ?? ""
    let name = (b?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
      ?? (b?.object(forInfoDictionaryKey: "CFBundleName") as? String)
      ?? URL(fileURLWithPath: appPath).deletingPathExtension().lastPathComponent
    return (id, name)
  }

  static func owningApp(_ pid: pid_t) -> String? {
    if let p = execPath(pid), let app = outermostApp(p) { return app }
    if let f = responsibleFn {
      let r = f(pid)
      if r > 0, r != pid, let p = execPath(r), let app = outermostApp(p) { return app }
    }
    return nil
  }

  static func describe(_ obj: AudioObjectID) -> AudioProc? {
    guard let p = pid(obj), p > 0, p != getpid() else { return nil }
    let bundle = string(obj, kAudioProcessPropertyBundleID) ?? ""
    let outputting = (u32(obj, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
    var appId = bundle
    var appName = ""
    var appPath = ""
    if let app = owningApp(p) {
      let info = appInfo(app)
      appPath = app
      appName = info.name
      if !info.id.isEmpty { appId = info.id }
    }
    if appName.isEmpty {
      appName = bundle.isEmpty ? (execPath(p).map { URL(fileURLWithPath: $0).lastPathComponent } ?? "pid \(p)") : bundle
    }
    if appId.isEmpty { appId = "pid:\(p)" }
    return AudioProc(object: obj, pid: p, bundleId: bundle, appId: appId, appName: appName, appPath: appPath,
                     outputting: outputting)
  }

  static func list() -> [AudioProc] { processObjects().compactMap(describe) }
}
