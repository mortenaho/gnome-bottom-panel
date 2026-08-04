/**
 * Preferences — Adw (GNOME Shell 45+ prefs process).
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LED_COLOR_IDS = ['white', 'red', 'green', 'blue', 'amber', 'cyan'];

export default class CustomNavbarPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const ledColors = [
            ['white', _('White')],
            ['red', _('Red')],
            ['green', _('Green')],
            ['blue', _('Blue')],
            ['amber', _('Amber')],
            ['cyan', _('Cyan')],
        ];

        const page = new Adw.PreferencesPage({
            title: _('Custom Navbar'),
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(page);

        const clockGroup = new Adw.PreferencesGroup({
            title: _('Clock'),
            description: _('Seven-segment digital clock in the top bar'),
        });
        page.add(clockGroup);

        const colorRow = new Adw.ComboRow({
            title: _('LED color'),
            model: new Gtk.StringList({
                strings: ledColors.map(([, label]) => label),
            }),
        });
        const applyColor = () => {
            const value = settings.get_string('led-color');
            const idx = Math.max(0, LED_COLOR_IDS.indexOf(value));
            colorRow.selected = idx;
        };
        applyColor();
        colorRow.connect('notify::selected', () => {
            const entry = ledColors[colorRow.selected];
            if (entry)
                settings.set_string('led-color', entry[0]);
        });
        settings.connect('changed::led-color', applyColor);
        clockGroup.add(colorRow);

        const hourRow = new Adw.ComboRow({
            title: _('Hour format'),
            model: new Gtk.StringList({
                strings: [_('24-hour'), _('12-hour')],
            }),
        });
        const applyHour = () => {
            hourRow.selected = settings.get_string('hour-format') === '12' ? 1 : 0;
        };
        applyHour();
        hourRow.connect('notify::selected', () => {
            settings.set_string('hour-format', hourRow.selected === 1 ? '12' : '24');
        });
        settings.connect('changed::hour-format', applyHour);
        clockGroup.add(hourRow);

        clockGroup.add(this._switchRow(settings, 'colon-blink',
            _('Blink colon'),
            _('Flash the colon every half second')));

        const thickness = new Adw.SpinRow({
            title: _('Segment size'),
            subtitle: _('Thickness of the seven-segment digits'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        settings.bind('clock-thickness', thickness, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        clockGroup.add(thickness);

        const flagGroup = new Adw.PreferencesGroup({
            title: _('Keyboard flag'),
        });
        page.add(flagGroup);

        const flagHeight = new Adw.SpinRow({
            title: _('Flag height'),
            subtitle: _('Logical pixels'),
            adjustment: new Gtk.Adjustment({
                lower: 12,
                upper: 32,
                step_increment: 1,
                page_increment: 2,
            }),
        });
        settings.bind('flag-height', flagHeight, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        flagGroup.add(flagHeight);
    }

    /**
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {string} title
     * @param {string} [subtitle]
     * @returns {Adw.SwitchRow}
     */
    _switchRow(settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
