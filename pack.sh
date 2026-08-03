#!/usr/bin/env bash
# pack.sh — create extensions.gnome.org zip (no Make required)
set -euo pipefail

UUID="bottom-panel@mortenaho.github.io"
ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP="${ROOT}/${UUID}.zip"

echo "Compiling schemas…"
glib-compile-schemas "${ROOT}/schemas/"

echo "Creating ${ZIP}…"
rm -f "${ZIP}"
(
  cd "${ROOT}"
  zip -r "${ZIP}" \
    metadata.json \
    extension.js \
    panel.js \
    panelManager.js \
    prefs.js \
    stylesheet.css \
    LICENSE \
    screenshot.png \
    indicators \
    widgets \
    utils \
    flags \
    fonts \
    schemas/*.gschema.xml \
    -x "*~" -x "*.gschema.xml~" -x "schemas/gschemas.compiled"
)

echo "Done: ${ZIP}"
unzip -l "${ZIP}"
