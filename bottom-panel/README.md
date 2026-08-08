# Bottom Panel

Bottom dock/panel for GNOME Shell 50. Replaces the top bar with a bottom panel that reuses native Shell indicators (Quick Settings, clock, tray) plus favorites and running apps.

![Bottom Panel screenshot](screenshot.png)

## Features

- Bottom panel with favorites / running apps
- Native Quick Settings, clock/calendar, and system tray
- Optional workspaces, keyboard layout, blur, multi-monitor
- Auto-hide and appearance preferences

## Requirements

- GNOME Shell 50
- `glib-compile-schemas`, `rsync`, `zip`

## Install

```bash
./install.sh
# or: make install && make enable
```

Reload:

```bash
gnome-extensions disable bottom-panel@mortenaho.github.io
gnome-extensions enable bottom-panel@mortenaho.github.io
```

On X11 you can also use `Alt+F2` → `r`.

## Pack

```bash
./pack.sh
```

Upload the zip on [extensions.gnome.org](https://extensions.gnome.org/upload/).

## Debug

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
