/**
 * systemTray.js — Reparent native GNOME Shell status indicators into the
 * bottom panel instead of reimplementing Quick Settings / clock / battery.
 *
 * Why reparent?
 *   Network, Bluetooth, Volume, Brightness, Power profiles, Battery, Lock /
 *   Log Out / Power Off all live inside Main.panel.statusArea.quickSettings
 *   (and dateMenu for clock + calendar + notification list). Re-creating them
 *   would diverge from Shell internals and break on every GNOME release.
 *
 * Limitation:
 *   Indicators are singletons owned by Main.panel. They can only appear on
 *   one panel at a time — the primary monitor. Secondary panels get a
 *   lightweight clock label instead (see SecondaryClock).
 *
 * Menu direction:
 *   PanelMenu.Button menus default to St.Side.TOP. After moving to a bottom
 *   panel we flip arrow sides so popups open upward.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Role names managed by Main.panel._ensureIndicator / statusArea. */
const SYSTEM_ROLES = [
    'quickSettings',
    'a11y',
    'keyboard',
    'dwellClick',
    'screenRecording',
    'screenSharing',
];

/**
 * Flip a PopupMenu so it opens upward from a bottom panel.
 *
 * @param {object} menu
 */
export function setMenuOpensUpward(menu) {
    if (!menu || menu.isDummy)
        return;

    // Only set the arrow side. Do NOT call _updateFlip() here — BoxPointer
    // may not have allocated _sourceExtents yet and will throw:
    //   TypeError: can't access property "get_top_left", this._sourceExtents is undefined
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
     * @param {{showClock: boolean, clockPosition: string, showSystemIndicators: boolean}} options
     */
    constructor(targetBox, centerBox, options) {
        this._targetBox = targetBox;
        this._centerBox = centerBox;
        this._options = options;
        this._placements = new Map();
        this._menuSides = new Map();
        this._roles = [];
    }

    /**
     * Move indicators from Main.panel into the bottom panel.
     */
    enable() {
        const {statusArea} = Main.panel;
        if (!statusArea)
            return;

        if (this._options.showClock && statusArea.dateMenu)
            this._moveRole('dateMenu', this._clockTarget());

        if (this._options.showSystemIndicators) {
            for (const role of SYSTEM_ROLES) {
                if (statusArea[role])
                    this._moveRole(role, this._targetBox);
            }
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
