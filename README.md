# Bottom Panel

Modern bottom dock/panel for **GNOME Shell 50** (Ubuntu 26.04). Hides the default top bar and builds a floating bottom panel that reuses native Shell indicators (Quick Settings, clock/calendar, battery, network, audio) plus favorites and running apps.

## Project structure

```
gnome-extension/
├── metadata.json              # Extension identity (UUID, shell-version)
├── extension.js               # enable() / disable() lifecycle
├── panel.js                   # BottomPanel actor (per monitor)
├── panelManager.js            # Multi-monitor orchestration
├── prefs.js                   # Adw preferences window
├── stylesheet.css             # Light/dark styling
├── Makefile                   # install / pack / schemas
├── schemas/
│   └── org.gnome.shell.extensions.bottom-panel.gschema.xml
├── indicators/
│   ├── systemTray.js          # Reparents dateMenu + Quick Settings
│   └── workspaceIndicator.js  # Workspace dots
├── widgets/
│   └── taskbar.js             # Dash-based favorites + running apps
└── utils/
    ├── settings.js            # GSettings helpers
    ├── theming.js             # Dark/light + blur + inline CSS
    └── chrome.js              # Hide/restore top panel & overview dash
```

## Features

- Hides the default GNOME top panel (reclaims the work-area strut)
- Bottom panel with rounded corners, configurable margin (floating dock), opacity, blur
- **Running apps + favorites** via stock `Dash.Dash`
- **Clock / calendar / notifications** via native `dateMenu`
- **Quick Settings** (Wi-Fi, Bluetooth, volume, brightness, power mode, battery, user menu: Lock / Log Out / Power Off / Restart) via native `quickSettings`
- Optional workspace indicator
- Dark / light theme adaptation (`org.gnome.desktop.interface color-scheme`)
- Multi-monitor panels (system indicators on primary only)
- HiDPI-aware sizing through monitor scale factors
- Startup slide-in animation
- Preferences UI (Appearance / Layout / Behavior)

## Requirements

- GNOME Shell **50**
- `glib-compile-schemas`
- `rsync`, `zip` (for install / pack targets)

## Build

```bash
cd /home/mortenaho/Projects/gnome-extension
glib-compile-schemas schemas/
# or: make schemas
```

This compiles `schemas/gschemas.compiled`, required for GSettings.

## Installation

```bash
./install.sh
# or: make install
```

Then reload the Shell so GNOME discovers the new UUID:

| Session | How to reload |
|--------|----------------|
| **X11** | `Alt+F2` → type `r` → Enter |
| **Wayland** (Ubuntu default) | Log out and back in, **or** toggle the extension off/on in the Extensions app |

Verify:

```bash
gnome-extensions info bottom-panel@gnome-extension.local
gnome-extensions list --enabled | grep bottom-panel
```

### Pack for distribution

```bash
make pack
# → bottom-panel@gnome-extension.local.zip
```

Install the zip with:

```bash
gnome-extensions install bottom-panel@gnome-extension.local.zip
```

## Hot reload

During development (after `make install`):

1. Edit sources under this repo.
2. `make install` again (rsyncs into `~/.local/share/gnome-shell/extensions/...`).
3. Reload:
   - **X11:** `Alt+F2` → `r`
   - **Wayland:** `gnome-extensions disable bottom-panel@gnome-extension.local && gnome-extensions enable bottom-panel@gnome-extension.local`  
     (or log out/in if state looks stuck)

`make restart-shell` attempts a programmatic restart on X11 and prints guidance on Wayland.

## Debugging

### Looking Glass

1. `Alt+F2` → `lg` → Enter
2. In the **Evaluator** tab:

```js
Main.layoutManager.monitors
Main.panel.statusArea.quickSettings
Main.panel.statusArea.dateMenu
global.get_window_actors().length
```

3. **Errors** tab shows uncaught extension exceptions.
4. **Windows** / **Actors** help inspect chrome actors named `bottom-panel-monitor-*`.

### journalctl

