#!/usr/bin/env bash
# Mac STT engines for tools/stt (Apple silicon; Metal). Idempotent; every artefact is pinned and checked.
#   tools/stt/setup-mac.sh [CACHE]      default CACHE: $SATURN_STT_CACHE, else ~/Library/Caches/saturn-stt
# Installs into CACHE:
#   bin/whisper-cli          whisper.cpp v1.9.5 (commit checked), Metal build (same tag as adapters/stt/whisper-cpp.ts)
#   models/ggml-large-v3-turbo-q5_0.bin                       sha256 checked (same model as the batch)
#   models/mms-1b-all/       facebook/mms-1b-all at a pinned revision, base model + Hindi adapter, sha256 checked
#   venv/                    Python 3.12 (uv) with requirements-mac.txt (hash-pinned: torch, transformers, pyannote.audio)
#   models/speaker-diarization-community-1/   pyannote weights at a pinned revision, sha256 checked. Gated: fetched only
#                            when the owner's Hugging Face token file exists (~/.config/saturn/hf.token, 0600), read from
#                            that file into a curl header (never on a command line, never printed); runs need no network.
# Prints paths and versions, no content.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cache="${1:-${SATURN_STT_CACHE:-$HOME/Library/Caches/saturn-stt}}"
WHISPER_TAG=v1.9.5
WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
WMODEL=ggml-large-v3-turbo-q5_0.bin
WMODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1
WMODEL_SHA256=394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
MMS_REV=3d33597edbdaaba14a8e858e2c8caa76e3cec0cd
MMS_FILES=(   # file sha256 (public model files; the hashes are not secrets)
  "model.safetensors 0f1d95ce43d27e03d5d8dd56c697c805460f967c793dd2cbec2e8e8012deda98"
  "adapter.hin.safetensors 12ed5b9c307c1da5ca6e188daf9a0e6b91e1b2da0ae8f8ec4b300287d207f73b"
  "config.json ee172ef39a0e40c55403fb811fa0f56c6198c7ed21a2bdf5bd0e72e52c07a41c"
  "preprocessor_config.json f724fdad65341e79bd9741888fe4e8ce1bb2e7b44fc8216c28c591afb1e202f4"
  "special_tokens_map.json 9046da57c270c8e74d0f38832b4adce269c9d914ef21d2a0925e7772152dd793"  # gitleaks:allow
  "tokenizer_config.json 42a65547cf0654d12263ece7c909c4b0c574b660c78658f806c772cc223bc01b"  # gitleaks:allow
  "vocab.json 0375a07a977a599040a7ff333b6974996965cd93754020619518c15db7691f01"
)
DIAR_REV=3533c8cf8e369892e6b79ff1bf80f7b0286a54ee
DIAR_FILES=(   # file sha256 (public model files; the hashes are not secrets)
  "config.yaml 5ce2bfa9a938dc132cec1172592d65173cbb8f444ea1e4133f10f9391de155be"
  "embedding/pytorch_model.bin 6f10ff60898a1d185fa22e1d11e0bfa8a92efec811f11bca48cb8cafebefd929"
  "segmentation/pytorch_model.bin 7ad24338d844fb95985486eb1a464e32d229f6d7a03c9abe60f978bacf3f816e"
  "plda/plda.npz 9b77bcd840692710dd3496f62ecfeed8d8e5f002fd991b785079b244eab7d255"
  "plda/xvec_transform.npz 325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f"
)
token_file="${SATURN_HF_TOKEN_FILE:-$HOME/.config/saturn/hf.token}"
mkdir -p "$cache/bin" "$cache/models/mms-1b-all" "$cache/hf"
ok() { [ -f "$2" ] && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$1" ]; }
fetch() { # fetch URL DEST SHA256
  ok "$3" "$2" && return 0
  curl -fsSL --retry 3 -o "$2.part" "$1"
  ok "$3" "$2.part" || { rm -f "$2.part"; echo "setup-mac: checksum mismatch for $(basename "$2")" >&2; exit 1; }
  mv "$2.part" "$2"; echo "setup-mac: fetched $(basename "$2") (sha256 ${3:0:12})"
}
for t in git curl ffmpeg uv cmake; do command -v "$t" >/dev/null || { echo "setup-mac: needs $t (brew install $t)" >&2; exit 1; }; done

if [ ! -x "$cache/bin/whisper-cli" ] || ! "$cache/bin/whisper-cli" --version 2>&1 | grep -q "${WHISPER_TAG#v}"; then
  src="$(mktemp -d)"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$src"
  [ "$(git -C "$src" rev-parse HEAD)" = "$WHISPER_COMMIT" ] || { echo "setup-mac: $WHISPER_TAG is not the pinned commit" >&2; exit 1; }
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF >/dev/null
  cmake --build "$src/build" --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-cli >/dev/null
  install -m 755 "$src/build/bin/whisper-cli" "$cache/bin/whisper-cli"
  rm -rf "$src"
  echo "setup-mac: built whisper-cli $WHISPER_TAG (${WHISPER_COMMIT:0:12}, Metal)"
fi
fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/$WMODEL_REV/$WMODEL" "$cache/models/$WMODEL" "$WMODEL_SHA256"
for entry in "${MMS_FILES[@]}"; do
  f="${entry%% *}"; sha="${entry##* }"
  fetch "https://huggingface.co/facebook/mms-1b-all/resolve/$MMS_REV/$f" "$cache/models/mms-1b-all/$f" "$sha"
done

fetch_diar() {
  local f="$1" sha="$2" dest="$cache/models/speaker-diarization-community-1/$1"
  ok "$sha" "$dest" && return 0
  mkdir -p "$(dirname "$dest")"
  curl -fsSL --retry 3 -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$token_file")") -o "$dest.part" \
    "https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/$DIAR_REV/$f" || { rm -f "$dest.part"; return 1; }
  ok "$sha" "$dest.part" || { rm -f "$dest.part"; echo "setup-mac: checksum mismatch for $f" >&2; exit 1; }
  mv "$dest.part" "$dest"; echo "setup-mac: fetched $f (sha256 ${sha:0:12})"
}
if [ -f "$token_file" ]; then
  for entry in "${DIAR_FILES[@]}"; do
    fetch_diar "${entry%% *}" "${entry##* }" || { echo "setup-mac: diarization model not fetched (token valid? terms of pyannote/speaker-diarization-community-1 accepted?): diarization off" >&2; break; }
  done
fi

req="$here/requirements-mac.txt"
stamp="$cache/venv/.req-sha256"
want="$(shasum -a 256 "$req" | cut -d' ' -f1)"
if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  uv venv -q --python 3.12 --clear "$cache/venv"
  VIRTUAL_ENV="$cache/venv" uv pip install -q --require-hashes -r "$req"
  echo "$want" > "$stamp"
  echo "setup-mac: venv ready (requirements sha256 ${want:0:12})"
fi
if [ -f "$token_file" ]; then echo "setup-mac: HF token present: diarization enabled"; else echo "setup-mac: no HF token: diarization off"; fi
echo "setup-mac: ready ($cache)"
