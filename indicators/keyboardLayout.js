/**
 * Keyboard layout indicator (character, flat flag, or both).
 *
 * Flags are scaled to the tray slot and painted into a clipped rectangle so
 * large source PNGs can never spill outside the indicator allocation.
 */

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {
    sourceToCountry,
    flagFilePath,
} from '../utils/flags.js';

/** Typical flag aspect (~US 1.9, IR 1.74). */
const FLAG_ASPECT = 1.85;

/**
 * @param {object} source
 * @returns {string}
 */
function sourceShortLabel(source) {
    return source?.shortName || source?.id?.split(':').pop() || '?';
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
 * Write a device-pixel-sized flag into the user cache and return its file URI.
 * Pre-scaling prevents St from taking the source PNG's intrinsic 800px size.
 *
 * @param {string} path
 * @param {number} width — logical px
 * @param {number} height — logical px
 * @returns {string} file:// URI
 */
function scaledFlagUri(path, width, height) {
    const scale = uiScaleFactor();
    const pw = Math.max(1, Math.round(width * scale));
    const ph = Math.max(1, Math.round(height * scale));
    const cacheDir = GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'bottom-panel-flags',
    ]);
    GLib.mkdir_with_parents(cacheDir, 0o755);

    const digest = GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA1, `${path}|${pw}x${ph}`, -1);
    const out = GLib.build_filenamev([cacheDir, `${digest}.png`]);

    if (!GLib.file_test(out, GLib.FileTest.IS_REGULAR)) {
        // false = stretch to fill the slot (flag rect cover; parent clips).
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, pw, ph, false);
        pixbuf.savev(out, 'png', [], []);
    }

    return Gio.File.new_for_path(out).get_uri();
}

/**
 * @param {string} path
 * @param {number} width — logical px
 * @param {number} height — logical px
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
 * Fixed-size clipped flag chip. Size is locked so layout cannot grow to the
 * source image’s intrinsic dimensions.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} [style]
 * @returns {St.Widget}
 */
function createFlagChip(width, height, style = '') {
    const chip = new St.Widget({
        style_class: 'bottom-panel-kb-flag-rect',
        reactive: false,
        x_expand: false,
        y_expand: false,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        clip_to_allocation: true,
        width,
        height,
        style,
    });
    lockFlagChipSize(chip, width, height);
    return chip;
}

/**
 * @param {St.Widget} chip
 * @param {number} width
 * @param {number} height
 */
function lockFlagChipSize(chip, width, height) {
    chip.clip_to_allocation = true;
    chip.set({
        width,
        height,
        min_width: width,
        max_width: width,
        min_height: height,
        max_height: height,
    });
}

export const KeyboardLayoutIndicator = GObject.registerClass(
class KeyboardLayoutIndicator extends PanelMenu.Button {
    /**
     * @param {'character'|'flag'|'both'} displayMode
     * @param {string} extensionPath — absolute path to extension root
     */
    _init(displayMode = 'both', extensionPath = '') {
        super._init(0.5, 'Keyboard', false);

        this._displayMode = displayMode;
        this._extensionPath = extensionPath;
        // Height matches tray icons; width follows flag aspect.
        this._iconSize = 22;
        this._flagPath = null;
        this.add_style_class_name('bottom-panel-keyboard');

        this._box = new St.BoxLayout({
            style_class: 'bottom-panel-keyboard-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: false,
            y_expand: false,
        });
        this.add_child(this._box);

        const {w, h} = this._flagMetrics();
        this._flagBin = createFlagChip(w, h);

        this._charLabel = new St.Label({
            style_class: 'bottom-panel-kb-char',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._flagBin);
        this._box.add_child(this._charLabel);

        this._manager = Keyboard.getInputSourceManager();
        this._manager.connectObject(
            'current-source-changed', () => this._sync(),
            'sources-changed', () => {
                this._rebuildMenu();
                this._sync();
            },
            this);

        this._rebuildMenu();
        this._sync();

        if (this.menu && !this.menu.isDummy) {
            this.menu._arrowSide = St.Side.BOTTOM;
            if (this.menu._boxPointer)
                this.menu._boxPointer._arrowSide = St.Side.BOTTOM;
        }

        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {'character'|'flag'|'both'} mode
     */
    setDisplayMode(mode) {
        this._displayMode = mode;
        this._sync();
    }

    /**
     * Match other tray icons: `size` is the icon height in logical pixels.
     *
     * @param {number} size
     */
    setIconSize(size) {
        const next = Math.max(14, Math.min(48, size | 0));
        if (next === this._iconSize)
            return;
        this._iconSize = next;
        this._applyFlagGeometry();
        this._applyFlagImage();
        this._rebuildMenu();
    }

    _flagMetrics() {
        const h = this._iconSize;
        // Cap width so a wide aspect never exceeds ~tray allocation.
        const w = Math.max(h + 4, Math.min(Math.round(h * FLAG_ASPECT), h * 2));
        return {w, h};
    }

    _applyFlagGeometry() {
        const {w, h} = this._flagMetrics();
        lockFlagChipSize(this._flagBin, w, h);
    }

    _applyFlagImage() {
        const {w, h} = this._flagMetrics();
        if (!this._flagPath) {
            this._flagBin.set_style(`width: ${w}px; height: ${h}px; background-color: transparent;`);
            return;
        }
        this._flagBin.set_style(cssFlagBackground(this._flagPath, w, h));
    }

    _rebuildMenu() {
        this.menu.removeAll();

        const sources = this._manager.inputSources;
        if (!sources)
            return;

        const {w, h} = this._flagMetrics();
        const ids = Object.keys(sources).sort((a, b) => Number(a) - Number(b));
        for (const id of ids) {
            const source = sources[id];
            const country = sourceToCountry(source);
            const shortName = sourceShortLabel(source);
            const item = new PopupMenu.PopupMenuItem('');

            const row = new St.BoxLayout({style_class: 'bottom-panel-kb-menu-row'});
            const path = country
                ? flagFilePath(this._extensionPath, country)
                : null;
            if (path) {
                row.add_child(createFlagChip(w, h, cssFlagBackground(path, w, h)));
            }
            row.add_child(new St.Label({
                text: shortName,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            item.remove_child(item.label);
            item.add_child(row);
            item.connect('activate', () => source.activate(true));
            this.menu.addMenuItem(item);
        }
    }

    _sync() {
        const source = this._manager.currentSource;
        const mode = this._displayMode;
        const shortName = sourceShortLabel(source);
        const country = sourceToCountry(source);
        const path = country
            ? flagFilePath(this._extensionPath, country)
            : null;

        const showFlag = (mode === 'flag' || mode === 'both') && !!path;
        const showChar = mode === 'character' || mode === 'both' || !path;

        this._flagPath = showFlag ? path : null;
        this._flagBin.visible = showFlag;
        this._applyFlagGeometry();
        this._applyFlagImage();

        this._charLabel.visible = showChar;
        this._charLabel.text = shortName;

        this.visible = !!source &&
            Object.keys(this._manager.inputSources || {}).length > 0;
    }

    _onDestroy() {
        this._manager?.disconnectObject(this);
    }
});