```bash
# Follow Shell output (includes extension console.debug / warn)
journalctl -f -o cat /usr/bin/gnome-shell

# Or via Make
make logs

# Filter for this extension
journalctl -b -o cat /usr/bin/gnome-shell | grep -i 'bottom panel'
```

In Looking Glass or code, use:

```js
console.debug('Bottom Panel: …');
console.warn('Bottom Panel: …');
```

### Common checks

```bash
# Schema readable?
gsettings list-keys org.gnome.shell.extensions.bottom-panel

# Extension state
gnome-extensions show bottom-panel@gnome-extension.local
```

## Component reference

| Module | Role |
|--------|------|
| `extension.js` | Loads settings, disables conflicting docks (Ubuntu Dock / Dash to Dock / Dash in Panel), starts `PanelManager`. |
| `panelManager.js` | Creates one `BottomPanel` per monitor (or primary only), reacts to settings + `monitors-changed`. |
| `panel.js` | Chrome actor: left (workspaces + taskbar), center (optional clock), right (system tray). Tracks struts via `addChrome`. |
| `widgets/taskbar.js` | Subclasses `Dash.Dash` for favorites/running apps at a fixed icon size. |
| `indicators/systemTray.js` | **Reparents** `dateMenu` + `quickSettings` (and a11y/keyboard/…) into the bottom panel; flips menus to open upward. |
| `indicators/workspaceIndicator.js` | Workspace dots synced with `Main.createWorkspacesAdjustment`. |
| `utils/chrome.js` | Collapses `panelBox` height to 0 and hides the top panel; restores on disable. |
| `utils/theming.js` | Light/dark classes, blur effect, inline geometry CSS, HiDPI scaling. |
| `utils/settings.js` | Typed GSettings snapshot + change subscriptions. |
| `prefs.js` | libadwaita preferences. |

## How system indicators are handled

GNOME Shell 50 owns these as **singletons** on `Main.panel.statusArea`:

- `dateMenu` — clock, calendar, notification list  
- `quickSettings` — network, Bluetooth, volume, brightness, power profiles, battery, dark mode, Do Not Disturb, lock / logout / power  

This extension **moves their existing actors** into the bottom panel instead of cloning behavior. That keeps click targets, menus, and D-Bus backends identical to stock GNOME.

On disable, indicators are reparented back and `Main.panel._updatePanel()` is invoked.

## Limitations imposed by GNOME Shell

1. **Singleton indicators** — Quick Settings / dateMenu can only live on one panel. Secondary monitors get a lightweight `SecondaryClock` that opens the primary calendar.
2. **PopupMenu side** — `PanelMenu.Button` hard-codes `St.Side.TOP`. We patch `_arrowSide` / BoxPointer after move so menus open upward. This touches private API and may need updates on future Shell releases.
3. **Top panelBox strut** — Simply calling `panel.hide()` leaves a reserved top gap. We set `panel.height = 0` and `panelBox.height = 0` (same approach as hide-top-bar extensions).
4. **Overview dash** — Separate from the top panel; optionally hidden so launchers are not duplicated.
5. **Blur** — `Shell.BlurEffect` quality varies by GPU / fractional scaling. Opacity fallback always works; blur can be disabled in preferences.
6. **Wayland reload** — Full Shell restart via `Alt+F2 r` is X11-only. Wayland requires extension toggle or session restart.
7. **Conflicting docks** — Ubuntu Dock / Dash to Dock manipulate the same dash/chrome. They are temporarily added to `disabled-extensions` while this extension is enabled.
8. **Private Shell APIs** — `Main.panel._updatePanel`, Dash internals (`_dashContainer`, `_box`), and menu `_boxPointer` are not public ABI. Pin `shell-version` to `50` and retest on upgrades.
9. **Notification “indicator”** — Modern GNOME has no separate tray bell; notifications are inside the calendar (`dateMenu`). That is intentional upstream design.
10. **Async Quick Settings** — Network/Bluetooth indicators load asynchronously in Shell 50. Enable waits an idle tick; very early enable during startup connects to `startup-complete`.

## Uninstall

```bash
make uninstall
```

## License

GPL-2.0-or-later (same family as GNOME Shell extensions).
