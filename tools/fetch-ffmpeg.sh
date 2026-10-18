#!/bin/sh
# Downloads ffmpeg.wasm into vendor/ffmpeg/ so TdJablet can decode formats the
# browser can't (ALAC on Chrome/Android, WMA, APE, WavPack, ...).
# Needs npm. The files are ~31 MB and are not committed to git; the GitHub
# Pages workflow runs this script when deploying.
set -e
cd "$(dirname "$0")/.."
FFMPEG_VERSION=0.12.15
CORE_VERSION=0.12.10
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack --silent "@ffmpeg/ffmpeg@$FFMPEG_VERSION" "@ffmpeg/core@$CORE_VERSION" >/dev/null)
mkdir -p "$tmp/ffmpeg" "$tmp/core"
tar xzf "$tmp/ffmpeg-ffmpeg-$FFMPEG_VERSION.tgz" -C "$tmp/ffmpeg"
tar xzf "$tmp/ffmpeg-core-$CORE_VERSION.tgz" -C "$tmp/core"
rm -rf vendor/ffmpeg
mkdir -p vendor/ffmpeg/ffmpeg vendor/ffmpeg/core
cp "$tmp"/ffmpeg/package/dist/esm/*.js vendor/ffmpeg/ffmpeg/
cp "$tmp"/core/package/dist/esm/ffmpeg-core.js "$tmp"/core/package/dist/esm/ffmpeg-core.wasm vendor/ffmpeg/core/
cp "$tmp"/ffmpeg/package/LICENSE vendor/ffmpeg/LICENSE-ffmpeg.wasm 2>/dev/null || true
echo "ffmpeg.wasm installed in vendor/ffmpeg ($(du -sh vendor/ffmpeg | cut -f1))"
