// swift-tools-version: 5.10
// Inkfish's bundled transcription helper (Contents/Resources/bin/inkfish-stt).
// Not a user-facing CLI: the app spawns it. Built by scripts/build-stt.ts.
import Foundation
import PackageDescription

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
  name: "InkfishSTT",
  platforms: [.macOS(.v14)],
  dependencies: [
    // Parakeet (v3 / Redux / Ultra / v2) on the Neural Engine via CoreML. Apache-2.0.
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5")
  ],
  targets: [
    .executableTarget(
      name: "inkfish-stt",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources/InkfishSTT",
      linkerSettings: [
        // Embed Info.plist so TCC has usage strings even outside the app bundle.
        .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                      "-Xlinker", "\(here)/Info.plist"])
      ]
    )
  ]
)
