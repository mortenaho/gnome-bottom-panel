/**
 * Combined top-bar widget: keyboard flag + seven-segment clock.
 *
 * Flag click cycles the keyboard layout; clock click toggles the calendar.
 */

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {
    sourceToCountry,
    flagFilePath,
} from '../utils/flags.js';

const FONT_FILE = 'DSEG7Classic-Bold.ttf';
const FONT_FAMILY = 'DSEG7 Classic';
const DIGIT_EM = 0.82;
const COLON_EM = 0.22;
const FLAG_ASPECT = 1.85;

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
 * @param {string} value
 * @returns {string}
 */
export function normalizeLedColor(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (LED_PRESETS[raw])
        return LED_PRESETS[raw];
    if (/^#[0-9a-f]{6}$/.test(raw))
        return raw;
    if (/^#[0-9a-f]{3}$/.test(raw))
        return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    return LED_PRESETS.white;
}

/**
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
                console.warn(`Custom Navbar: missing font ${srcPath}`);
                resolve(false);
                return;
            }

            const destDirPath = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'fonts', 'custom-navbar',
            ]);
            GLib.mkdir_with_parents(destDirPath, 0o755);

            const dest = Gio.File.new_for_path(
                GLib.build_filenamev([destDirPath, FONT_FILE]));
            src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
            GLib.spawn_command_line_async(`fc-cache -f "${destDirPath}"`);

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.warn(`Custom Navbar: could not install DSEG font: ${e}`);
            resolve(false);
        }
    });

    return _fontReady;
}

/**
 * @returns {number}
 */
function uiScaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

/**
 * @param {string} path
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function scaledFlagUri(path, width, height) {
    const scale = uiScaleFactor();
    const pw = Math.max(1, Math.round(width * scale));
    const ph = Math.max(1, Math.round(height * scale));
    const cacheDir = GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'custom-navbar-flags',
    ]);
    GLib.mkdir_with_parents(cacheDir, 0o755);

    const digest = GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA1, `${path}|${pw}x${ph}`, -1);
    const out = GLib.build_filenamev([cacheDir, `${digest}.png`]);

    if (!GLib.file_test(out, GLib.FileTest.IS_REGULAR)) {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, pw, ph, false);
        pixbuf.savev(out, 'png', [], []);
    }

    return Gio.File.new_for_path(out).get_uri();
}

/**
 * @param {string} path
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function cssFlagBackground(path, width, height) {
    let uri;
    try {
        uri = scaledFlagUri(path, width, height);
    } catch (_e) {
        uri = Gio.File.new_for_path(path).get_uri();
    }

    return [
        `width: ${width}px`,
        `height: ${height}px`,
        `background-image: url("${uri}")`,
        'background-size: contain',
        'background-repeat: no-repeat',
        'background-position: center',
        'background-color: transparent',
    ].join('; ');
}

/**
 * @param {number} thickness
 * @returns {number}
 */
function fontSizeForThickness(thickness) {
    const t = Math.max(1, Math.min(8, thickness | 0));
    return 12 + t * 3;
}

export const NavbarWidget = GObject.registerClass(
class NavbarWidget extends PanelMenu.Button {
    /**
     * @param {{
     *   extensionPath?: string,
     *   ledColor?: string,
     *   hourFormat?: string,
     *   colonBlink?: boolean,
     *   flagHeight?: number,
     *   clockThickness?: number,
     * }} [options]
     */
    _init(options = {}) {
        // Dummy menu — clicks are handled by the flag / clock children.
        super._init(0.5, 'Custom Navbar', true);

        this.add_style_class_name('custom-navbar-widget');

        this._extensionPath = options.extensionPath || '';
        this._ledColor = normalizeLedColor(options.ledColor || 'white');
        this._hourFormat = options.hourFormat === '12' ? '12' : '24';
        this._colonBlink = options.colonBlink !== false;
        this._flagHeight = Math.max(12, Math.min(32, options.flagHeight | 0 || 18));
        this._clockThickness = Math.max(1, Math.min(8, options.clockThickness | 0 || 3));
        this._flagPath = null;
        this._tickId = 0;
        this._colonLit = true;

        this._box = new St.BoxLayout({
            style_class: 'custom-navbar-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        const {w, h} = this._flagMetrics();
        this._flagButton = new St.Button({
            style_class: 'custom-navbar-flag-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._flagBin = new St.Widget({
            style_class: 'custom-navbar-flag',
            reactive: false,
            clip_to_allocation: true,
            width: w,
            height: h,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lockFlagSize(w, h);
        this._flagButton.set_child(this._flagBin);
        this._flagButton.connect('clicked', () => this._cycleKeyboard());

        this._clockButton = new St.Button({
            style_class: 'custom-navbar-clock-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockLabel = new St.Label({
            style_class: 'custom-navbar-clock-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clockLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._clockLabel.clutter_text.single_line_mode = true;
        this._clockButton.set_child(this._clockLabel);
        this._clockButton.connect('clicked', () => this._toggleCalendar());

        this._box.add_child(this._flagButton);
        this._box.add_child(this._clockButton);

        this._manager = Keyboard.getInputSourceManager();
        this._manager.connectObject(
            'current-source-changed', () => this._syncKeyboard(),
            'sources-changed', () => this._syncKeyboard(),
            this);

        this._syncKeyboard();
        this._applyClockStyle();
        this._syncTime();
        this._startTick();

        if (this._extensionPath) {
            ensureDsegFont(this._extensionPath).then(ok => {
                if (ok && this._clockLabel)
                    this._applyClockStyle();
            });
        }

        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {{
     *   ledColor?: string,
     *   hourFormat?: string,
     *   colonBlink?: boolean,
     *   flagHeight?: number,
     *   clockThickness?: number,
     * }} options
     */
    setOptions(options = {}) {
        if (options.ledColor)
            this._ledColor = normalizeLedColor(options.ledColor);
        if (options.hourFormat === '12' || options.hourFormat === '24')
            this._hourFormat = options.hourFormat;
        if (typeof options.colonBlink === 'boolean')
            this._colonBlink = options.colonBlink;
        if (typeof options.flagHeight === 'number' && Number.isFinite(options.flagHeight)) {
            this._flagHeight = Math.max(12, Math.min(32, Math.round(options.flagHeight)));
            this._applyFlagGeometry();
            this._applyFlagImage();
        }
        if (typeof options.clockThickness === 'number' && Number.isFinite(options.clockThickness))
            this._clockThickness = Math.max(1, Math.min(8, Math.round(options.clockThickness)));

        this._applyClockStyle();
        this._syncTime();
    }

    _flagMetrics() {
        const h = this._flagHeight;
        const w = Math.max(h + 4, Math.min(Math.round(h * FLAG_ASPECT), h * 2));
        return {w, h};
    }

    /**
     * @param {number} width
     * @param {number} height
     */
    _lockFlagSize(width, height) {
        this._flagBin.set({
            width,
            height,
            min_width: width,
            max_width: width,
            min_height: height,
            max_height: height,
        });
    }

    _applyFlagGeometry() {
        const {w, h} = this._flagMetrics();
        this._lockFlagSize(w, h);
    }

    _applyFlagImage() {
        const {w, h} = this._flagMetrics();
        if (!this._flagPath) {
            this._flagBin.set_style(`width: ${w}px; height: ${h}px; background-color: transparent;`);
            return;
        }
        this._flagBin.set_style(cssFlagBackground(this._flagPath, w, h));
    }

    _syncKeyboard() {
        const source = this._manager.currentSource;
        const country = sourceToCountry(source);
        const path = country
            ? flagFilePath(this._extensionPath, country)
            : null;

        this._flagPath = path;
        this._flagButton.visible = !!source &&
            Object.keys(this._manager.inputSources || {}).length > 0;
        this._applyFlagGeometry();
        this._applyFlagImage();
    }

    /** Cycle to the next configured input source. */
    _cycleKeyboard() {
        const sources = this._manager.inputSources;
        if (!sources)
            return;

        const ids = Object.keys(sources).sort((a, b) => Number(a) - Number(b));
        if (ids.length < 2) {
            // Still try Shell's helper when only one is indexed oddly.
            this._manager.activateNext?.();
            return;
        }

        if (typeof this._manager.activateNext === 'function') {
            this._manager.activateNext();
            return;
        }

        const current = this._manager.currentSource;
        const curIdx = ids.findIndex(id => sources[id] === current);
        const next = sources[ids[(curIdx + 1) % ids.length]];
        next?.activate(true);
    }

    _contentWidth(fontSize) {
        const digits = 4;
        const colons = 1;
        let w = digits * DIGIT_EM * fontSize + colons * COLON_EM * fontSize;
        if (this._hourFormat === '12')
            w += COLON_EM * fontSize + 2 * DIGIT_EM * fontSize;
        return Math.ceil(w + 4);
    }

    _applyClockStyle() {
        const size = fontSizeForThickness(this._clockThickness);
        const hex = this._ledColor;
        const textW = this._contentWidth(size);

        this._clockLabel.set_style(
            `font-family: "${FONT_FAMILY}"; ` +
            `font-weight: bold; ` +
            `font-size: ${size}px; ` +
            `color: ${hex}; ` +
            `letter-spacing: 0;`
        );
        this._clockLabel.set({
            width: textW,
            min_width: textW,
        });
        this._clockLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
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

        let suffix = '';
        if (this._hourFormat === '12') {
            const isPm = hours >= 12;
            hours = hours % 12;
            if (hours === 0)
                hours = 12;
            suffix = isPm ? ' PM' : ' AM';
        }

        const colon = this._colonLit ? ':' : ' ';
        this._clockLabel.text =
            `${this._pad2(hours)}${colon}${this._pad2(minutes)}${suffix}`;
    }

    _toggleCalendar() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        // Anchor under our visible clock (stock dateMenu chrome stays hidden).
        dateMenu.menu.sourceActor = this._clockButton;
        dateMenu.menu._arrowSide = St.Side.TOP;
        if (dateMenu.menu._boxPointer)
            dateMenu.menu._boxPointer._arrowSide = St.Side.TOP;

        dateMenu.menu.toggle();
    }

    _onDestroy() {
        this._stopTick();
        this._manager?.disconnectObject(this);

        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (dateMenu?.menu?.sourceActor === this._clockButton)
            dateMenu.menu.sourceActor = dateMenu;
    }
});
