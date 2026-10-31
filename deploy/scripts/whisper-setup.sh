#!/usr/bin/env bash
# Local speech-to-text for the batch (adapters/stt/whisper-cpp.ts): build whisper.cpp at a pinned tag (commit checked)
# and fetch the pinned model (sha256 checked) into DIR; install ffmpeg if the runner lacks it.
#   deploy/scripts/whisper-setup.sh DIR      -> DIR/bin/whisper-cli, DIR/models/ggml-large-v3-turbo-q5_0.bin
# Idempotent: a cached DIR (actions/cache keyed on this file's hash) skips the build and the download. Portable CPU
# build (AVX2/FMA, no -march=native), so a cache restored on another runner CPU still runs. Prints paths, not content.
set -euo pipefail
dir="${1:?usage: whisper-setup.sh DIR}"
WHISPER_TAG=v1.9.5
WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037   # keep equal to adapters/stt/whisper-cpp.ts
MODEL=ggml-large-v3-turbo-q5_0.bin
MODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1         # huggingface.co/ggerganov/whisper.cpp revision
MODEL_SHA256=394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
mkdir -p "$dir/bin" "$dir/models"

if [ ! -x "$dir/bin/whisper-cli" ]; then
  src="$(mktemp -d)"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$src"
  got="$(git -C "$src" rev-parse HEAD)"
  [ "$got" = "$WHISPER_COMMIT" ] || { echo "whisper-setup: tag $WHISPER_TAG is $got, pinned $WHISPER_COMMIT" >&2; exit 1; }
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
    -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF >/dev/null
  cmake --build "$src/build" --config Release -j "$(nproc 2>/dev/null || echo 2)" --target whisper-cli >/dev/null
  install -m 755 "$src/build/bin/whisper-cli" "$dir/bin/whisper-cli"
  rm -rf "$src"
  echo "whisper-setup: built whisper-cli $WHISPER_TAG (${WHISPER_COMMIT:0:12})"
fi

m="$dir/models/$MODEL"
if ! echo "$MODEL_SHA256  $m" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL --retry 3 -o "$m.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/$MODEL_REV/$MODEL"
  echo "$MODEL_SHA256  $m.part" | sha256sum -c --quiet - || { rm -f "$m.part"; echo "whisper-setup: model checksum mismatch" >&2; exit 1; }
  mv "$m.part" "$m"
  echo "whisper-setup: model $MODEL (sha256 ${MODEL_SHA256:0:12}) downloaded"
fi

if ! command -v ffmpeg >/dev/null; then
  sudo apt-get update -qq >/dev/null && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
  echo "whisper-setup: ffmpeg installed"
fi
"$dir/bin/whisper-cli" --help >/dev/null 2>&1 || { echo "whisper-setup: whisper-cli does not run" >&2; exit 1; }
echo "whisper-setup: ready ($dir)"
