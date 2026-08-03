/**
 * keyboardLayout.js — Keyboard layout indicator with character / flat flag / both.
 *
 * Flags are bundled SVG assets (flags/*.svg): strictly rectangular, no emoji,
 * no wavy / curved “waving flag” glyphs.
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

/**
 * @param {object} source
 * @returns {string}
 */
function sourceShortLabel(source) {
    return source?.shortName || source?.id?.split(':').pop() || '?';
}

/**
 * @param {string} extensionPath
 * @param {string} country
 * @returns {Gio.FileIcon|null}
 */
function flagGIcon(extensionPath, country) {
    const path = flagFilePath(extensionPath, country);
    if (!path)
        return null;
    return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
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
        this.add_style_class_name('bottom-panel-keyboard');

        this._box = new St.BoxLayout({
            style_class: 'bottom-panel-keyboard-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        // Strict 3:2 rectangle that clips the flag icon (no rounded wave look).
        this._flagBin = new St.Bin({
            style_class: 'bottom-panel-kb-flag-rect',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            width: 22,
            height: 15,
        });
        this._flagIcon = new St.Icon({
            style_class: 'bottom-panel-kb-flag-icon',
            icon_size: 22,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._flagBin.set_child(this._flagIcon);

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

    _rebuildMenu() {
        this.menu.removeAll();

        const sources = this._manager.inputSources;
        if (!sources)
            return;

        const ids = Object.keys(sources).sort((a, b) => Number(a) - Number(b));
        for (const id of ids) {
            const source = sources[id];
            const country = sourceToCountry(source);
            const shortName = sourceShortLabel(source);
            const item = new PopupMenu.PopupMenuItem('');

            const row = new St.BoxLayout({style_class: 'bottom-panel-kb-menu-row'});
            const gicon = country ? flagGIcon(this._extensionPath, country) : null;
            if (gicon) {
                const iconBin = new St.Bin({
                    style_class: 'bottom-panel-kb-flag-rect',
                    width: 22,
                    height: 15,
                });
                iconBin.set_child(new St.Icon({
                    gicon,
                    icon_size: 22,
                    style_class: 'bottom-panel-kb-flag-icon',
                }));
                row.add_child(iconBin);
            }
            row.add_child(new St.Label({
                text: shortName,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            // Replace default label content with our row.
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
        const gicon = country ? flagGIcon(this._extensionPath, country) : null;

        const showFlag = (mode === 'flag' || mode === 'both') && !!gicon;
        const showChar = mode === 'character' || mode === 'both' || !gicon;

        this._flagBin.visible = showFlag;
        if (showFlag)
            this._flagIcon.gicon = gicon;
        else
            this._flagIcon.gicon = null;

        this._charLabel.visible = showChar;
        this._charLabel.text = shortName;

        this.visible = !!source &&
            Object.keys(this._manager.inputSources || {}).length > 0;
    }

    _onDestroy() {
        this._manager?.disconnectObject(this);
    }
});
