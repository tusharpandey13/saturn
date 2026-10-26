#!/bin/sh
# Compile once into /tmp, then run. Usage: tools/ocr/ocr.sh <file.pdf|images...> [--out x.md] [--name label]
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
BIN=${TMPDIR:-/tmp}/saturn-ocr
if [ ! -x "$BIN" ] || [ "$DIR/ocr.swift" -nt "$BIN" ]; then
  swiftc -O "$DIR/ocr.swift" -o "$BIN"
fi
exec "$BIN" "$@"
