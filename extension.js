/**
 * Extension entry point (GNOME Shell 45+ ESM).
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PanelManager, setExtensionPath} from './panelManager.js';
import {
    initSettings,
    clearSettings,
} from './utils/settings.js';
import {
    disableConflictingExtension,
} from './utils/chrome.js';

const CONFLICTING_DOCKS = [
    'ubuntu-dock@ubuntu.com',
    'dash-to-dock@micxgx.gmail.com',
    'dash-in-panel@fthx',
];

export default class BottomPanelExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._panelManager = null;
        this._dockRestorers = [];
    }

    enable() {
        const settings = this.getSettings();
        initSettings(settings);
        setExtensionPath(this.path);

        // Disable conflicting docks only after the bottom panel starts
        // successfully, so a setup failure does not leave the session without chrome.
        this._dockRestorers = [];

        const start = () => {
            try {
                this._panelManager = new PanelManager();
                this._panelManager.enable();
            } catch (e) {
                console.error(`Bottom Panel: failed to start: ${e}`);
                this._panelManager?.disable();
                this._panelManager = null;
                return;
            }

            for (const uuid of CONFLICTING_DOCKS) {
                const restore = disableConflictingExtension(uuid);
                this._dockRestorers.push(restore);
            }
        };

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                'startup-complete', () => {
                    Main.layoutManager.disconnectObject(this);
                    start();
                },
                this);
        } else {
            start();
        }
    }

    disable() {
        Main.layoutManager.disconnectObject(this);

        this._panelManager?.disable();
        this._panelManager = null;

        for (const restore of this._dockRestorers)
            restore();
        this._dockRestorers = [];

        clearSettings();
    }
}
