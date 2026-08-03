/**
 * Reparent native status indicators (Quick Settings, dateMenu, …) into the
 * bottom panel. Indicators are Shell singletons, so they only appear on the
 * primary monitor; secondary panels use SecondaryClock.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Role names managed by Main.panel._ensureIndicator / statusArea. */
const SYSTEM_ROLES = [
    'quickSettings',
    // 'a11y' / 'dwellClick' — leave on stock top panel (hidden)
    // 'keyboard' — replaced by indicators/keyboardLayout.js
    // screenRecording / screenSharing stay on the stock top panel (hidden)
];

/** Default right-side item order (prefs: panel-item-order). */
export const DEFAULT_PANEL_ITEM_ORDER = ['tray', 'keyboard', 'system', 'clock'];

/**
 * Normalize a panel-item-order strv: known ids only, unique, with defaults filled.
 *
 * @param {string[]} order
 * @returns {string[]}
 */
export function normalizePanelItemOrder(order) {
    const known = new Set(DEFAULT_PANEL_ITEM_ORDER);
    const seen = new Set();
    const result = [];
    for (const id of order ?? []) {
        if (!known.has(id) || seen.has(id))
            continue;
        seen.add(id);
        result.push(id);
    }
    for (const id of DEFAULT_PANEL_ITEM_ORDER) {
        if (!seen.has(id))
            result.push(id);
    }
    return result;
}

/**
 * Recursively set St.Icon.icon_size under an actor (native tray icons).
 *
 * @param {Clutter.Actor} actor
 * @param {number} size
 */
function applyIconSizeRecursive(actor, size) {
    if (!actor)
        return;
    if (actor instanceof St.Icon)
        actor.icon_size = size;
    for (const child of actor.get_children?.() ?? [])
        applyIconSizeRecursive(child, size);
}

/**
 * Flip a PopupMenu so it opens upward from a bottom panel.
 *
 * @param {object} menu
 */
export function setMenuOpensUpward(menu) {
    if (!menu || menu.isDummy)
        return;

    // Avoid _updateFlip() before BoxPointer has allocated extents.
    try {
        menu._arrowSide = St.Side.BOTTOM;
        if (menu._boxPointer)
            menu._boxPointer._arrowSide = St.Side.BOTTOM;
    } catch (e) {
        console.warn(`Bottom Panel: could not set menu arrow side: ${e}`);
    }
}

/**
 * Capture where a statusArea actor currently lives so we can restore it.
 *
 * @param {Clutter.Actor} container
 * @returns {{parent: Clutter.Actor, index: number}|null}
 */
function capturePlacement(container) {
    const parent = container.get_parent();
    if (!parent)
        return null;
    return {
        parent,
        index: parent.get_children().indexOf(container),
    };
}

/**
 * Manages reparenting of shell status indicators for the primary bottom panel.
 */
export class SystemTrayManager {
    /**
     * @param {St.BoxLayout} targetBox — right-side box of the bottom panel
     * @param {St.BoxLayout} centerBox — center box (for clock when centered)
     * @param {{
     *   showClock: boolean,
     *   clockPosition: string,
     *   clockStyle?: string,
     *   showSystemIndicators: boolean,
     *   showKeyboardLayout?: boolean,
     *   trayIconSize?: number,
     * }} options
     */
    constructor(targetBox, centerBox, options) {
        this._targetBox = targetBox;
        this._centerBox = centerBox;
        this._options = options;
        this._placements = new Map();
        this._menuSides = new Map();
        this._roles = [];
        this._trayIconSize = options.trayIconSize ?? 16;
    }

    /**
     * Hide stock keyboard when a custom indicator is used.
     */
    prepareKeyboard() {
        const {statusArea} = Main.panel;
        if (!statusArea)
            return;

        if (this._options.showKeyboardLayout && statusArea.keyboard) {
            this._keyboardWasVisible = statusArea.keyboard.visible;
            statusArea.keyboard.visible = false;
        }
    }

    /**
     * Move the native dateMenu into `box` (default style only).
     * Seven-segment clocks only need the menu to open upward.
     *
     * @param {St.BoxLayout} box
     */
    placeClock(box) {
        const {statusArea} = Main.panel;
        if (!statusArea || !this._options.showClock)
            return;

        if (this._options.clockStyle === 'seven-segment') {
            if (statusArea.dateMenu?.menu)
                setMenuOpensUpward(statusArea.dateMenu.menu);
            return;
        }

        if (statusArea.dateMenu)
            this._moveRole('dateMenu', box);
    }

