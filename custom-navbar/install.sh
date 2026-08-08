#!/usr/bin/env bash
set -euo pipefail

UUID="custom-navbar@mortenaho.github.io"
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
  --exclude 'pack.sh' \
  --exclude '.gitignore' \
  --exclude 'README.md' \
  "${ROOT}/" "${EXT_DIR}/"

glib-compile-schemas "${EXT_DIR}/schemas/"

if command -v gsettings >/dev/null; then
  gsettings set org.gnome.shell disable-user-extensions false || true

  python3 - <<PY
import ast, subprocess
uuid = "${UUID}"
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
    text=True,
).strip()
lst = list(ast.literal_eval(raw))
if uuid not in lst:
    lst.append(uuid)
fmt = "[" + ", ".join(f"'{x}'" for x in lst) + "]"
subprocess.check_call(
    ["gsettings", "set", "org.gnome.shell", "enabled-extensions", fmt])
print(f"enabled-extensions updated ({len(lst)} entries)")
PY
fi

echo "Done: ${EXT_DIR}"

if command -v gnome-extensions >/dev/null; then
  gnome-extensions enable "${UUID}" 2>/dev/null || \
    echo "Enable later with: gnome-extensions enable ${UUID}"
fi

echo "Reload: gnome-extensions disable ${UUID} && gnome-extensions enable ${UUID}"
echo "Prefs:  gnome-extensions prefs ${UUID}"
