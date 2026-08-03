/**
 * Hide/restore the default top panel and overview dash.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ChromeController {
    constructor() {
        this._panelBoxVisible = true;
        this._panelHeight = -1;
        this._panelBoxOpacity = 255;
        this._overviewDashHidden = false;
        this._overviewDashHeight = -1;
        this._allocationId = 0;
        this._active = false;
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

    hideOverviewDash() {
        const dash = Main.overview.dash;
        if (!dash || this._overviewDashHidden)
            return;

        this._overviewDashHeight = dash.height;
        dash.hide();
        dash.height = 0;
        this._overviewDashHidden = true;
    }

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