    /**
     * Move Quick Settings into `box`.
     *
     * @param {St.BoxLayout} box
     */
    placeSystemIndicators(box) {
        const {statusArea} = Main.panel;
        if (!statusArea || !this._options.showSystemIndicators)
            return;

        const roles = [...SYSTEM_ROLES];
        if (this._options.showKeyboardLayout === false && statusArea.keyboard)
            roles.push('keyboard');

        for (const role of roles) {
            if (statusArea[role])
                this._moveRole(role, box);
        }

        this.applyTrayIconSize(this._trayIconSize);
    }

    /**
     * Legacy one-shot enable (clock + system) for callers that do not order.
     */
    enable() {
        this.prepareKeyboard();
        this.placeClock(this._clockTarget());
        this.placeSystemIndicators(this._targetBox);
    }

    /**
     * Scale native tray icons (Quick Settings, …).
     *
     * @param {number} size
     */
    applyTrayIconSize(size) {
        this._trayIconSize = size;
        for (const role of this._roles) {
            if (role === 'dateMenu')
                continue;
            const indicator = Main.panel.statusArea?.[role];
            if (indicator?.container)
                applyIconSizeRecursive(indicator.container, size);
        }
    }

    /**
     * @returns {St.BoxLayout}
     */
    _clockTarget() {
        return this._options.clockPosition === 'center'
            ? this._centerBox
            : this._targetBox;
    }

    /**
     * @param {string} role
     * @param {St.BoxLayout} box
     */
    _moveRole(role, box) {
        const indicator = Main.panel.statusArea[role];
        if (!indicator?.container)
            return;

        const {container} = indicator;
        if (this._placements.has(role))
            return;

        this._placements.set(role, capturePlacement(container));
        this._roles.push(role);

        if (indicator.menu && !indicator.menu.isDummy) {
            this._menuSides.set(role, indicator.menu._arrowSide);
            setMenuOpensUpward(indicator.menu);
        }

        const parent = container.get_parent();
        if (parent)
            parent.remove_child(container);

        box.add_child(container);
        container.show();
        indicator.show?.();

        if (role !== 'dateMenu' && this._trayIconSize)
            applyIconSizeRecursive(container, this._trayIconSize);
    }

    /**
     * Put every reparented indicator back where Main.panel expects it.
     */
    disable() {
        for (const role of this._roles) {
            const indicator = Main.panel.statusArea[role];
            const placement = this._placements.get(role);
            if (!indicator?.container || !placement)
                continue;

            const {container} = indicator;
            const currentParent = container.get_parent();
            if (currentParent)
                currentParent.remove_child(container);

            const {parent, index} = placement;
            if (parent) {
                const children = parent.get_children();
                const insertAt = Math.min(Math.max(index, 0), children.length);
                parent.insert_child_at_index(container, insertAt);
            }

            const originalSide = this._menuSides.get(role);
            if (indicator.menu && !indicator.menu.isDummy && originalSide !== undefined) {
                indicator.menu._arrowSide = originalSide;
                if (indicator.menu._boxPointer)
                    indicator.menu._boxPointer._arrowSide = originalSide;
            }
        }

        this._placements.clear();
        this._menuSides.clear();
        this._roles = [];

        // Restore stock keyboard visibility.
        const kb = Main.panel.statusArea?.keyboard;
        if (kb && this._keyboardWasVisible !== undefined)
            kb.visible = this._keyboardWasVisible;

        try {
            Main.panel._updatePanel?.();
        } catch (e) {
            console.warn(`Bottom Panel: panel update after restore failed: ${e}`);
        }
    }

    destroy() {
        this.disable();
        this._targetBox = null;
        this._centerBox = null;
    }
}

/**
 * Lightweight clock for secondary monitors (dateMenu is a singleton and
 * already lives on the primary panel). Clicking opens the primary calendar.
 */
export const SecondaryClock = GObject.registerClass(
class SecondaryClock extends St.Button {
    _init() {
        super._init({
            style_class: 'bottom-panel-clock',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'bottom-panel-clock-label',
        });
        this.set_child(this._label);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject(
            'notify::clock', () => this._syncLabel(),
            this);
        this._syncLabel();

        this.connect('clicked', () => {
            const dateMenu = Main.panel.statusArea.dateMenu;
            if (dateMenu?.menu)
                dateMenu.menu.toggle();
        });

        this.connect('destroy', () => this._onDestroy());
    }

    _syncLabel() {
        this._label.text = this._wallClock.clock;
    }

    _onDestroy() {
        this._wallClock?.disconnectObject(this);
        this._wallClock = null;
    }
});
