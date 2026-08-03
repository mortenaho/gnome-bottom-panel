/**
 * Keyboard layout indicator (character, flat flag, or both).
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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
 * @param {string} path
 * @returns {string} CSS url() with file URI
 */
function cssFlagBackground(path) {
    const uri = Gio.File.new_for_path(path).get_uri();
    // Fill the rectangle completely — no letterboxing, no border.
    return `background-image: url("${uri}"); background-size: 100% 100%; background-repeat: no-repeat; background-position: center;`;
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
        });
        this.add_child(this._box);

        this._flagBin = new St.Widget({
            style_class: 'bottom-panel-kb-flag-rect',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this._applyFlagGeometry();

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
        const w = Math.max(h + 4, Math.round(h * FLAG_ASPECT));
        return {w, h};
    }

    _applyFlagGeometry() {
        const {w, h} = this._flagMetrics();
        this._flagBin.set_size(w, h);
    }

    _applyFlagImage() {
        if (!this._flagPath) {
            this._flagBin.set_style('');
            return;
        }
        this._flagBin.set_style(cssFlagBackground(this._flagPath));
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
                const iconBin = new St.Widget({
                    style_class: 'bottom-panel-kb-flag-rect',
                    width: w,
                    height: h,
                    style: cssFlagBackground(path),
                });
                row.add_child(iconBin);
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
