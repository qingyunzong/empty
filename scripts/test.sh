#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "${TMPDIR:-}" ]]; then
  temp_root="$TMPDIR"
else
  temp_root="$root/.tmp"
  mkdir -p "$temp_root"
fi
build_dir="$(mktemp -d "$temp_root/edf-ts-test.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

tsc -p "$root/tsconfig.test.json" --outDir "$build_dir"
node "$build_dir/test/decoder.test.js"
