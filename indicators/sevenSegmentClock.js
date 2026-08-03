/**
 * sevenSegmentClock.js — CSS seven-segment clock face for the bottom panel.
 *
 * Click toggles the native dateMenu (calendar + notifications). Used on both
 * primary and secondary monitors when clock-style is "seven-segment".
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setMenuOpensUpward} from './systemTray.js';

/** Which segments light for digits 0–9 (a–g). */
const DIGIT_SEGMENTS = [
    ['a', 'b', 'c', 'd', 'e', 'f'],        // 0
    ['b', 'c'],                           // 1
    ['a', 'b', 'd', 'e', 'g'],             // 2
    ['a', 'b', 'c', 'd', 'g'],             // 3
    ['b', 'c', 'f', 'g'],                  // 4
    ['a', 'c', 'd', 'f', 'g'],             // 5
    ['a', 'c', 'd', 'e', 'f', 'g'],        // 6
    ['a', 'b', 'c'],                       // 7
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],   // 8
    ['a', 'b', 'c', 'd', 'f', 'g'],        // 9
];

const LED_COLORS = new Set(['red', 'green', 'blue', 'amber']);

/**
 * @param {string} name
 * @returns {St.Widget}
 */
function createSegment(name) {
    return new St.Widget({
        style_class: `seven-seg-seg seven-seg-${name}`,
        x_expand: false,
        y_expand: false,
    });
}

/**
 * Build one digit as nested boxes (reliable in St, no absolute CSS):
 *   a
 * f   b
 *   g
 * e   c
 *   d
 *
 * @returns {St.BoxLayout}
 */
