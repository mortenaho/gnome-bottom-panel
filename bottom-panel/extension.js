/**
 * Extension entry point.
 */

import GLib from 'gi://GLib';

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
        this._dockRestoreTimeout = 0;
    }

    enable() {
        if (this._dockRestoreTimeout) {
            GLib.Source.remove(this._dockRestoreTimeout);
            this._dockRestoreTimeout = 0;
        }

        const settings = this.getSettings();
        initSettings(settings);
        setExtensionPath(this.path);

        // Disable conflicting docks only after a successful start.
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

        try {
            this._panelManager?.disable();
        } catch (e) {
            console.error(`Bottom Panel: disable failed: ${e}`);
        }
        this._panelManager = null;

        // Defer dock restore until after our chrome is back.
        const restorers = this._dockRestorers;
        this._dockRestorers = [];
        if (this._dockRestoreTimeout) {
            GLib.Source.remove(this._dockRestoreTimeout);
            this._dockRestoreTimeout = 0;
        }
        if (restorers.length) {
            this._dockRestoreTimeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 250, () => {
                    this._dockRestoreTimeout = 0;
                    for (const restore of restorers) {
                        try {
                            restore();
                        } catch (e) {
                            console.warn(`Bottom Panel: dock restore failed: ${e}`);
                        }
                    }
                    return GLib.SOURCE_REMOVE;
                });
        }

        clearSettings();
    }
}
