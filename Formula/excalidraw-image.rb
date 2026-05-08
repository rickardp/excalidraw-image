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
#   387f7ef44a75528e4c6cca9f0af4bba34e017986f34581d983bb2a96afb5d9ba    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-apple-darwin.tar.gz    full GH Releases URL for x86_64-apple-darwin tarball
#   bef1198f6237123ecc7f63c1fc6a456413e5f6cc91ae4c548dc26d661066fc21    sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz     full GH Releases URL for x86_64-unknown-linux-gnu tarball
#   6a86f5188b55aef092d9cedda786565bfdb399bb58e57a1bea26335ed8f19ac6     sha256 of that tarball
#   https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-unknown-linux-gnu.tar.gz     full GH Releases URL for aarch64-unknown-linux-gnu tarball
#   c6b222e128965568e281af96edfa437393b2ddb4e3ba360ec2b9b583f273143e     sha256 of that tarball

class ExcalidrawImage < Formula
  desc "Convert Excalidraw files to SVG/PNG (self-contained native binary)"
  homepage "https://github.com/rickardp/excalidraw-image"
  version "0.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-apple-darwin.tar.gz"
      sha256 "387f7ef44a75528e4c6cca9f0af4bba34e017986f34581d983bb2a96afb5d9ba"
    end
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-apple-darwin.tar.gz"
      sha256 "bef1198f6237123ecc7f63c1fc6a456413e5f6cc91ae4c548dc26d661066fc21"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-x86_64-unknown-linux-gnu.tar.gz"
      sha256 "6a86f5188b55aef092d9cedda786565bfdb399bb58e57a1bea26335ed8f19ac6"
    end
    on_arm do
      url "https://github.com/rickardp/excalidraw-image/releases/download/v0.2.0/excalidraw-image-aarch64-unknown-linux-gnu.tar.gz"
      sha256 "c6b222e128965568e281af96edfa437393b2ddb4e3ba360ec2b9b583f273143e"
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
