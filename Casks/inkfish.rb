# Updated automatically by .github/workflows/release.yml on every release.
# Edit Casks/inkfish.rb.tmpl instead — this file is rendered from it.
cask "inkfish" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "0000000000000000000000000000000000000000000000000000000000000000",
         intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/PylotLight/Inkfish/releases/download/v#{version}/Inkfish-#{version}-mac-#{arch}.zip"
  name "Inkfish"
  desc "Menu-bar quick capture with AI inbox-to-project note flow"
  homepage "https://github.com/PylotLight/Inkfish"

  depends_on macos: :monterey

  app "Inkfish.app"

  caveats <<~EOS
    Inkfish is unsigned. If macOS reports it is "damaged", run:
      xattr -cr /Applications/Inkfish.app
    (Homebrew removed the --no-quarantine flag in v6, so clearing the
    quarantine flag manually is now required.)
  EOS

  zap trash: [
    "~/Library/Application Support/Inkfish",
    "~/Library/Caches/com.pylotlight.inkfish",
    "~/Library/HTTPStorages/com.pylotlight.inkfish",
    "~/Library/Preferences/com.pylotlight.inkfish.plist",
    "~/Library/Saved Application State/com.pylotlight.inkfish.savedState",
  ]
end
