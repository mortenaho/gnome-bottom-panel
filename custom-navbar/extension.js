import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NavbarWidget} from './indicators/navbarWidget.js';

export default class CustomNavbarExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._widget = null;
        this._settings = null;
        this._settingsChangedId = 0;
        this._hidden = [];
    }

    enable() {
        this._settings = this.getSettings();

        const start = () => {
            this._hideStockIndicators();
            this._createWidget();
            this._settingsChangedId = this._settings.connect('changed', () => {
                this._applySettings();
            });
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

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;

        this._destroyWidget();
        this._restoreStockIndicators();
    }

    _createWidget() {
        this._destroyWidget();

        this._widget = new NavbarWidget({
            extensionPath: this.path,
            ...this._readOptions(),
        });

        // Far right of the top bar — after battery, network, Quick Settings, …
        const position = Main.panel._rightBox?.get_n_children?.() ?? -1;
        Main.panel.addToStatusArea(
            'custom-navbar',
            this._widget,
            position,
            'right');
    }

    _destroyWidget() {
        if (!this._widget)
            return;
        this._widget.destroy();
        this._widget = null;
    }

    /**
     * @returns {{
     *   ledColor: string,
     *   hourFormat: string,
     *   colonBlink: boolean,
     *   flagHeight: number,
     *   clockThickness: number,
     * }}
     */
    _readOptions() {
        const s = this._settings;
        return {
            ledColor: s.get_string('led-color'),
            hourFormat: s.get_string('hour-format'),
            colonBlink: s.get_boolean('colon-blink'),
            flagHeight: s.get_int('flag-height'),
            clockThickness: s.get_int('clock-thickness'),
        };
    }

    _applySettings() {
        this._widget?.setOptions(this._readOptions());
    }

    /**
     * Hide the stock dateMenu actor and keyboard indicator without destroying them.
     */
    _hideStockIndicators() {
        this._restoreStockIndicators();

        const {statusArea} = Main.panel;
        if (!statusArea)
            return;

        // dateMenu — keep actor mapped so its popup still works; collapse chrome.
        const dateMenu = statusArea.dateMenu;
        if (dateMenu) {
            this._hidden.push({
                actor: dateMenu,
                wasVisible: dateMenu.visible,
                wasReactive: dateMenu.reactive,
                wasOpacity: dateMenu.opacity,
            });
            // Stay "visible" to Clutter so the calendar menu can open,
            // but take no space and ignore pointer events.
            dateMenu.visible = true;
            dateMenu.reactive = false;
            dateMenu.opacity = 0;
            if (dateMenu.container) {
                this._hidden.push({
                    actor: dateMenu.container,
                    wasVisible: dateMenu.container.visible,
                    wasWidth: dateMenu.container.width,
                });
                dateMenu.container.set_width(0);
                dateMenu.container.opacity = 0;
                dateMenu.container.reactive = false;
            }
        }

        const keyboard = statusArea.keyboard;
        if (keyboard) {
            this._hidden.push({
                actor: keyboard,
                wasVisible: keyboard.visible,
            });
            keyboard.visible = false;
            if (keyboard.container) {
                this._hidden.push({
                    actor: keyboard.container,
                    wasVisible: keyboard.container.visible,
                });
                keyboard.container.visible = false;
            }
        }
    }

    _restoreStockIndicators() {
        for (const entry of this._hidden) {
            try {
                if (!entry.actor || entry.actor.is_finalized?.())
                    continue;
                if (entry.wasVisible !== undefined)
                    entry.actor.visible = entry.wasVisible;
                if (entry.wasReactive !== undefined)
                    entry.actor.reactive = entry.wasReactive;
                if (entry.wasOpacity !== undefined)
                    entry.actor.opacity = entry.wasOpacity;
                if (entry.wasWidth !== undefined)
                    entry.actor.set_width(entry.wasWidth);
            } catch (_e) {
                // Actor may already be gone during Shell teardown.
            }
        }
        this._hidden = [];
    }
}
