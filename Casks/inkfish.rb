# Rendered from Casks/inkfish.rb.tmpl — do not edit by hand.
# Updated automatically by .github/workflows/release.yml on every release.
# Edit Casks/inkfish.rb.tmpl instead — this file is rendered from it.
cask "inkfish" do
  version "0.2.17"
  sha256 "a034394095211131396118b008f3fa6cd4c6e76130c215e14779241b907c3d9f"

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
