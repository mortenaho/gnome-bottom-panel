# AGENTS.md

This repository is a **monorepo of two standalone GNOME Shell extensions** (GJS / GNOME JavaScript, no server, no Node/Python package manager):

- `bottom-panel/` — hides the top bar and renders a bottom dock/panel (`bottom-panel@mortenaho.github.io`).
- `custom-navbar/` — keeps the top bar but replaces the clock + keyboard indicator with a flag and a seven-segment LED clock (`custom-navbar@mortenaho.github.io`).

The two extensions are **mutually exclusive at runtime** — Bottom Panel hides the top bar that Custom Navbar decorates. Enable only one at a time.

Standard per-extension commands live in each `README.md` and `Makefile` (`make schemas`, `make install`, `make enable`, `make pack`) — refer to those rather than duplicating them.

## Cursor Cloud specific instructions

The cloud VM runs an **XFCE** desktop on `DISPLAY=:1`, not GNOME. The extensions still run/test here via a **nested GNOME Shell** window drawn onto that X display. The dependency-refresh (rsync + the GNOME Shell 46 stack + gjs) is handled by the startup update script, so the notes below are only the non-obvious runtime caveats.

- **Shell version mismatch (important):** Ubuntu 24.04 provides **GNOME Shell 46**, but both `metadata.json` files pin `shell-version: ["50"]`. To load them you MUST disable version validation:
  `gsettings set org.gnome.shell disable-extension-version-validation true`
  Without this the shell refuses to load either extension. (They do run on 46 with validation off.)

- **Install into the user extensions dir** with each extension's `./install.sh` (or `make install`). Caveat: `install.sh` parses `gsettings get org.gnome.shell enabled-extensions` with Python and crashes on a **totally fresh dconf**, where that key returns the typed-empty literal `@as []`. Work around it by seeding the list first, e.g. `gsettings set org.gnome.shell enabled-extensions "['bottom-panel@mortenaho.github.io']"`, then re-run. Once the list is non-empty, `install.sh` succeeds.

- **Run a nested GNOME Shell to test end-to-end** (renders a window on `:1`):
  ```bash
  sudo mkdir -p /run/user/1000 && sudo chown 1000:1000 /run/user/1000 && sudo chmod 700 /run/user/1000
  sudo rmdir /run/systemd/seats 2>/dev/null   # see note below
  export DISPLAY=:1 XDG_RUNTIME_DIR=/run/user/1000 MUTTER_DEBUG_DUMMY_MODE_SPECS=1680x1000
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell disable-extension-version-validation true
  gsettings set org.gnome.shell enabled-extensions "['bottom-panel@mortenaho.github.io']"  # or custom-navbar
  dbus-run-session -- gnome-shell --nested --wayland
  ```
  Run it in a long-lived tmux session; software rendering (llvmpipe) is used, so startup takes ~10s.

- **`XDG_RUNTIME_DIR` is unset by default** and `/run/user/1000` does not exist — the nested shell fails with "Failed to create socket" until you create it (first line above).

- **No systemd-logind:** PID 1 is `tini`, but `/run/systemd/seats/` exists, so GNOME's `haveSystemd()` picks the systemd login path and the shell crashes at startup calling `org.freedesktop.login1`. Removing the empty `/run/systemd/seats` directory makes it fall back to the dummy login manager and boot cleanly. (GDM / screen-lock warnings in the log after that are expected and harmless.)

- **Switching between the two extensions:** change `enabled-extensions` (only one UUID) and restart the nested shell process. Hot-reload (`Alt+F2` → `r`) is X11-only and not available in this nested/Wayland setup.

- **Screenshots of the nested shell** (no scrot/imagemagick installed; ffmpeg is): `ffmpeg -y -f x11grab -video_size 1920x1200 -i :1 -frames:v 1 out.png`.

- **Lint / build checks:** the repo has **no configured linter**. Use `glib-compile-schemas <ext>/schemas/` to validate the GSettings schemas, and `node --check <file>.js` (or `gjs`) for JS syntax validation. `gschemas.compiled` is gitignored.
