# Homebrew formula stub for `excalidraw-image`.
#
# This file is a TEMPLATE. The release workflow (`.github/workflows/release.yml`,
# `homebrew-bump` job) renders it with concrete values via `sed` and commits
# the result to `Formula/excalidraw-image.rb` in this repo. Users tap with:
#
#   brew tap rickardp/excalidraw-image https://github.com/rickardp/excalidraw-image.git
#   brew install excalidraw-image
#
# Placeholders rendered by the workflow:
#   0.1.2           the released version (no leading `v`)
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-aarch64-apple-darwin.tar.gz    full GH Releases URL for aarch64-apple-darwin tarball
#   246805fab9cb189f4b0b2b40bd321a81bd3f8a3d51fe26f63bf93b7c94dba75c    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-x86_64-apple-darwin.tar.gz    full GH Releases URL for x86_64-apple-darwin tarball
#   bcb753bd7f2e7946d0cf64f0add02e28ab1cec579e44e62a16cbe52e8f62998a    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz     full GH Releases URL for x86_64-unknown-linux-gnu tarball
#   5681e7108d6245ec3a1eac28d37b51add9bb6fb55f415e5ac7c5bc1755956fd7     sha256 of that tarball
#
# Linux ARM64 is not yet shipped; see the release workflow header.
# Add an `on_arm` block here and a matching matrix entry in release.yml when
# that lands.

class ExcalidrawImage < Formula
  desc "Convert Excalidraw files to SVG/PNG (self-contained native binary)"
  homepage "https://github.com/rickardp/excalidraw-image"
  version "0.1.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-aarch64-apple-darwin.tar.gz"
      sha256 "246805fab9cb189f4b0b2b40bd321a81bd3f8a3d51fe26f63bf93b7c94dba75c"
    end
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-x86_64-apple-darwin.tar.gz"
      sha256 "bcb753bd7f2e7946d0cf64f0add02e28ab1cec579e44e62a16cbe52e8f62998a"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.1.2/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "5681e7108d6245ec3a1eac28d37b51add9bb6fb55f415e5ac7c5bc1755956fd7"
    end
    # on_arm: deferred — see release.yml notes on Linux ARM64.
  end

  def install
    bin.install "excalidraw-image"
  end

  test do
    fixture = (testpath/"basic.excalidraw")
    fixture.write <<~JSON
      {"type":"excalidraw","version":2,"source":"https://excalidraw.com",
       "elements":[{"type":"rectangle","id":"a","x":0,"y":0,
       "width":100,"height":50,"strokeColor":"#000","backgroundColor":"transparent",
       "fillStyle":"solid","strokeWidth":1,"strokeStyle":"solid","roughness":1,
       "opacity":100,"angle":0,"seed":1,"version":1,"versionNonce":1,
       "isDeleted":false,"groupIds":[],"frameId":null,"roundness":null,
       "boundElements":null,"updated":0,"link":null,"locked":false}],
       "appState":{"viewBackgroundColor":"#ffffff"},"files":{}}
    JSON
    assert_match "<svg", shell_output("#{bin}/excalidraw-image #{fixture}")
  end
end
