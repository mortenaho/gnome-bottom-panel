/**
 * sevenSegmentClock.js — Seven-segment clock using bundled DSEG7 Classic Bold.
 *
 * Glyphs match a modern LED look (mitred joins, rounded outer corners). Only
 * lit segments are drawn by the font. Click toggles the native dateMenu.
 *
 * Font: DSEG by keshikan — SIL Open Font License 1.1 (see fonts/DSEG-LICENSE.txt).
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setMenuOpensUpward} from './systemTray.js';

const FONT_FILE = 'DSEG7Classic-Bold.ttf';
const FONT_FAMILY = 'DSEG7 Classic';

const LED_PRESETS = {
    red: '#ff3b30',
    green: '#34c759',
    blue: '#0a84ff',
    amber: '#ff9f0a',
    white: '#ffffff',
    cyan: '#72cedd',
};

/** @type {Promise<boolean>|null} */
let _fontReady = null;

/**
 * Normalize a stored LED color to `#rrggbb`.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeLedColor(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (LED_PRESETS[raw])
        return LED_PRESETS[raw];

    if (/^#[0-9a-f]{6}$/.test(raw))
        return raw;

    if (/^#[0-9a-f]{3}$/.test(raw)) {
        return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    }

    return LED_PRESETS.red;
}

/**
 * Install the bundled TTF into the user font dir and refresh fontconfig.
 *
 * @param {string} extensionPath
 * @returns {Promise<boolean>}
 */
function ensureDsegFont(extensionPath) {
    if (_fontReady)
        return _fontReady;

    _fontReady = new Promise(resolve => {
        try {
            if (!extensionPath) {
                resolve(false);
                return;
            }

            const srcPath = GLib.build_filenamev([
                extensionPath, 'fonts', FONT_FILE,
            ]);
            const src = Gio.File.new_for_path(srcPath);
            if (!src.query_exists(null)) {
                console.warn(`Bottom Panel: missing font ${srcPath}`);
                resolve(false);
                return;
            }

            const destDirPath = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'fonts', 'bottom-panel',
            ]);
            GLib.mkdir_with_parents(destDirPath, 0o755);

            const dest = Gio.File.new_for_path(
                GLib.build_filenamev([destDirPath, FONT_FILE]));

            src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);

            GLib.spawn_command_line_async(`fc-cache -f "${destDirPath}"`);

            // Give fontconfig a brief moment before first paint.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn(`Bottom Panel: could not install DSEG font: ${e}`);
            resolve(false);
        }
    });

    return _fontReady;
}

/**
 * @param {number} thickness — 1–8
 * @returns {number} px
 */
function fontSizeForThickness(thickness) {
    const t = Math.max(1, Math.min(8, thickness | 0));
    return 12 + t * 2;
}

export const SevenSegmentClock = GObject.registerClass(
class SevenSegmentClock extends St.Button {
    /**
     * @param {{
     *   format?: string,
     *   colonBlink?: boolean,
     *   ledColor?: string,
     *   hourFormat?: string,
     *   thickness?: number,
     *   extensionPath?: string,
     * }} [options]
     */
    _init(options = {}) {
        super._init({
            style_class: 'bottom-panel-clock bottom-panel-seven-seg',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._format = 'hm';
        this._colonBlink = true;
        this._ledColor = LED_PRESETS.red;
        this._thickness = 2;
        this._hourFormat = '24';
        this._extensionPath = '';
        this._tickId = 0;
        this._colonLit = true;
        this._timeText = '00:00';

        this._label = new St.Label({
            style_class: 'seven-seg-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._label);

        this.setOptions(options);
        this._ensureDateMenuUpward();
        this._syncTime();
        this._startTick();

        if (this._extensionPath) {
            ensureDsegFont(this._extensionPath).then(ok => {
                if (ok && this._label)
                    this._applyStyle();
            });
        }

        this.connect('clicked', () => this._toggleCalendar());
        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {{
     *   format?: string,
     *   colonBlink?: boolean,
     *   ledColor?: string,
     *   hourFormat?: string,
     *   thickness?: number,
     *   extensionPath?: string,
     * }} options
     */
    setOptions(options = {}) {
        if (options.format === 'hm' || options.format === 'hms')
            this._format = options.format;
        if (typeof options.colonBlink === 'boolean')
            this._colonBlink = options.colonBlink;
        if (options.ledColor)
            this._ledColor = normalizeLedColor(options.ledColor);
        if (typeof options.thickness === 'number' && Number.isFinite(options.thickness))
            this._thickness = Math.max(1, Math.min(8, Math.round(options.thickness)));
        if (options.hourFormat === '12' || options.hourFormat === '24')
            this._hourFormat = options.hourFormat;
        if (typeof options.extensionPath === 'string' && options.extensionPath)
            this._extensionPath = options.extensionPath;

        this._applyStyle();
        this._syncTime();
    }

    _applyStyle() {
        const size = fontSizeForThickness(this._thickness);
        const hex = this._ledColor;
        this._label.set_style(
            `font-family: "${FONT_FAMILY}", monospace; ` +
            `font-weight: 700; ` +
            `font-size: ${size}px; ` +
            `color: ${hex}; ` +
            `letter-spacing: 0.04em;`
        );
    }

    _startTick() {
        this._stopTick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._colonBlink)
                this._colonLit = !this._colonLit;
            else
                this._colonLit = true;

            this._syncTime();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
    }

    /**
     * @param {number} n
     * @returns {string}
     */
    _pad2(n) {
        return n < 10 ? `0${n}` : `${n}`;
    }

    _syncTime() {
        const now = new Date();
        let hours = now.getHours();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();

        let suffix = '';
        if (this._hourFormat === '12') {
            const isPm = hours >= 12;
            hours = hours % 12;
            if (hours === 0)
                hours = 12;
            suffix = isPm ? ' PM' : ' AM';
        }

        const colon = this._colonLit ? ':' : ' ';
        let text = `${this._pad2(hours)}${colon}${this._pad2(minutes)}`;
        if (this._format === 'hms')
            text += `${colon}${this._pad2(seconds)}`;
        text += suffix;

        this._timeText = text;
        this._label.text = text;
    }

    _ensureDateMenuUpward() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        dateMenu.menu.sourceActor = this;
        setMenuOpensUpward(dateMenu.menu);
    }

    _toggleCalendar() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        this._ensureDateMenuUpward();
        dateMenu.menu.toggle();
    }

    _onDestroy() {
        this._stopTick();
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (dateMenu?.menu?.sourceActor === this)
            dateMenu.menu.sourceActor = dateMenu;
    }
});
