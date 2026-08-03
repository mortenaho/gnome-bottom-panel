/**
 * Preferences window (Adw / GTK 4).
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class BottomPanelPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.title = _('Bottom Panel');
        window.search_enabled = true;

        window.add(this._buildAppearancePage(settings));
        window.add(this._buildLayoutPage(settings));
        window.add(this._buildBehaviorPage(settings));
    }

    /**
     * @param {Gio.Settings} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildAppearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Panel look'),
            description: _('Size, corners, color, opacity, and blur'),
        });
        page.add(group);

        group.add(this._spinRow(settings, 'panel-height', _('Height'),
            _('Logical pixels; scaled automatically on HiDPI monitors'),
            32, 96, 1));
        group.add(this._spinRow(settings, 'icon-size', _('Icon size'),
            _('Application icon size in the taskbar'),
            16, 64, 1));
        group.add(this._spinRow(settings, 'tray-icon-size', _('Tray icon size'),
            _('System indicators and keyboard icon size on the right'),
            12, 48, 1));
        group.add(this._spinRow(settings, 'panel-margin', _('Margin'),
            _('Gap from screen edges (floating dock when > 0)'),
            0, 24, 1));
        group.add(this._spinRow(settings, 'border-radius', _('Corner radius'),
            null, 0, 32, 1));
        group.add(this._spinRow(settings, 'panel-spacing', _('Spacing'),
            _('Padding inside the panel'),
            0, 32, 1));

        group.add(this._switchRow(settings, 'use-custom-panel-color',
            _('Custom panel color'),
            _('Override the light/dark theme background with a chosen color')));

        const colorRow = new Adw.ActionRow({
            title: _('Panel color'),
            subtitle: _('Dock background; opacity is set separately below'),
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({
                title: _('Panel color'),
                with_alpha: false,
            }),
            valign: Gtk.Align.CENTER,
        });
        colorRow.add_suffix(colorButton);
        colorRow.activatable_widget = colorButton;

        const applyColorButton = () => {
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string('panel-color')))
                rgba.parse('#202020');
            colorButton.set_rgba(rgba);
        };
        applyColorButton();

        colorButton.connect('notify::rgba', () => {
            const rgba = colorButton.get_rgba();
            const toHex = c => Math.round(c * 255)
                .toString(16).padStart(2, '0');
            settings.set_string('panel-color',
                `#${toHex(rgba.red)}${toHex(rgba.green)}${toHex(rgba.blue)}`);
        });
        settings.connect('changed::panel-color', applyColorButton);

        settings.bind('use-custom-panel-color', colorRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(colorRow);

        const opacity = new Adw.SpinRow({
            title: _('Opacity'),
            subtitle: _('Panel background opacity'),
            adjustment: new Gtk.Adjustment({
                lower: 0.3,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
            }),
            digits: 2,
        });
        settings.bind('panel-opacity', opacity, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(opacity);

        group.add(this._switchRow(settings, 'enable-blur', _('Background blur'),
            _('Uses Shell.BlurEffect when the compositor supports it')));

        return page;
    }

    /**
     * @param {Gio.Settings} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildLayoutPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Layout'),
            icon_name: 'view-grid-symbolic',
        });

        const contents = new Adw.PreferencesGroup({
            title: _('Contents'),
        });
        page.add(contents);

        contents.add(this._switchRow(settings, 'show-favorites',
            _('Favorites'), _('Pinned applications')));
        contents.add(this._switchRow(settings, 'show-running-apps',
            _('Running applications'), _('Open application icons')));
        contents.add(this._switchRow(settings, 'show-show-apps-button',
            _('Show Apps button'), _('Opens the application overview')));
        contents.add(this._buildAppsIconRow(settings));

        const taskbarDir = new Adw.ComboRow({
            title: _('Taskbar direction'),
            subtitle: _('Order of the Apps button and application icons'),
            model: new Gtk.StringList({
                strings: [_('Left to right'), _('Right to left')],
            }),
        });
        const applyTaskbarDir = () => {
            const value = settings.get_string('taskbar-direction');
            taskbarDir.selected = value === 'rtl' ? 1 : 0;
        };
        applyTaskbarDir();
        taskbarDir.connect('notify::selected', () => {
            settings.set_string('taskbar-direction',
                taskbarDir.selected === 1 ? 'rtl' : 'ltr');
        });
        settings.connect('changed::taskbar-direction', applyTaskbarDir);
        contents.add(taskbarDir);

        const taskbarAlign = new Adw.ComboRow({
            title: _('Taskbar alignment'),
            subtitle: _('Place the Apps button and icons in the center or toward the right'),
            model: new Gtk.StringList({
                strings: [_('Center'), _('Right')],
            }),
        });
        const applyTaskbarAlign = () => {
            const value = settings.get_string('taskbar-alignment');
            taskbarAlign.selected = value === 'right' ? 1 : 0;
        };
        applyTaskbarAlign();
        taskbarAlign.connect('notify::selected', () => {
            settings.set_string('taskbar-alignment',
                taskbarAlign.selected === 1 ? 'right' : 'center');
        });
        settings.connect('changed::taskbar-alignment', applyTaskbarAlign);
        contents.add(taskbarAlign);

        contents.add(this._switchRow(settings, 'show-workspaces',
            _('Workspace indicator'), _('Clickable workspace dots')));
        contents.add(this._switchRow(settings, 'show-clock',
            _('Clock & calendar'),
            _('Uses the native GNOME date menu (calendar + notifications)')));
        contents.add(this._switchRow(settings, 'show-system-indicators',
            _('System indicators'),
            _('Quick Settings: Wi-Fi, Bluetooth, volume, brightness, battery, power')));

        page.add(this._buildItemOrderGroup(settings));

        const keyboardGroup = new Adw.PreferencesGroup({
            title: _('Keyboard layout'),
            description: _('Flag uses a rectangular country badge'),
        });
        page.add(keyboardGroup);

        keyboardGroup.add(this._switchRow(settings, 'show-keyboard-layout',
            _('Show keyboard layout'),
            _('Uses flat rectangular SVG flags (not emoji)')));

        const kbMode = new Adw.ComboRow({
            title: _('Display mode'),
            subtitle: _('Character (en/fa), flat flag, or both — flags are 3:2 rectangles'),
            model: new Gtk.StringList({
                strings: [_('Character'), _('Flag'), _('Both')],
            }),
        });
        const modeMap = ['character', 'flag', 'both'];
        const applyKbMode = () => {
            const value = settings.get_string('keyboard-display-mode');
            const idx = modeMap.indexOf(value);
            kbMode.selected = idx >= 0 ? idx : 2;
        };
        applyKbMode();
        kbMode.connect('notify::selected', () => {
            settings.set_string('keyboard-display-mode',
                modeMap[kbMode.selected] ?? 'both');
        });
        settings.connect('changed::keyboard-display-mode', applyKbMode);
        keyboardGroup.add(kbMode);

        const clockGroup = new Adw.PreferencesGroup({
            title: _('Clock'),
        });
        page.add(clockGroup);

        const clockPos = new Adw.ComboRow({
            title: _('Clock position'),
            model: new Gtk.StringList({
                strings: [_('Center'), _('Right')],
            }),
        });
        const applyClock = () => {
            const value = settings.get_string('clock-position');
            clockPos.selected = value === 'right' ? 1 : 0;
        };
        applyClock();
        clockPos.connect('notify::selected', () => {
            settings.set_string('clock-position',
                clockPos.selected === 1 ? 'right' : 'center');
        });
        settings.connect('changed::clock-position', applyClock);
        clockGroup.add(clockPos);

        const clockStyle = new Adw.ComboRow({
            title: _('Clock style'),
            subtitle: _('Native GNOME clock or seven-segment LED face'),
            model: new Gtk.StringList({
                strings: [_('Default'), _('Seven-segment')],
            }),
        });
        const styleMap = ['default', 'seven-segment'];
        const applyStyle = () => {
            const value = settings.get_string('clock-style');
            const idx = styleMap.indexOf(value);
            clockStyle.selected = idx >= 0 ? idx : 0;
            const seven = settings.get_string('clock-style') === 'seven-segment';
            clockFormat.sensitive = seven;
            clockHour.sensitive = seven;
            clockLed.sensitive = seven;
            clockThickness.sensitive = seven;
            clockBlink.sensitive = seven;
        };
        clockStyle.connect('notify::selected', () => {
            settings.set_string('clock-style',
                styleMap[clockStyle.selected] ?? 'default');
        });
        settings.connect('changed::clock-style', applyStyle);
        clockGroup.add(clockStyle);

        const clockFormat = new Adw.ComboRow({
            title: _('Time format'),
            subtitle: _('Hours and minutes, or include seconds'),
            model: new Gtk.StringList({
                strings: [_('Hours:Minutes'), _('Hours:Minutes:Seconds')],
            }),
        });
        const formatMap = ['hm', 'hms'];
        const applyFormat = () => {
            const value = settings.get_string('clock-format');
            const idx = formatMap.indexOf(value);
            clockFormat.selected = idx >= 0 ? idx : 0;
        };
        applyFormat();
        clockFormat.connect('notify::selected', () => {
            settings.set_string('clock-format',
                formatMap[clockFormat.selected] ?? 'hm');
        });
        settings.connect('changed::clock-format', applyFormat);
        clockGroup.add(clockFormat);

        const clockHour = new Adw.ComboRow({
            title: _('Hour format'),
            model: new Gtk.StringList({
                strings: [_('24-hour'), _('12-hour')],
            }),
        });
        const hourMap = ['24', '12'];
        const applyHour = () => {
            const value = settings.get_string('clock-hour-format');
            clockHour.selected = value === '12' ? 1 : 0;
        };
        applyHour();
        clockHour.connect('notify::selected', () => {
            settings.set_string('clock-hour-format',
                hourMap[clockHour.selected] ?? '24');
        });
        settings.connect('changed::clock-hour-format', applyHour);
        clockGroup.add(clockHour);

        const clockLed = new Adw.ActionRow({
            title: _('LED color'),
            subtitle: _('Any color, including white'),
        });
        const colorBtn = new Gtk.ColorDialogButton({
            valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog({
                title: _('LED color'),
                with_alpha: false,
            }),
        });

        const parseLed = value => {
            const presets = {
                red: '#ff3b30',
                green: '#34c759',
                blue: '#0a84ff',
                amber: '#ff9f0a',
                white: '#ffffff',
            };
            let hex = String(value || '').trim().toLowerCase();
            if (presets[hex])
                hex = presets[hex];
            if (!/^#[0-9a-f]{6}$/.test(hex))
                hex = '#ff3b30';
            const rgba = new Gdk.RGBA();
            rgba.parse(hex);
            return rgba;
        };
        const rgbaToHex = rgba => {
            const ch = v => Math.round(v * 255).toString(16).padStart(2, '0');
            return `#${ch(rgba.red)}${ch(rgba.green)}${ch(rgba.blue)}`;
        };

        colorBtn.rgba = parseLed(settings.get_string('clock-led-color'));
        let ledSync = false;
        colorBtn.connect('notify::rgba', () => {
            if (ledSync)
                return;
            settings.set_string('clock-led-color', rgbaToHex(colorBtn.rgba));
        });
        settings.connect('changed::clock-led-color', () => {
            ledSync = true;
            colorBtn.rgba = parseLed(settings.get_string('clock-led-color'));
            ledSync = false;
        });
        clockLed.add_suffix(colorBtn);
        clockLed.activatable_widget = colorBtn;
        clockGroup.add(clockLed);

        const clockThickness = this._spinRow(settings, 'clock-segment-thickness',
            _('Segment size'),
            _('Size of the DSEG seven-segment digits'),
            1, 8, 1);
        clockGroup.add(clockThickness);

        const clockBlink = this._switchRow(settings, 'clock-colon-blink',
            _('Blinking colon'),
            _('Pulse the colon separators on the seven-segment clock'));
        clockGroup.add(clockBlink);

        applyStyle();

        const monitors = new Adw.PreferencesGroup({
            title: _('Monitors'),
        });
        page.add(monitors);
        monitors.add(this._switchRow(settings, 'multi-monitor',
            _('Panel on all monitors'),
            _('System indicators remain on the primary monitor only')));

        return page;
    }

    /**
     * Apps / Start button icon: presets, theme name, or image path.
     *
     * @param {Gio.Settings} settings
     * @returns {Adw.PreferencesGroup}
     */
    _buildAppsIconRow(settings) {
        const DEFAULT = 'view-app-grid-symbolic';
        const PRESETS = [
            {id: 'view-app-grid-symbolic', label: _('App grid (default)')},
            {id: 'view-grid-symbolic', label: _('Grid')},
            {id: 'start-here-symbolic', label: _('Start here')},
            {id: 'applications-system-symbolic', label: _('Applications')},
            {id: 'open-menu-symbolic', label: _('Menu')},
            {id: 'go-home-symbolic', label: _('Home')},
            {id: 'custom', label: _('Custom…')},
        ];

        const group = new Adw.PreferencesGroup({
            title: _('Apps button icon'),
            description: _('Theme icon name or path to an image file'),
        });

        const combo = new Adw.ComboRow({
            title: _('Icon'),
            model: new Gtk.StringList({
                strings: PRESETS.map(p => p.label),
            }),
        });

        const customRow = new Adw.EntryRow({
            title: _('Custom icon'),
        });

        const browse = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: _('Choose image file'),
            valign: Gtk.Align.CENTER,
        });
        browse.add_css_class('flat');
        customRow.add_suffix(browse);

        const preview = new Gtk.Image({
            icon_name: DEFAULT,
            pixel_size: 24,
            valign: Gtk.Align.CENTER,
        });
        combo.add_prefix(preview);

        const isFilePath = value =>
            value.startsWith('/') || value.startsWith('file://');

        const presetIndex = value => {
            const idx = PRESETS.findIndex(p => p.id === value);
            return idx >= 0 ? idx : PRESETS.length - 1;
        };

        const updatePreview = value => {
            const icon = value.trim() || DEFAULT;
            if (isFilePath(icon)) {
                try {
                    const file = icon.startsWith('file://')
                        ? Gio.File.new_for_uri(icon)
                        : Gio.File.new_for_path(icon);
                    preview.set_from_gicon(Gio.FileIcon.new(file));
                } catch (_e) {
                    preview.icon_name = DEFAULT;
                }
            } else {
                preview.icon_name = icon;
            }
        };

        let syncing = false;

        const applyFromSettings = () => {
            syncing = true;
            const value = settings.get_string('apps-button-icon') || DEFAULT;
            combo.selected = presetIndex(value);
            const custom = PRESETS[combo.selected]?.id === 'custom';
            customRow.visible = custom;
            if (custom)
                customRow.text = value;
            updatePreview(value);
            syncing = false;
        };

        combo.connect('notify::selected', () => {
            if (syncing)
                return;
            const preset = PRESETS[combo.selected];
            if (!preset || preset.id === 'custom') {
                customRow.visible = true;
                const current = settings.get_string('apps-button-icon') || '';
                if (!current || PRESETS.some(p => p.id === current && p.id !== 'custom'))
                    customRow.text = DEFAULT;
                return;
            }
            customRow.visible = false;
            settings.set_string('apps-button-icon', preset.id);
        });

        customRow.connect('changed', () => {
            if (syncing || !customRow.visible)
                return;
            const text = customRow.text.trim();
            if (text)
                settings.set_string('apps-button-icon', text);
        });

        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({
                title: _('Choose Apps button icon'),
            });
            const filter = new Gtk.FileFilter();
            filter.set_name(_('Images'));
            filter.add_mime_type('image/png');
            filter.add_mime_type('image/svg+xml');
            filter.add_mime_type('image/jpeg');
            filter.add_mime_type('image/webp');
            const filters = Gio.ListStore.new(Gtk.FileFilter.$gtype);
            filters.append(filter);
            dialog.filters = filters;
            dialog.default_filter = filter;

            dialog.open(browse.get_root(), null, (_d, res) => {
                try {
                    const file = dialog.open_finish(res);
                    if (!file)
                        return;
                    const path = file.get_path();
                    if (!path)
                        return;
                    syncing = true;
                    combo.selected = PRESETS.length - 1;
                    customRow.visible = true;
                    customRow.text = path;
                    syncing = false;
                    settings.set_string('apps-button-icon', path);
                } catch (_e) {
                    // Cancelled
                }
            });
        });

        settings.connect('changed::apps-button-icon', applyFromSettings);
        applyFromSettings();

        settings.bind('show-show-apps-button', group, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        group.add(combo);
        group.add(customRow);
        return group;
    }

    /**
     * Reorderable right-side items (clock / system / keyboard).
     *
     * @param {Gio.Settings} settings
     * @returns {Adw.PreferencesGroup}
     */
    _buildItemOrderGroup(settings) {
        const DEFAULT = ['clock', 'keyboard', 'system'];
        const LABELS = {
            clock: _('Clock'),
            system: _('System indicators'),
            keyboard: _('Keyboard layout'),
        };

        const group = new Adw.PreferencesGroup({
            title: _('Item order'),
            description: _('Order of items on the right side of the panel'),
        });

        const rows = new Map();

        const normalize = order => {
            const known = new Set(DEFAULT);
            const seen = new Set();
            const result = [];
            for (const id of order ?? []) {
                if (!known.has(id) || seen.has(id))
                    continue;
                seen.add(id);
                result.push(id);
            }
            for (const id of DEFAULT) {
                if (!seen.has(id))
                    result.push(id);
            }
            return result;
        };

        const readOrder = () =>
            normalize(settings.get_strv('panel-item-order'));

        const writeOrder = order => {
            settings.set_strv('panel-item-order', order);
        };

        const move = (id, delta) => {
            const order = readOrder();
            const idx = order.indexOf(id);
            const next = idx + delta;
            if (idx < 0 || next < 0 || next >= order.length)
                return;
            [order[idx], order[next]] = [order[next], order[idx]];
            writeOrder(order);
        };

        const rebuild = () => {
            for (const row of rows.values())
                group.remove(row);
            rows.clear();

            const order = readOrder();
            order.forEach((id, index) => {
                const row = new Adw.ActionRow({
                    title: LABELS[id] ?? id,
                });

                const up = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Move up'),
                    sensitive: index > 0,
                });
                up.add_css_class('flat');
                up.connect('clicked', () => move(id, -1));

                const down = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Move down'),
                    sensitive: index < order.length - 1,
                });
                down.add_css_class('flat');
                down.connect('clicked', () => move(id, 1));

                const box = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 4,
                    valign: Gtk.Align.CENTER,
                });
                box.append(up);
                box.append(down);
                row.add_suffix(box);
                row.set_activatable(false);

                group.add(row);
                rows.set(id, row);
            });
        };

        rebuild();
        settings.connect('changed::panel-item-order', rebuild);
        return group;
    }

    /**
     * @param {Gio.Settings} settings
     * @returns {Adw.PreferencesPage}
     */
    _buildBehaviorPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('Behavior'),
        });
        page.add(group);

        group.add(this._switchRow(settings, 'isolate-workspaces',
            _('Isolate workspaces'),
            _('Show only windows from the current workspace')));
        group.add(this._switchRow(settings, 'isolate-monitors',
            _('Isolate monitors'),
            _('Show only windows from this monitor in each taskbar')));
        group.add(this._switchRow(settings, 'hide-overview-dash',
            _('Hide overview dash'),
            _('Hide the default dash inside Activities')));
        group.add(this._switchRow(settings, 'scroll-panel-workspaces',
            _('Scroll to switch workspaces'),
            _('Scroll on the panel to change workspace')));
        group.add(this._switchRow(settings, 'animate-startup',
            _('Startup animation'),
            _('Slide the panel in when enabled')));

        const hideGroup = new Adw.PreferencesGroup({
            title: _('Auto-hide'),
            description: _('Stay visible on the desktop; tuck away only when a window is maximized'),
        });
        page.add(hideGroup);

        hideGroup.add(this._switchRow(settings, 'autohide',
            _('Auto-hide panel'),
            _('Show on empty desktop / normal windows; hide when maximized, reveal from the bottom edge')));
        hideGroup.add(this._spinRow(settings, 'autohide-delay',
            _('Hide delay'),
            _('Milliseconds to wait before hiding after the pointer leaves'),
            0, 5000, 50));

        return page;
    }

    /**
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {string} title
     * @param {string|null} subtitle
     * @returns {Adw.SwitchRow}
     */
    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({
            title,
            subtitle: subtitle ?? null,
        });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /**
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {string} title
     * @param {string|null} subtitle
     * @param {number} min
     * @param {number} max
     * @param {number} step
     * @returns {Adw.SpinRow}
     */
    _spinRow(settings, key, title, subtitle, min, max, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle ?? null,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 4,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
