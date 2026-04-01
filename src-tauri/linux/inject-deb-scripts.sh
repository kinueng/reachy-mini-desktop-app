#!/bin/bash
# Inject postinst/postrm scripts into the .deb package built by Tauri.
# Run this from the repo root after `yarn tauri build`.
#
# Usage: ./src-tauri/linux/inject-deb-scripts.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEB_DIR="$SCRIPT_DIR/../target/release/bundle/deb"

DEB_FILE=$(find "$DEB_DIR" -name "*.deb" 2>/dev/null | head -1)
if [ -z "$DEB_FILE" ]; then
    echo "❌ No .deb file found in $DEB_DIR"
    echo "   Run 'yarn tauri build' first."
    exit 1
fi

echo "📦 Injecting post-install scripts into $(basename "$DEB_FILE")..."

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

dpkg-deb -x "$DEB_FILE" "$TEMP_DIR/extract"
dpkg-deb -e "$DEB_FILE" "$TEMP_DIR/extract/DEBIAN"

cp "$SCRIPT_DIR/deb-postinst.sh" "$TEMP_DIR/extract/DEBIAN/postinst"
cp "$SCRIPT_DIR/deb-postrm.sh"   "$TEMP_DIR/extract/DEBIAN/postrm"
chmod +x "$TEMP_DIR/extract/DEBIAN/postinst" "$TEMP_DIR/extract/DEBIAN/postrm"

dpkg-deb -b "$TEMP_DIR/extract" "$DEB_FILE"

echo "✅ Done: $DEB_FILE"
