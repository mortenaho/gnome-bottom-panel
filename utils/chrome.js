/**
 * Hide/restore the default top panel and overview dash.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Tiny height so overview layout stops reserving dock space. */
const HIDDEN_DASH_HEIGHT = 1;

export class ChromeController {
    constructor() {
        this._panelBoxVisible = true;
        this._panelHeight = -1;
        this._panelBoxOpacity = 255;
        this._overviewDashHidden = false;
        this._overviewDashHeight = -1;
        this._allocationId = 0;
        this._active = false;
        this._overviewShowingId = 0;
        this._overviewShownId = 0;
        this._dashVisibleId = 0;
        this._hidingDash = false;
    }

    hideTopPanel() {
        if (this._active)
            return;

        const {panelBox} = Main.layoutManager;
        const {panel} = Main;

        this._panelBoxVisible = panelBox.visible;
        this._panelBoxOpacity = panelBox.opacity;
        this._panelHeight = panel.height;

        panel.height = 0;
        panelBox.height = 0;
        panelBox.opacity = 0;
        panel.hide();
        panelBox.hide();

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
     * Hide the stock Activities overview dash (GNOME 50 re-shows it on
     * overview transitions unless we keep re-applying).
     */
    hideOverviewDash() {
        const dash = this._getOverviewDash();
        if (!dash)
            return;

        if (!this._overviewDashHidden) {
            this._overviewDashHeight = dash.height > 0 ? dash.height : -1;
            this._connectDashHooks(dash);
        }

        this._overviewDashHidden = true;
        this._applyDashHidden();
    }

    restoreOverviewDash() {
        if (!this._overviewDashHidden)
            return;

        this._disconnectDashHooks();
        this._overviewDashHidden = false;

        const dash = this._getOverviewDash();
        if (dash) {
            this._hidingDash = true;
            try {
                dash.opacity = 255;
                dash.reactive = true;
                dash.set_height(this._overviewDashHeight >= 0
                    ? this._overviewDashHeight
                    : -1);
                dash.show();
                dash.setMaxSize?.(-1, -1);
            } finally {
                this._hidingDash = false;
            }
        }

        this._overviewDashHeight = -1;
    }

    /**
     * @returns {import('gi://St').St.Widget|null}
     */
    _getOverviewDash() {
        return Main.overview?.dash ??
            Main.overview?._overview?.controls?.dash ??
            Main.overview?._overview?._controls?.dash ??
            null;
    }

    /**
     * @param {object} dash
     */
    _connectDashHooks(dash) {
        if (!this._overviewShowingId) {
            this._overviewShowingId = Main.overview.connect(
                'showing', () => this._applyDashHidden());
        }
        if (!this._overviewShownId) {
            this._overviewShownId = Main.overview.connect(
                'shown', () => this._applyDashHidden());
        }
        if (!this._dashVisibleId && dash) {
            this._dashVisibleId = dash.connect('notify::visible', () => {
                if (this._overviewDashHidden && !this._hidingDash && dash.visible)
                    this._applyDashHidden();
            });
        }
    }

    _disconnectDashHooks() {
        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewShownId) {
            Main.overview.disconnect(this._overviewShownId);
            this._overviewShownId = 0;
        }
        if (this._dashVisibleId) {
            const dash = this._getOverviewDash();
            try {
                dash?.disconnect?.(this._dashVisibleId);
            } catch (_e) {
                // disposed
            }
            this._dashVisibleId = 0;
        }
    }

    _applyDashHidden() {
        if (!this._overviewDashHidden)
            return;

        const dash = this._getOverviewDash();
        if (!dash)
            return;

        this._hidingDash = true;
        try {
            dash.hide();
            dash.set_height(HIDDEN_DASH_HEIGHT);
            dash.opacity = 0;
            dash.reactive = false;
            // Cancel any overview "slide up from bottom" animation residue.
            dash.translation_y = 0;
            dash.remove_all_transitions?.();
        } finally {
            this._hidingDash = false;
        }
    }

    destroy() {
        this.restoreOverviewDash();
        this.restoreTopPanel();
    }
}

/**
 * @param {string} uuid
 * @returns {boolean}
 */
export function isExtensionEnabled(uuid) {
    const enabled = global.settings.get_strv('enabled-extensions');
    if (enabled.includes(uuid))
        return true;

    const order = Main.extensionManager?._extensionOrder;
    return Array.isArray(order) && order.includes(uuid);
}

/**
 * Disable a conflicting extension via disabled-extensions.
 * Returns a restore callback if this function added the UUID.
 *
 * @param {string} uuid
 * @returns {() => void}
 */
export function disableConflictingExtension(uuid) {
    const enabled = global.settings.get_strv('enabled-extensions');
    const disabled = global.settings.get_strv('disabled-extensions');
    const wasEnabled = enabled.includes(uuid) || isExtensionEnabled(uuid);
    let addedToDisabled = false;

    if (!disabled.includes(uuid)) {
        disabled.push(uuid);
        global.settings.set_strv('disabled-extensions', disabled);
        addedToDisabled = true;
    }

    // Drop from enabled-extensions even if already marked disabled — Ubuntu
    // sometimes keeps system docks in both lists.
    if (enabled.includes(uuid)) {
        global.settings.set_strv(
            'enabled-extensions',
            enabled.filter(u => u !== uuid));
    }

    try {
        Main.extensionManager?.disableExtension?.(uuid);
    } catch (_e) {
        // ignore
    }

    if (!wasEnabled && !addedToDisabled)
        return () => {};

    return () => {
        if (!addedToDisabled)
            return;
        const current = global.settings.get_strv('disabled-extensions');
        const next = current.filter(u => u !== uuid);
        if (next.length !== current.length)
            global.settings.set_strv('disabled-extensions', next);
    };
}
