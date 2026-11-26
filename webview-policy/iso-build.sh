#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf src-tauri-iso/src src-tauri-iso/capabilities src-tauri-iso/icons
mkdir -p src-tauri-iso
for f in Cargo.toml Cargo.lock build.rs tauri.conf.json src capabilities icons; do cp -R "src-tauri/$f" src-tauri-iso/; done
sed -i.bak -e 's|^tauri = { version = "=2.12.7", features = \["tracing"\] }|tauri = { version = "=2.12.7", features = ["tracing", "isolation"] }|' \
  -e 's|^tauri-build = { version = "=2.7.6", features = \[\] }|tauri-build = { version = "=2.7.6", features = ["isolation"] }|' src-tauri-iso/Cargo.toml
rm src-tauri-iso/Cargo.toml.bak
grep -q '"tracing", "isolation"' src-tauri-iso/Cargo.toml
grep -q 'features = \["isolation"\]' src-tauri-iso/Cargo.toml
cd src-tauri-iso
[ $# -gt 0 ] || set -- build
TAURI_CONFIG='{"app":{"security":{"pattern":{"use":"isolation","options":{"dir":"../isolation"}}}}}' cargo "$@" --locked --features custom-protocol,v4,iso
