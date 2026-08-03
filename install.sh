#!/usr/bin/env bash
# install.sh — install Bottom Panel without requiring Make
set -euo pipefail

UUID="bottom-panel@gnome-extension.local"
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Compiling schemas…"
glib-compile-schemas "${ROOT}/schemas/"

echo "Installing to ${EXT_DIR}…"
mkdir -p "${EXT_DIR}"
rsync -a --delete \
  --exclude '.git/' \
  --exclude '*.zip' \
  --exclude 'Makefile' \
  --exclude 'install.sh' \
  --exclude '.gitignore' \
  "${ROOT}/" "${EXT_DIR}/"

glib-compile-schemas "${EXT_DIR}/schemas/"

echo "Done."
echo
echo "Next steps:"
echo "  1. Restart GNOME Shell so it discovers the extension:"
echo "       X11:     Alt+F2 → r"
echo "       Wayland: log out and back in"
echo "  2. Enable:"
echo "       gnome-extensions enable ${UUID}"
echo "  3. Preferences:"
echo "       gnome-extensions prefs ${UUID}"