function createDigit() {
    const digit = new St.BoxLayout({
        style_class: 'seven-seg-digit',
        vertical: true,
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const segments = {
        a: createSegment('a'),
        b: createSegment('b'),
        c: createSegment('c'),
        d: createSegment('d'),
        e: createSegment('e'),
        f: createSegment('f'),
        g: createSegment('g'),
    };

    const top = new St.BoxLayout({
        style_class: 'seven-seg-row-h',
        x_align: Clutter.ActorAlign.CENTER,
    });
    top.add_child(segments.a);

    const upper = new St.BoxLayout({style_class: 'seven-seg-row-v'});
    upper.add_child(segments.f);
    upper.add_child(new St.Widget({style_class: 'seven-seg-gap', x_expand: true}));
    upper.add_child(segments.b);

    const mid = new St.BoxLayout({
        style_class: 'seven-seg-row-h',
        x_align: Clutter.ActorAlign.CENTER,
    });
    mid.add_child(segments.g);

    const lower = new St.BoxLayout({style_class: 'seven-seg-row-v'});
    lower.add_child(segments.e);
    lower.add_child(new St.Widget({style_class: 'seven-seg-gap', x_expand: true}));
    lower.add_child(segments.c);

    const bottom = new St.BoxLayout({
        style_class: 'seven-seg-row-h',
        x_align: Clutter.ActorAlign.CENTER,
    });
    bottom.add_child(segments.d);

    digit.add_child(top);
    digit.add_child(upper);
    digit.add_child(mid);
    digit.add_child(lower);
    digit.add_child(bottom);

    digit._segments = segments;
    return digit;
}

/**
 * @param {St.Widget} digit
 * @param {number} value — 0–9, or -1 to blank
 */
function setDigitValue(digit, value) {
    const on = value >= 0 && value <= 9
        ? new Set(DIGIT_SEGMENTS[value])
        : new Set();

    for (const [name, seg] of Object.entries(digit._segments)) {
        if (on.has(name))
            seg.add_style_class_name('on');
        else
            seg.remove_style_class_name('on');
    }
}

/**
 * @returns {St.BoxLayout}
 */
function createColon() {
    const colon = new St.BoxLayout({
        style_class: 'seven-seg-colon',
        vertical: true,
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    colon.add_child(new St.Widget({style_class: 'seven-seg-colon-dot'}));
    colon.add_child(new St.Widget({style_class: 'seven-seg-colon-spacer'}));
    colon.add_child(new St.Widget({style_class: 'seven-seg-colon-dot'}));
    return colon;
}

export const SevenSegmentClock = GObject.registerClass(
class SevenSegmentClock extends St.Button {
    /**
     * @param {{
     *   format?: string,
     *   colonBlink?: boolean,
     *   ledColor?: string,
     *   hourFormat?: string,
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
        this._ledColor = 'red';
        this._hourFormat = '24';
        this._tickId = 0;
        this._colonLit = true;
        this._digits = [];
        this._colons = [];

        this._row = new St.BoxLayout({
            style_class: 'seven-seg-row',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._row);

        this._ampm = new St.Label({
            style_class: 'seven-seg-ampm',
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this._row.add_child(this._ampm);

        this.setOptions(options);
        this._ensureDateMenuUpward();
        this._syncTime();
        this._startTick();

        this.connect('clicked', () => this._toggleCalendar());
        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {{
     *   format?: string,
     *   colonBlink?: boolean,
     *   ledColor?: string,
     *   hourFormat?: string,
     * }} options
     */
    setOptions(options = {}) {
        let rebuild = false;

        if (options.format === 'hm' || options.format === 'hms') {
            if (this._format !== options.format)
                rebuild = true;
            this._format = options.format;
        }
        if (typeof options.colonBlink === 'boolean')
            this._colonBlink = options.colonBlink;
        if (options.ledColor && LED_COLORS.has(options.ledColor))
            this._ledColor = options.ledColor;
        if (options.hourFormat === '12' || options.hourFormat === '24') {
            if (this._hourFormat !== options.hourFormat)
                this._ampm.visible = options.hourFormat === '12';
            this._hourFormat = options.hourFormat;
        }

        this._applyLedColor();
        if (rebuild || this._digits.length === 0)
            this._rebuildFace();
        this._syncTime();
    }

    _applyLedColor() {
        for (const color of LED_COLORS)
            this.remove_style_class_name(`led-${color}`);
        this.add_style_class_name(`led-${this._ledColor}`);
    }

    _rebuildFace() {
        // Keep AM/PM label; remove digits/colons.
        const children = this._row.get_children();
        for (const child of children) {
            if (child !== this._ampm) {
                this._row.remove_child(child);
                child.destroy();
            }
        }

        this._digits = [];
        this._colons = [];

        const showSeconds = this._format === 'hms';
        const groups = showSeconds ? 3 : 2;

        for (let g = 0; g < groups; g++) {
            if (g > 0) {
                const colon = createColon();
                this._row.insert_child_at_index(colon, this._row.get_n_children() - 1);
                this._colons.push(colon);
            }
            for (let i = 0; i < 2; i++) {
                const digit = createDigit();
                this._row.insert_child_at_index(digit, this._row.get_n_children() - 1);
                this._digits.push(digit);
            }
        }

        this._ampm.visible = this._hourFormat === '12';
        // AM/PM stays last.
        this._row.set_child_above_sibling(this._ampm, null);
    }

    _startTick() {
        this._stopTick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._colonBlink) {
                this._colonLit = !this._colonLit;
                this._applyColonState();
            } else if (!this._colonLit) {
                this._colonLit = true;
                this._applyColonState();
            }

            // Refresh time every half-second so seconds stay accurate.
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

    _applyColonState() {
        for (const colon of this._colons) {
            if (this._colonLit)
                colon.remove_style_class_name('colon-off');
            else
                colon.add_style_class_name('colon-off');
        }
    }

    _syncTime() {
        const now = new Date();
        let hours = now.getHours();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();

        if (this._hourFormat === '12') {
            const isPm = hours >= 12;
            hours = hours % 12;
            if (hours === 0)
                hours = 12;
            this._ampm.text = isPm ? 'PM' : 'AM';
        }

        const parts = [
            Math.floor(hours / 10), hours % 10,
            Math.floor(minutes / 10), minutes % 10,
        ];
        if (this._format === 'hms') {
            parts.push(Math.floor(seconds / 10), seconds % 10);
        }

        for (let i = 0; i < this._digits.length; i++)
            setDigitValue(this._digits[i], parts[i] ?? 0);

        if (!this._colonBlink) {
            this._colonLit = true;
            this._applyColonState();
        }
    }

    _ensureDateMenuUpward() {
        const dateMenu = Main.panel.statusArea?.dateMenu;
        if (!dateMenu?.menu)
            return;

        // Anchor the calendar popup to this face (dateMenu may still live on
        // the hidden top panel in seven-segment mode).
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

        this._digits = [];
        this._colons = [];
    }
});
