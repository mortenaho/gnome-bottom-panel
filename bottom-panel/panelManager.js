/**
 * Create and manage BottomPanel instances per monitor.
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BottomPanel} from './panel.js';
import {ChromeController} from './utils/chrome.js';
import {
    getPanelOptions,
    getPanelOptionsForMonitor,
    onSettingsChanged,
} from './utils/settings.js';

/** @type {string} */
let _extensionPath = '';

/**
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
        this._settingsApplyTimeout = 0;
        this._rebuilding = false;
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
                'icon-padding',
                'tray-icon-size',
                'panel-height-large',
                'icon-size-large',
                'tray-icon-size-large',
                'large-monitor-min-width',
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
                'apps-button-icon',
                'taskbar-direction',
                'taskbar-alignment',
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
                'show-app-tray',
                'tray-max-visible',
                'multi-monitor',
                'isolate-monitors',
                'isolate-workspaces',
                'hide-overview-dash',
                'animate-startup',
                'scroll-panel-workspaces',
                'autohide',
                'autohide-delay',
                'show-keyboard-layout',
                'keyboard-display-mode',
            ], () => this._onSettingsChanged());

            this._enabled = true;
        } catch (e) {
            console.error(`Bottom Panel: enable failed, restoring chrome: ${e}`);
            this.disable();
            throw e;
        }
    }

    disable() {
        this._enabled = false;
        this._rebuilding = false;

        if (this._rebuildTimeout) {
            GLib.Source.remove(this._rebuildTimeout);
            this._rebuildTimeout = 0;
        }
        if (this._settingsApplyTimeout) {
            GLib.Source.remove(this._settingsApplyTimeout);
            this._settingsApplyTimeout = 0;
        }

        this._settingsDisposer?.();
        this._settingsDisposer = null;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        // Restore shell indicators, then destroy actors, then show top panel.
        this._teardownPanels();
        this._destroyPanels();
        try {
            this._chrome.destroy();
        } catch (e) {
            console.error(`Bottom Panel: chrome restore failed: ${e}`);
        }
    }

    _createPanels() {
        const monitors = Main.layoutManager.monitors;
        const primaryIndex = Main.layoutManager.primaryIndex;
        const multiMonitor = getPanelOptions().multiMonitor;

        const indices = multiMonitor
            ? monitors.map((_, i) => i)
            : [primaryIndex];

        for (const index of indices) {
            if (this._panels.has(index))
                continue;

            const options = {
                ...getPanelOptionsForMonitor(index),
                extensionPath: _extensionPath,
            };
            let panel = null;
            try {
                panel = new BottomPanel({
                    monitorIndex: index,
                    isPrimary: index === primaryIndex,
                    options,
                });
                this._panels.set(index, panel);
            } catch (e) {
                console.error(`Bottom Panel: create monitor ${index} failed: ${e}`);
                // Emergency restore if ctor reparented singletons then threw.
                try {
                    panel?.teardown?.();
                    panel?.destroy?.();
                } catch (_e) {
                    // ignore
                }
            }
        }
    }

    _teardownPanels() {
        for (const panel of this._panels.values()) {
            try {
                panel.teardown();
            } catch (e) {
                console.warn(`Bottom Panel: panel teardown failed: ${e}`);
            }
        }
    }

    _destroyPanels() {
        this._teardownPanels();
        for (const panel of this._panels.values()) {
            try {
                panel.destroy();
            } catch (e) {
                console.warn(`Bottom Panel: panel destroy failed: ${e}`);
            }
        }
        this._panels.clear();
    }

    _cancelPendingWork() {
        if (this._rebuildTimeout) {
            GLib.Source.remove(this._rebuildTimeout);
            this._rebuildTimeout = 0;
        }
        if (this._settingsApplyTimeout) {
            GLib.Source.remove(this._settingsApplyTimeout);
            this._settingsApplyTimeout = 0;
        }
    }

    _scheduleRebuild() {
        if (!this._enabled)
            return;

        // Rebuild wins over in-flight settings apply.
        if (this._settingsApplyTimeout) {
            GLib.Source.remove(this._settingsApplyTimeout);
            this._settingsApplyTimeout = 0;
        }
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
        if (!this._enabled || this._rebuilding)
            return;

        this._rebuilding = true;
        try {
            this._destroyPanels();
            this._createPanels();
        } catch (e) {
            console.error(`Bottom Panel: rebuild failed: ${e}`);
        } finally {
            this._rebuilding = false;
        }
    }

    _onSettingsChanged() {
        if (!this._enabled || this._rebuilding)
            return;

        // Batch rapid SpinRow / linked height+icon writes into one apply.
        // Skip while a rebuild is already queued — rebuild applies everything.
        if (this._rebuildTimeout)
            return;

        if (this._settingsApplyTimeout) {
            GLib.Source.remove(this._settingsApplyTimeout);
            this._settingsApplyTimeout = 0;
        }
        this._settingsApplyTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                this._settingsApplyTimeout = 0;
                this._applySettingsNow();
                return GLib.SOURCE_REMOVE;
            });
    }

    _applySettingsNow() {
        if (!this._enabled || this._rebuilding || this._rebuildTimeout)
            return;

        const shared = getPanelOptions();

        try {
            if (shared.hideOverviewDash)
                this._chrome.hideOverviewDash();
            else
                this._chrome.restoreOverviewDash();
        } catch (e) {
            console.warn(`Bottom Panel: dash chrome update failed: ${e}`);
        }

        const desiredCount = shared.multiMonitor
            ? Main.layoutManager.monitors.length
            : 1;

        if (desiredCount !== this._panels.size) {
            this._scheduleRebuild();
            return;
        }

        let needsRebuild = false;
        for (const [index, panel] of this._panels) {
            if (panel._tornDown)
                continue;
            try {
                const options = {
                    ...getPanelOptionsForMonitor(index),
                    extensionPath: _extensionPath,
                };
                if (panel.updateOptions(options))
                    needsRebuild = true;
            } catch (e) {
                console.warn(`Bottom Panel: apply settings mon ${index}: ${e}`);
                needsRebuild = true;
            }
        }

        if (needsRebuild)
            this._scheduleRebuild();
    }
}
