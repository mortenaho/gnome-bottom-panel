/**
 * panelManager.js — Creates, updates, and destroys BottomPanel instances for
 * each monitor. Owns the ChromeController that hides the stock top panel.
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BottomPanel} from './panel.js';
import {ChromeController} from './utils/chrome.js';
import {getPanelOptions, onSettingsChanged} from './utils/settings.js';

/** @type {string} */
let _extensionPath = '';

/**
 * Called from Extension.enable() so indicators can load bundled assets.
 *
 * @param {string} path
 */
export function setExtensionPath(path) {
    _extensionPath = path ?? '';
}

export class PanelManager {
    constructor() {
        this._panels = new Map();
        this._chrome = new ChromeController();
        this._monitorsChangedId = 0;
        this._settingsDisposer = null;
        this._enabled = false;
        this._rebuildTimeout = 0;
    }

    enable() {
        if (this._enabled)
            return;

        try {
            this._chrome.hideTopPanel();

            const options = getPanelOptions();
            if (options.hideOverviewDash)
                this._chrome.hideOverviewDash();

            this._createPanels();

            this._monitorsChangedId = Main.layoutManager.connect(
                'monitors-changed', () => this._scheduleRebuild());

            this._settingsDisposer = onSettingsChanged([
                'panel-height',
                'icon-size',
                'tray-icon-size',
                'panel-item-order',
                'panel-spacing',
                'panel-margin',
                'border-radius',
                'panel-opacity',
                'use-custom-panel-color',
                'panel-color',
                'enable-blur',
                'show-favorites',
                'show-running-apps',
                'show-show-apps-button',
                'show-workspaces',
                'show-clock',
                'clock-position',
                'clock-style',
                'clock-format',
                'clock-colon-blink',
                'clock-led-color',
                'clock-segment-thickness',
                'clock-hour-format',
                'show-system-indicators',
                'multi-monitor',
                'isolate-monitors',
                'isolate-workspaces',
                'hide-overview-dash',
                'animate-startup',
                'scroll-panel-workspaces',
                'show-keyboard-layout',
                'keyboard-display-mode',
            ], () => this._onSettingsChanged());

            this._enabled = true;
        } catch (e) {
            // If setup fails after hiding the top panel, restore chrome so the
            // user is not left without a panel/dock.
            console.error(`Bottom Panel: enable failed, restoring chrome: ${e}`);
            this.disable();
            throw e;
        }
    }

    disable() {
        // Always attempt restore, even if enable() failed halfway.
        if (this._rebuildTimeout) {
            GLib.Source.remove(this._rebuildTimeout);
            this._rebuildTimeout = 0;
        }

        this._settingsDisposer?.();
        this._settingsDisposer = null;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._destroyPanels();
        this._chrome.destroy();
        this._enabled = false;
    }

    _createPanels() {
        const options = {
            ...getPanelOptions(),
            extensionPath: _extensionPath,
        };
        const monitors = Main.layoutManager.monitors;
        const primaryIndex = Main.layoutManager.primaryIndex;

        const indices = options.multiMonitor
            ? monitors.map((_, i) => i)
            : [primaryIndex];

        for (const index of indices) {
            if (this._panels.has(index))
                continue;

            const panel = new BottomPanel({
                monitorIndex: index,
                isPrimary: index === primaryIndex,
                options,
            });
            this._panels.set(index, panel);
        }
    }

    _destroyPanels() {
        for (const panel of this._panels.values())
            panel.destroy();
        this._panels.clear();
    }

    _scheduleRebuild() {
        if (this._rebuildTimeout)
            GLib.Source.remove(this._rebuildTimeout);

        this._rebuildTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 100, () => {
                this._rebuildTimeout = 0;
                this._rebuild();
                return GLib.SOURCE_REMOVE;
            });
    }

    _rebuild() {
        // System tray must be restored before we destroy the primary panel,
        // otherwise indicators are destroyed with it.
        for (const panel of this._panels.values()) {
            if (panel.isPrimary)
                panel._systemTray?.disable();
        }

        this._destroyPanels();
        this._createPanels();
    }

    _onSettingsChanged() {
        const options = getPanelOptions();

        if (options.hideOverviewDash)
            this._chrome.hideOverviewDash();
        else
            this._chrome.restoreOverviewDash();

        // Monitor count / structural toggles → full rebuild.
        const desiredCount = options.multiMonitor
            ? Main.layoutManager.monitors.length
            : 1;

        if (desiredCount !== this._panels.size) {
            this._scheduleRebuild();
            return;
        }

        let needsRebuild = false;
        for (const panel of this._panels.values()) {
            if (panel.updateOptions(options))
                needsRebuild = true;
        }

        if (needsRebuild)
            this._scheduleRebuild();
    }
}
