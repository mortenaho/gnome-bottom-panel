#!/usr/bin/env bash
# install.sh — install Custom Navbar without requiring Make
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

echo "Done."
echo

if command -v gnome-extensions >/dev/null; then
  if gnome-extensions enable "${UUID}" 2>/dev/null; then
    echo "Enabled via gnome-extensions."
  else
    echo "Shell does not know this extension yet (normal on Wayland after install)."
  fi
fi

SESSION_TYPE="${XDG_SESSION_TYPE:-unknown}"
echo
echo "Installed files:"
echo "  ${EXT_DIR}"
echo
if [[ "${SESSION_TYPE}" == "wayland" ]]; then
  echo "IMPORTANT (Wayland): log out and log back in so GNOME Shell"
  echo "loads the extension. Hot-reload is not available."
else
  echo "Next: Alt+F2 → r   then:  gnome-extensions enable ${UUID}"
fi
echo
echo "Prefs: gnome-extensions prefs ${UUID}"
