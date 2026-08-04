# Custom Navbar

Replaces the default GNOME **top-bar clock** and **keyboard indicator** with a flat country flag and a seven-segment digital clock — while keeping the rest of the stock panel.

## Features

- Keyboard layout as a flat flag (click to switch layouts)
- DSEG seven-segment clock (click opens calendar / notifications)
- Configurable LED color, 12/24h, colon blink, flag height, digit size
- GNOME Shell **50**

## Install

```bash
./install.sh
# or: make install && make enable
```

Then reload the Shell:

| Session | How to reload |
|--------|----------------|
| **X11** | `Alt+F2` → `r` → Enter |
| **Wayland** | Log out/in, or toggle the extension off/on |

```bash
gnome-extensions enable custom-navbar@mortenaho.github.io
gnome-extensions prefs custom-navbar@mortenaho.github.io
```

## Note

Do not run together with **Bottom Panel** (that extension hides the top bar). Use one or the other.

## License

GPL-2.0-or-later. DSEG font: SIL OFL 1.1 (see `fonts/DSEG-LICENSE.txt`).
