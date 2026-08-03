/**
 * chrome.js — Hide/restore the default top panel and overview dash.
 *
 * Strategy:
 *   1. Collapse Main.layoutManager.panelBox so work areas reclaim the top strut.
 *   2. Hide Main.panel without destroying statusArea actors (they are reparented).
 *   3. Optionally hide the overview Dash so the bottom taskbar is the sole launcher.
 *
 * Limitation: Other extensions that assume the top panelBox is visible/tall may
 * misbehave. Ubuntu Dock is auto-disabled from extension.js for the same reason.
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * State captured so disable() can fully restore GNOME Shell chrome.
 */
export class ChromeController {
    constructor() {
        this._panelBoxVisible = true;
        this._panelHeight = -1;
        this._panelBoxOpacity = 255;
        this._overviewDashHidden = false;
        this._overviewDashHeight = -1;
        this._hotCornersBlocked = false;
        this._allocationId = 0;
        this._active = false;
    }

    /**
     * Hide the top panel chrome and reclaim its work-area strut.
     */
    hideTopPanel() {
        if (this._active)
            return;

        const {panelBox} = Main.layoutManager;
        const {panel} = Main;

        this._panelBoxVisible = panelBox.visible;
        this._panelBoxOpacity = panelBox.opacity;
        this._panelHeight = panel.height;

        // Collapse strut first so maximized windows expand immediately.
        panel.height = 0;
        panelBox.height = 0;
        panelBox.opacity = 0;
        panel.hide();
        panelBox.hide();

        // Keep panelBox collapsed if layoutManager tries to restore it.
        if (!this._allocationId) {
            this._allocationId = panelBox.connect('notify::height', () => {
                if (this._active && panelBox.height !== 0)
                    panelBox.height = 0;
            });
        }

        this._active = true;
        Main.layoutManager._queueUpdateRegions?.();
        global.display.emit('workareas-changed');
    }

    /**
     * Restore the original top panel chrome.
     */
    restoreTopPanel() {
        if (!this._active)
            return;

        const {panelBox} = Main.layoutManager;
        const {panel} = Main;

        if (this._allocationId) {
            panelBox.disconnect(this._allocationId);
            this._allocationId = 0;
        }

        panel.height = this._panelHeight > 0 ? this._panelHeight : -1;
        panelBox.height = -1;
        panelBox.opacity = this._panelBoxOpacity;

        if (this._panelBoxVisible)
            panelBox.show();
        panel.show();

        this._active = false;
        Main.layoutManager._queueUpdateRegions?.();
        global.display.emit('workareas-changed');
    }

    /**
     * Hide the overview dash (favorites strip inside Activities).
     */
    hideOverviewDash() {
        const dash = Main.overview.dash;
        if (!dash || this._overviewDashHidden)
            return;

        this._overviewDashHeight = dash.height;
        dash.hide();
        dash.height = 0;
        this._overviewDashHidden = true;
    }

    /**
     * Restore the overview dash.
     */
    restoreOverviewDash() {
        if (!this._overviewDashHidden)
            return;

        const dash = Main.overview.dash;
        if (dash) {
            dash.show();
            dash.height = this._overviewDashHeight >= 0
                ? this._overviewDashHeight
                : -1;
            dash.setMaxSize?.(-1, -1);
        }

        this._overviewDashHidden = false;
        this._overviewDashHeight = -1;
    }

    /**
     * Tear down all chrome modifications.
     */
    destroy() {
        this.restoreOverviewDash();
        this.restoreTopPanel();
    }
}

/**
 * Returns true when an extension UUID is currently enabled.
 *
 * @param {string} uuid
 * @returns {boolean}
 */
export function isExtensionEnabled(uuid) {
    const enabled = global.settings.get_strv('enabled-extensions');
    if (enabled.includes(uuid))
        return true;

    // Fallback for session modes that only expose the manager order list.
    const order = Main.extensionManager?._extensionOrder;
    return Array.isArray(order) && order.includes(uuid);
}

/**
 * Disable a conflicting extension by UUID via the Shell's disabled-extensions
 * list. Returns a restore function that removes the UUID from that list when
 * we were the ones who disabled it.
 *
 * @param {string} uuid
 * @returns {() => void}
 */
export function disableConflictingExtension(uuid) {
    if (!isExtensionEnabled(uuid))
        return () => {};

    const disabled = global.settings.get_strv('disabled-extensions');
    if (disabled.includes(uuid))
        return () => {};

    disabled.push(uuid);
    global.settings.set_strv('disabled-extensions', disabled);

    return () => {
        const current = global.settings.get_strv('disabled-extensions');
        const next = current.filter(u => u !== uuid);
        if (next.length !== current.length)
            global.settings.set_strv('disabled-extensions', next);
    };
}

/**
 * Yield to the main loop so a just-disabled extension can finish teardown.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}
