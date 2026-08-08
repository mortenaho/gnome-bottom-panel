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
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setMenuOpensUpward} from './systemTray.js';

const FONT_FILE = 'DSEG7Classic-Bold.ttf';
const FONT_FAMILY = 'DSEG7 Classic';

/** DSEG7 Classic Bold advances (em): digits ≈ 0.816, colon/space ≈ 0.200. */
const DIGIT_EM = 0.82;
const COLON_EM = 0.22;

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
 * @param {number} [panelHeight] — logical panel height; caps digit size
 * @returns {number} px
 */
function fontSizeForThickness(thickness, panelHeight = 0) {
    const t = Math.max(1, Math.min(8, thickness | 0));
    // Map 1..8 → 14..36 so large segment sizes stay readable.
    let size = 12 + t * 3;
    if (panelHeight > 0)
        size = Math.min(size, Math.max(12, panelHeight - 8));
    return size;
}

export const SevenSegmentClock = GObject.registerClass({
    Signals: {
        'metrics-changed': {},
    },
}, class SevenSegmentClock extends St.Button {
    /**
     * @param {{
     *   format?: string,
     *   colonBlink?: boolean,
     *   ledColor?: string,
     *   hourFormat?: string,
     *   thickness?: number,
     *   panelHeight?: number,
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
            clip_to_allocation: false,
        });

        this._format = 'hm';
        this._colonBlink = true;
        this._ledColor = LED_PRESETS.red;
        this._thickness = 2;
        this._panelHeight = 0;
        this._hourFormat = '24';
        this._extensionPath = '';
        this._tickId = 0;
        this._metricsIdle = 0;
        this._colonLit = true;
        this._timeText = '00:00';
        this._destroyed = false;

        this._label = new St.Label({
            style_class: 'seven-seg-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: false,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label.clutter_text.single_line_mode = true;
        this.set_child(this._label);

        this.setOptions(options);
        this._ensureDateMenuUpward();
        this._syncTime();
        this._startTick();

        if (this._extensionPath) {
            ensureDsegFont(this._extensionPath).then(ok => {
                if (!ok || this._destroyed || !this.get_stage?.() || !this._label)
                    return;
                try {
                    this._applyStyle();
                    this._queueMetricsChanged();
                } catch (_e) {
                    // actor finalized after await
                }
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
     *   panelHeight?: number,
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
        if (typeof options.panelHeight === 'number' && Number.isFinite(options.panelHeight))
            this._panelHeight = Math.max(0, Math.round(options.panelHeight));
        if (options.hourFormat === '12' || options.hourFormat === '24')
            this._hourFormat = options.hourFormat;
        if (typeof options.extensionPath === 'string' && options.extensionPath)
            this._extensionPath = options.extensionPath;

        this._applyStyle();
        this._syncTime();
        this._queueMetricsChanged();
    }

    /**
     * Natural text width for the current format at `fontSize` (DSEG advances).
     *
     * @param {number} fontSize
     * @returns {number}
     */
    _contentWidth(fontSize) {
        const digits = this._format === 'hms' ? 6 : 4;
        const colons = this._format === 'hms' ? 2 : 1;
        let w = digits * DIGIT_EM * fontSize + colons * COLON_EM * fontSize;

        if (this._hourFormat === '12') {
            // " AM" / " PM" — space + two letters
            w += COLON_EM * fontSize + 2 * DIGIT_EM * fontSize;
        }

        // Small slack for hinting / subpixel rounding
        return Math.ceil(w + 4);
    }

    _applyStyle() {
        const size = fontSizeForThickness(this._thickness, this._panelHeight);
        const hex = this._ledColor;
        const textW = this._contentWidth(size);
        // Match .bottom-panel-seven-seg horizontal padding (8px each side).
        const buttonMin = textW + 16;

        this._label.set_style(
            `font-family: "${FONT_FAMILY}"; ` +
            `font-weight: bold; ` +
            `font-size: ${size}px; ` +
            `color: ${hex}; ` +
            `letter-spacing: 0;`
        );

        // Lock label text box; button min-width includes padding so digits
        // are never clipped when the right tray column is squeezed.
        this._label.set({
            width: textW,
            min_width: textW,
        });
        this.set({
            width: -1,
            min_width: buttonMin,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }

    _queueMetricsChanged() {
        if (this._metricsIdle)
            return;
        this._metricsIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._metricsIdle = 0;
            this.queue_relayout();
            this.emit('metrics-changed');
            return GLib.SOURCE_REMOVE;
        });
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

        // Keep colon width stable: DSEG space and ':' share the same advance.
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
        this._destroyed = true;
        this._stopTick();
        if (this._metricsIdle) {
            GLib.Source.remove(this._metricsIdle);
            this._metricsIdle = 0;
        }
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (dateMenu?.menu?.sourceActor === this)
            dateMenu.menu.sourceActor = dateMenu;
    }
});
