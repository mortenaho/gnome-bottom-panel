/**
 * Reparent AppIndicator / legacy tray icons into the bottom panel.
 * Windows 11-style chevron flyout for overflow icons.
 *
 * Critical: the flyout must stay mapped while an icon menu is open.
 * Hiding it unmaps the indicator and immediately kills its menu.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setMenuOpensUpward} from './systemTray.js';

const RESERVED_ROLES = new Set([
    'activities',
    'dateMenu',
    'quickSettings',
    'a11y',
    'keyboard',
    'dwellClick',
    'screenRecording',
    'screenSharing',
]);

/** SNI labels that are not real icons (Ubuntu update notifier, etc.). */
const ELLIPSIS_LABELS = new Set(['...', '…', '⋯', '‥']);

/**
 * @param {string} role
 * @param {object} [indicator]
 * @returns {boolean}
 */
function isAppTrayRole(role, indicator) {
    if (!role || RESERVED_ROLES.has(role))
        return false;
    if (role.startsWith('appindicator-') ||
        role.startsWith('ubuntu-appindicators') ||
        role.includes('appindicator'))
        return true;

    try {
        if (indicator?.has_style_class_name?.('appindicator-icon') ||
            indicator?.has_style_class_name?.('appindicator-box'))
            return true;
        if ((indicator?.style_class ?? '').includes('appindicator'))
            return true;
    } catch (_e) {
        // disposed
    }
    return false;
}

/**
 * Hide SNI text labels permanently (they reappear on 'label' signals).
 *
 * @param {Clutter.Actor} actor
 */
function suppressTrayLabels(actor) {
    const walk = node => {
        if (!node)
            return;
        try {
            if (node instanceof St.Label) {
                node.visible = false;
                node.hide();
                // Collapse so "..." does not reserve space.
                node.set_width(0);
                node.set_height(0);
            }
            for (const child of node.get_children?.() ?? [])
                walk(child);
        } catch (_e) {
            // disposed
        }
    };
    walk(actor);
}

/**
 * True when the indicator only shows an ellipsis label (no useful icon).
 *
 * @param {object} indicator
 * @returns {boolean}
 */
function isEllipsisOnly(indicator) {
    try {
        const sni = indicator?._indicator;
        const label = (sni?.label ?? '').trim();
        if (!ELLIPSIS_LABELS.has(label))
            return false;

        // Has a real icon actor with content? keep it, just suppress label.
        const icon = indicator?.icon ?? indicator?._icon;
        if (icon && icon.width > 1 && icon.height > 1)
            return false;

        // Label-only ellipsis noise (common for apt update SNI).
        return true;
    } catch (_e) {
        return false;
    }
}

