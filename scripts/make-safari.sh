#!/usr/bin/env bash
# Build the Safari extension and wrap it in an Xcode project (macOS + iOS).
# Run this on a Mac with Xcode installed. Re-run after pulling changes:
# the Xcode project references dist/safari, so a rebuild is all it needs.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE_ID="${BUNDLE_ID:-io.github.cmapex.tsuzuki}"

command -v xcrun >/dev/null || { echo "xcrun not found: install Xcode first" >&2; exit 1; }

npm ci
npm run build:safari

if [ -d safari/Tsuzuki ]; then
  echo "Xcode project already exists at safari/Tsuzuki; dist/safari rebuilt. Build & run from Xcode."
  exit 0
fi

xcrun safari-web-extension-converter dist/safari \
  --project-location safari \
  --app-name Tsuzuki \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --no-open

echo
echo "Done. Next:"
echo "  1. open safari/Tsuzuki/Tsuzuki.xcodeproj"
echo "  2. Set your Team under Signing & Capabilities for every target."
echo "  3. Pick the iOS app scheme + your iPhone, then Run."
echo "  4. On the iPhone: Settings → Apps → Safari → Extensions → Tsuzuki → turn on,"
echo "     and allow it on youtube.com (and your search engine)."
