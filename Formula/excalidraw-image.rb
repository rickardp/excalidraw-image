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
#   0.2.0           the released version (no leading `v`)
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-apple-darwin.tar.gz    full GH Releases URL for aarch64-apple-darwin tarball
#   07083a3da1f4e4bcd8851fedf0a0ba5a53e64974e82a9276ae539b03860428bb    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-apple-darwin.tar.gz    full GH Releases URL for x86_64-apple-darwin tarball
#   e35a5effc8d383697f615eeeb3035a83b60a892158ebd20f19abce193c6243ea    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz     full GH Releases URL for x86_64-unknown-linux-gnu tarball
#   e0a8caa49e3e6897458fb9dd7bda91b8294a7f6b71f19c76eefa097c0946ec9b     sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-unknown-linux-gnu.tar.gz     full GH Releases URL for aarch64-unknown-linux-gnu tarball
#   5409d82f74a80a731efbba334f8219b9bab82585d3a303aab1d9530063a304f2     sha256 of that tarball

class ExcalidrawImage < Formula
  desc "Convert Excalidraw files to SVG/PNG (self-contained native binary)"
  homepage "https://github.com/rickardp/excalidraw-image"
  version "0.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-apple-darwin.tar.gz"
      sha256 "07083a3da1f4e4bcd8851fedf0a0ba5a53e64974e82a9276ae539b03860428bb"
    end
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-apple-darwin.tar.gz"
      sha256 "e35a5effc8d383697f615eeeb3035a83b60a892158ebd20f19abce193c6243ea"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "e0a8caa49e3e6897458fb9dd7bda91b8294a7f6b71f19c76eefa097c0946ec9b"
    end
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "5409d82f74a80a731efbba334f8219b9bab82585d3a303aab1d9530063a304f2"
    end
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
