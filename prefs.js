/**
 * prefs.js — Preferences window (Adw / GTK 4) for GNOME Shell 45+.
 */

import Adw from 'gi://Adw';
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
            description: _('Size, corners, opacity, and blur'),
        });
        page.add(group);

        group.add(this._spinRow(settings, 'panel-height', _('Height'),
            _('Logical pixels; scaled automatically on HiDPI monitors'),
            32, 96, 1));
        group.add(this._spinRow(settings, 'icon-size', _('Icon size'),
            _('Application icon size in the taskbar'),
            16, 64, 1));
        group.add(this._spinRow(settings, 'panel-margin', _('Margin'),
            _('Gap from screen edges (floating dock when > 0)'),
            0, 24, 1));
        group.add(this._spinRow(settings, 'border-radius', _('Corner radius'),
            null, 0, 32, 1));
        group.add(this._spinRow(settings, 'panel-spacing', _('Spacing'),
            _('Padding inside the panel'),
            0, 32, 1));

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
        contents.add(this._switchRow(settings, 'show-workspaces',
            _('Workspace indicator'), _('Clickable workspace dots')));
        contents.add(this._switchRow(settings, 'show-clock',
            _('Clock & calendar'),
            _('Uses the native GNOME date menu (calendar + notifications)')));
        contents.add(this._switchRow(settings, 'show-system-indicators',
            _('System indicators'),
            _('Quick Settings: Wi-Fi, Bluetooth, volume, brightness, battery, power')));

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

        const clockLed = new Adw.ComboRow({
            title: _('LED color'),
            model: new Gtk.StringList({
                strings: [_('Red'), _('Green'), _('Blue'), _('Amber')],
            }),
        });
        const ledMap = ['red', 'green', 'blue', 'amber'];
        const applyLed = () => {
            const value = settings.get_string('clock-led-color');
            const idx = ledMap.indexOf(value);
            clockLed.selected = idx >= 0 ? idx : 0;
        };
        applyLed();
        clockLed.connect('notify::selected', () => {
            settings.set_string('clock-led-color',
                ledMap[clockLed.selected] ?? 'red');
        });
        settings.connect('changed::clock-led-color', applyLed);
        clockGroup.add(clockLed);

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
