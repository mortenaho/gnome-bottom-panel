/**
 * Extension entry point (GNOME Shell 45+ ESM).
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
        this._enableTimeout = 0;
    }

    enable() {
        const settings = this.getSettings();
        initSettings(settings);
        setExtensionPath(this.path);

        // Disable conflicting docks only after the bottom panel starts
        // successfully, so a setup failure does not leave the session without chrome.
        this._dockRestorers = [];

        const start = () => {
            this._enableTimeout = 0;
            try {
                this._panelManager = new PanelManager();
                this._panelManager.enable();
            } catch (e) {
                console.error(`Bottom Panel: failed to start: ${e}`);
                this._panelManager?.disable();
                this._panelManager = null;
                return GLib.SOURCE_REMOVE;
            }

            for (const uuid of CONFLICTING_DOCKS) {
                const restore = disableConflictingExtension(uuid);
                this._dockRestorers.push(restore);
            }
            return GLib.SOURCE_REMOVE;
        };

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                'startup-complete', () => {
                    Main.layoutManager.disconnectObject(this);
                    this._enableTimeout = GLib.idle_add(
                        GLib.PRIORITY_DEFAULT_IDLE, start);
                },
                this);
        } else {
            this._enableTimeout = GLib.idle_add(
                GLib.PRIORITY_DEFAULT_IDLE, start);
        }
    }

    disable() {
        if (this._enableTimeout) {
            GLib.Source.remove(this._enableTimeout);
            this._enableTimeout = 0;
        }

        Main.layoutManager.disconnectObject(this);

        this._panelManager?.disable();
        this._panelManager = null;

        for (const restore of this._dockRestorers)
            restore();
        this._dockRestorers = [];

        clearSettings();
    }
}