export const AppIndicatorTray = GObject.registerClass(
class AppIndicatorTray extends St.BoxLayout {
    /**
     * @param {{
     *   iconSize?: number,
     *   maxVisible?: number,
     * }} params
     */
    _init(params = {}) {
        super._init({
            style_class: 'bottom-panel-app-tray',
            reactive: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._iconSize = params.iconSize ?? 16;
        this._maxVisible = Math.max(0, params.maxVisible ?? 0);
        this._icons = new Map();
        this._menuSides = new Map();
        this._menuOpenIds = new Map();
        this._labelSignalIds = new Map();
        this._pollId = 0;
        this._refreshIdle = 0;
        this._origAddToStatusArea = null;
        this._flyoutOpen = false;
        this._stageClickId = 0;

        this._visibleBox = new St.BoxLayout({
            style_class: 'bottom-panel-app-tray-visible',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._visibleBox);

        this._overflowButton = new St.Button({
            style_class: 'bottom-panel-app-tray-overflow panel-button',
            reactive: true,
            can_focus: true,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            track_hover: true,
        });
        this._overflowIcon = new St.Icon({
            icon_name: 'pan-up-symbolic',
            style_class: 'popup-menu-arrow',
            icon_size: this._iconSize,
        });
        this._overflowButton.set_child(this._overflowIcon);
        this.add_child(this._overflowButton);

        this._flyout = new St.BoxLayout({
            style_class: 'bottom-panel-app-tray-flyout',
            vertical: false,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._overflowBox = new St.BoxLayout({
            style_class: 'bottom-panel-app-tray-overflow-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._flyout.add_child(this._overflowBox);
        Main.layoutManager.uiGroup.add_child(this._flyout);

        this._overflowButton.connect('clicked', () => {
            if (this._flyoutOpen)
                this._closeFlyout();
            else
                this._openFlyout();
        });

        this._hookPanelAdditions();
        this._syncFromStatusArea();

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._syncFromStatusArea();
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * @param {number} size
     */
    setIconSize(size) {
        this._iconSize = size;
        if (this._overflowIcon)
            this._overflowIcon.icon_size = size;
        this._queueRefresh();
    }

    /**
     * @param {number} max
     */
    setMaxVisible(max) {
        this._maxVisible = Math.max(0, max);
        this._queueRefresh();
    }

    _openFlyout() {
        if (this._flyoutOpen)
            return;

        this._relayoutIcons();
        if (this._overflowBox.get_n_children() === 0)
            return;

        this._flyoutOpen = true;
        this._flyout.show();
        this._raiseFlyout();
        this._positionFlyout();
        this._overflowIcon.icon_name = 'pan-down-symbolic';
        this._overflowButton.add_style_pseudo_class('active');

        // Skip the opening click so it is not treated as an outside dismiss.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._flyoutOpen)
                this._connectDismissHandlers();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {{force?: boolean}} [opts]
     */
    _closeFlyout(opts = {}) {
        if (!this._flyoutOpen)
            return;

        // Never unmap while an icon menu is open — that kills the menu.
        if (!opts.force && this._anyIndicatorMenuOpen())
            return;

        this._flyoutOpen = false;
        this._disconnectDismissHandlers();
        this._flyout.hide();
        this._overflowIcon.icon_name = 'pan-up-symbolic';
        this._overflowButton.remove_style_pseudo_class('active');
    }

    /**
     * @returns {boolean}
     */
    _anyIndicatorMenuOpen() {
        for (const {indicator} of this._icons.values()) {
            try {
                if (indicator?.menu && !indicator.menu.isDummy &&
                    indicator.menu.isOpen)
                    return true;
            } catch (_e) {
                // ignore
            }
        }
        return false;
    }

    _positionFlyout() {
        const button = this._overflowButton;
        const [, natW] = this._flyout.get_preferred_width(-1);
        const [, natH] = this._flyout.get_preferred_height(-1);
        const w = Math.max(1, Math.ceil(natW));
        const h = Math.max(1, Math.ceil(natH));
        this._flyout.set_size(w, h);

        const [bx, by] = button.get_transformed_position();
        const [bw, bh] = button.get_transformed_size();
        const gap = 6;
        let x = Math.round(bx + bw / 2 - w / 2);
        let y = Math.round(by - h - gap);

        const monitor = Main.layoutManager.findMonitorForActor(button) ??
            Main.layoutManager.primaryMonitor;
        if (monitor) {
            const pad = 8;
            x = Math.max(monitor.x + pad,
                Math.min(x, monitor.x + monitor.width - w - pad));
            if (y < monitor.y + pad)
                y = Math.round(by + bh + gap);
        }

        this._flyout.set_position(x, y);
    }

    /**
     * Raise the flyout above siblings (Clutter no longer has raise_top).
     */
    _raiseFlyout() {
        const parent = this._flyout?.get_parent?.();
        if (parent && this._flyout)
            parent.set_child_above_sibling(this._flyout, null);
    }

    _connectDismissHandlers() {
        if (this._stageClickId)
            return;
        this._stageClickId = global.stage.connect(
            'captured-event',
            (_stage, event) => this._onStageEvent(event));
    }

    _disconnectDismissHandlers() {
        if (this._stageClickId) {
            global.stage.disconnect(this._stageClickId);
            this._stageClickId = 0;
        }
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onStageEvent(event) {
        if (!this._flyoutOpen)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                if (!this._anyIndicatorMenuOpen())
                    this._closeFlyout();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        const source = event.get_source();
        if (!source)
            return Clutter.EVENT_PROPAGATE;

        // Keep flyout open for clicks on icons / flyout chrome.
        if (this._flyout.contains(source))
            return Clutter.EVENT_PROPAGATE;

        if (this._overflowButton.contains(source))
            return Clutter.EVENT_PROPAGATE;

        // Clicks inside an open indicator menu — leave flyout mapped.
        if (this._isInIndicatorMenu(source))
            return Clutter.EVENT_PROPAGATE;

        // Outside: close only if no icon menu is using the flyout as anchor.
        if (!this._anyIndicatorMenuOpen())
            this._closeFlyout();

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {Clutter.Actor} actor
     * @returns {boolean}
     */
    _isInIndicatorMenu(actor) {
        for (const {indicator} of this._icons.values()) {
            const menu = indicator?.menu;
            if (!menu || menu.isDummy)
                continue;
            try {
                const bp = menu._boxPointer;
                if (menu.actor?.contains?.(actor) ||
                    menu.box?.contains?.(actor) ||
                    bp?.bin?.contains?.(actor) ||
                    bp?.contains?.(actor) ||
                    bp?.actor?.contains?.(actor))
                    return true;
            } catch (_e) {
                // ignore
            }
        }
        return false;
    }

    _hookPanelAdditions() {
        const panel = Main.panel;
        if (!panel?.addToStatusArea || this._origAddToStatusArea)
            return;

        this._origAddToStatusArea = panel.addToStatusArea.bind(panel);
        const tray = this;
        panel.addToStatusArea = function (...args) {
            const result = tray._origAddToStatusArea(...args);
            const [role] = args;
            if (isAppTrayRole(role, result))
                tray._queueRefresh();
            return result;
        };
    }

    _unhookPanelAdditions() {
        if (this._origAddToStatusArea && Main.panel) {
            Main.panel.addToStatusArea = this._origAddToStatusArea;
            this._origAddToStatusArea = null;
        }
    }

    _queueRefresh() {
        if (this._refreshIdle)
            return;
        this._refreshIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshIdle = 0;
            this._syncFromStatusArea();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncFromStatusArea() {
        const {statusArea} = Main.panel;
        if (!statusArea)
            return;

        const seen = new Set();
        for (const role of Object.keys(statusArea)) {
            const indicator = statusArea[role];
            if (!isAppTrayRole(role, indicator))
                continue;
            if (!indicator?.container)
                continue;
            if (isEllipsisOnly(indicator))
                continue;

            seen.add(role);
            if (!this._icons.has(role))
                this._adopt(role, indicator);
            else
                this._refreshIndicatorChrome(role);
        }

        for (const role of [...this._icons.keys()]) {
            if (!seen.has(role) || !Main.panel.statusArea?.[role])
                this._release(role);
        }

        this._relayoutIcons();
        if (this._flyoutOpen)
            this._positionFlyout();
    }

    /**
     * @param {string} role
     */
    _refreshIndicatorChrome(role) {
        const entry = this._icons.get(role);
        if (!entry)
            return;
        suppressTrayLabels(entry.container);
        this._applySize(entry.container);
    }

    /**
     * @param {string} role
     * @param {object} indicator
     */
    _adopt(role, indicator) {
        const {container} = indicator;
        if (!container || this._icons.has(role))
            return;

        const parent = container.get_parent();
        const placement = parent
            ? {parent, index: parent.get_children().indexOf(container)}
            : null;

        if (indicator.menu && !indicator.menu.isDummy) {
            this._menuSides.set(role, indicator.menu._arrowSide);
            setMenuOpensUpward(indicator.menu);

            // Never close the flyout when a menu opens — hiding unmaps the
            // indicator and kills its menu. Stay open until outside click.
            const id = indicator.menu.connect('open-state-changed',
                (_menu, open) => {
                    if (open)
                        this._raiseFlyout();
                });
            this._menuOpenIds.set(role, id);
        }

        // Re-suppress labels whenever SNI updates them.
        const sni = indicator._indicator;
        if (sni?.connect) {
            try {
                const lid = sni.connect('label', () => {
                    suppressTrayLabels(container);
                });
                this._labelSignalIds.set(role, {obj: sni, id: lid});
            } catch (_e) {
                // ignore
            }
        }

        if (parent)
            parent.remove_child(container);

        this._icons.set(role, {indicator, container, placement});
        try {
            container.show();
            indicator.show?.();
            suppressTrayLabels(container);
            this._applySize(container);
        } catch (_e) {
            // disposed
        }
    }

    /**
     * @param {string} role
     */
    _release(role) {
        const entry = this._icons.get(role);
        if (!entry)
            return;

        const {indicator, container, placement} = entry;

        const openId = this._menuOpenIds.get(role);
        if (openId !== undefined && indicator?.menu) {
            try {
                indicator.menu.disconnect(openId);
            } catch (_e) {
                // ignore
            }
            this._menuOpenIds.delete(role);
        }

        const labelHook = this._labelSignalIds.get(role);
        if (labelHook) {
            try {
                labelHook.obj.disconnect(labelHook.id);
            } catch (_e) {
                // ignore
            }
            this._labelSignalIds.delete(role);
        }

        try {
            if (container && !container.is_finalized?.()) {
                const currentParent = container.get_parent();
                if (currentParent)
                    currentParent.remove_child(container);

                if (placement?.parent && !placement.parent.is_finalized?.()) {
                    const children = placement.parent.get_children();
                    const insertAt = Math.min(
                        Math.max(placement.index, 0), children.length);
                    placement.parent.insert_child_at_index(container, insertAt);
                }
            }
        } catch (_e) {
            // already disposed during extension reload
        }

        if (indicator?.menu && this._menuSides.has(role)) {
            try {
                indicator.menu._arrowSide = this._menuSides.get(role);
            } catch (_e) {
                // ignore
            }
            this._menuSides.delete(role);
        }

        this._icons.delete(role);
    }

    _relayoutIcons() {
        for (const child of [...this._visibleBox.get_children()])
            this._visibleBox.remove_child(child);
        for (const child of [...this._overflowBox.get_children()])
            this._overflowBox.remove_child(child);

        const roles = [...this._icons.keys()].sort();
        const ordered = roles
            .map(r => this._icons.get(r))
            .filter(e => e?.container);

        const visible = ordered.slice(0, this._maxVisible);
        const hidden = ordered.slice(this._maxVisible);

        for (const entry of visible) {
            const {container} = entry;
            const parent = container.get_parent();
            if (parent)
                parent.remove_child(container);
            this._visibleBox.add_child(container);
            this._applySize(container);
            suppressTrayLabels(container);
        }

        for (const entry of hidden) {
            const {container} = entry;
            const parent = container.get_parent();
            if (parent)
                parent.remove_child(container);
            this._overflowBox.add_child(container);
            this._applySize(container);
            suppressTrayLabels(container);
        }

        const showChevron = hidden.length > 0;
        this._overflowButton.visible = showChevron;
        if (!showChevron && this._flyoutOpen && !this._anyIndicatorMenuOpen())
            this._closeFlyout();
    }

    /**
     * @param {Clutter.Actor} actor
     */
    _applySize(actor) {
        const size = this._iconSize;
        const walk = node => {
            if (!node)
                return;
            try {
                if (node instanceof St.Icon)
                    node.icon_size = size;
                for (const child of node.get_children?.() ?? [])
                    walk(child);
            } catch (_e) {
                // disposed
            }
        };
        walk(actor);
    }

    _onDestroy() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        if (this._refreshIdle) {
            GLib.Source.remove(this._refreshIdle);
            this._refreshIdle = 0;
        }

        this._closeFlyout({force: true});
        this._unhookPanelAdditions();

        for (const role of [...this._icons.keys()])
            this._release(role);

        this._flyout?.destroy();
        this._flyout = null;
        this._overflowIcon = null;
    }
});
