# Custom Navbar

Replaces the GNOME top-bar clock and keyboard indicator with a country flag and a seven-segment clock. The rest of the stock panel stays as-is.

## Features

- Keyboard layout as a flat flag (click to switch)
- Seven-segment clock (click opens calendar / notifications)
- Configurable LED color, 12/24h, colon blink, sizes

## Install

```bash
./install.sh
# or: make install && make enable
```

Reload:

```bash
gnome-extensions disable custom-navbar@mortenaho.github.io
gnome-extensions enable custom-navbar@mortenaho.github.io
```

On X11 you can also use `Alt+F2` → `r`.

Do not run together with Bottom Panel (that hides the top bar).

## License

GPL-2.0-or-later. DSEG font: SIL OFL 1.1 (`fonts/DSEG-LICENSE.txt`).
