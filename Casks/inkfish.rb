# Rendered from Casks/inkfish.rb.tmpl — do not edit by hand.
# Updated automatically by .github/workflows/release.yml on every release.
# Edit Casks/inkfish.rb.tmpl instead — this file is rendered from it.
cask "inkfish" do
  version "0.2.4"
  sha256 "8c7e582a90e1857ae5c1b008d1d672bc625706748562aaceabb3bd40a2789bda"

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
