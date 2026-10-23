# Rendered from Casks/inkfish.rb.tmpl — do not edit by hand.
# Updated automatically by .github/workflows/release.yml on every release.
# Edit Casks/inkfish.rb.tmpl instead — this file is rendered from it.
cask "inkfish" do
  version "0.2.20"
  sha256 "9f67191cd787b8200e4b87649f9106503ad44a8a0eee798fc3b78715eb00ab0b"

  url "https://github.com/PylotLight/Inkfish/releases/download/v#{version}/Inkfish-#{version}-mac-arm64.zip"
  name "Inkfish"
  desc "Menu-bar quick capture with AI inbox-to-project note flow"
  homepage "https://github.com/PylotLight/Inkfish"

  depends_on arch: :arm64
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
