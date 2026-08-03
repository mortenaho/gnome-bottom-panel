/**
 * startButton.js — Windows-style Start / Apps button.
 *
 * Stock Dash showAppsButton is wired for the overview context and often does
 * nothing once reparented into chrome. This dedicated button always toggles
 * Main.overview.showApps().
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const StartButton = GObject.registerClass(
class StartButton extends St.Button {
    _init(iconSize = 28) {
        super._init({
            style_class: 'bottom-panel-start-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Start',
        });

        this._icon = new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            style_class: 'bottom-panel-start-icon',
            icon_size: Math.max(16, iconSize - 4),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._icon);

        this.connect('clicked', () => this._toggleApps());

        Main.overview.connectObject(
            'showing', () => {
                if (Main.overview.dash?.showAppsButton?.checked ||
                    Main.overview._overview?.controls?.dash?.showAppsButton?.checked)
                    this.add_style_pseudo_class('checked');
            },
            'hiding', () => this.remove_style_pseudo_class('checked'),
            this);

        this.connect('destroy', () => this._onDestroy());
    }

    setIconSize(size) {
        this._icon.icon_size = Math.max(16, size - 4);
    }

    _toggleApps() {
        try {
            if (Main.overview.visible) {
                // If already in apps view, hide; otherwise switch to apps.
                const controls = Main.overview._overview?.controls;
                const appsVisible = controls?.dash?.showAppsButton?.checked ||
                    Main.overview.dash?.showAppsButton?.checked;

                if (appsVisible)
                    Main.overview.hide();
                else
                    Main.overview.showApps();
            } else {
                Main.overview.showApps();
            }
        } catch (e) {
            console.error(`Bottom Panel: Start button failed: ${e}`);
            // Last resort
            try {
                Main.overview.toggle();
            } catch (_e2) {
                // ignore
            }
        }
    }

    _onDestroy() {
        Main.overview.disconnectObject(this);
    }
});
