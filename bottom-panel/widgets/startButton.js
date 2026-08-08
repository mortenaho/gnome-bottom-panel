/* Apps / overview toggle button. */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const DEFAULT_APPS_ICON = 'view-app-grid-symbolic';

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeIconValue(value) {
    const trimmed = String(value ?? '').trim();
    return trimmed || DEFAULT_APPS_ICON;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isFileIcon(value) {
    return value.startsWith('/') || value.startsWith('file://');
}

export const StartButton = GObject.registerClass(
class StartButton extends St.Button {
    /**
     * @param {number} [iconSize=28]
     * @param {string} [iconName=DEFAULT_APPS_ICON]
     */
    _init(iconSize = 28, iconName = DEFAULT_APPS_ICON) {
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
            style_class: 'bottom-panel-start-icon',
            icon_size: Math.max(16, iconSize - 4),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._icon);
        this.setIconName(iconName);

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

    /**
     * Apply a theme icon name or absolute image path.
     *
     * @param {string} value
     */
    setIconName(value) {
        const icon = normalizeIconValue(value);

        if (isFileIcon(icon)) {
            try {
                const path = icon.startsWith('file://')
                    ? Gio.File.new_for_uri(icon).get_path()
                    : icon;
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    this._icon.gicon = Gio.FileIcon.new(file);
                    return;
                }
            } catch (e) {
                console.warn(`Bottom Panel: invalid Apps icon path: ${e}`);
            }
            this._icon.gicon = null;
            this._icon.icon_name = DEFAULT_APPS_ICON;
            return;
        }

        this._icon.gicon = null;
        this._icon.icon_name = icon;
    }

    _toggleApps() {
        try {
            if (Main.overview.visible) {
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
