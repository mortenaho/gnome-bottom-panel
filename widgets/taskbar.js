/**
 * taskbar.js — Favorites + running applications using the stock GNOME Dash.
 *
 * Extending Dash.Dash reuses AppIcon, show-apps button, favorites sync, and
 * running-app tracking from the Shell. We only restyle and constrain icon size
 * for the bottom panel.
 *
 * Limitation: Dash.Dash is designed for the overview. Some overview-only
 * behaviors (drag-to-workspace, label placement) need small adjustments when
 * the dash lives on a permanent chrome actor. Labels are positioned above the
 * icon when the panel is at the bottom.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Bottom-panel-oriented Dash: fixed icon size, horizontal layout, no overview
 * height animation.
 */
export const PanelDash = GObject.registerClass(
class PanelDash extends Dash.Dash {
    /**
     * @param {{
     *   iconSize: number,
     *   showFavorites: boolean,
     *   showRunningApps: boolean,
     *   showShowAppsButton: boolean,
     *   monitorIndex: number,
     *   isolateMonitors: boolean,
     *   isolateWorkspaces: boolean,
     * }} params
     */
    _init(params) {
        super._init();

        this._bpParams = params;
        this._monitorIndex = params.monitorIndex;
        this.iconSize = params.iconSize;

        this.add_style_class_name('bottom-panel-dash');

        // Stock Dash puts show-apps on the side; keep it but restyle.
        if (!params.showShowAppsButton)
            this.showAppsButton?.hide();
        else
            this.showAppsButton?.show();

        // Keep a fixed icon size; stock Dash resizes itself for the overview.
        this.iconSize = params.iconSize;
        this._showAppsIcon?.icon?.setIconSize?.(params.iconSize);

        this._box.connectObject(
            'child-added', (_a, item) => this._onItemAdded(item),
            this);

        // Restyle items already present.
        for (const child of this._box.get_children())
            this._onItemAdded(child);

        this._hookAppFilters();
    }

    _hookAppFilters() {
        if (!this._bpParams.isolateWorkspaces && !this._bpParams.isolateMonitors)
            return;

        // When isolating, hide DashIcon items that don't match.
        const refilter = () => this._refilterItems();
        global.workspace_manager.connectObject(
            'active-workspace-changed', refilter, this);
        global.display.connectObject(
            'restacked', refilter,
            'notify::focus-window', refilter,
            this);

        this._box.connectObject('child-added', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refilterItems();
                return GLib.SOURCE_REMOVE;
            });
        }, this);

        this._refilterItems();
    }

    _refilterItems() {
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitorIndex = this._monitorIndex;
        const isolateWs = this._bpParams.isolateWorkspaces;
        const isolateMon = this._bpParams.isolateMonitors;
        const showFavorites = this._bpParams.showFavorites;
        const showRunning = this._bpParams.showRunningApps;
        const favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        for (const item of this._box.get_children()) {
            const app = item.child?.app;
            if (!app) {
                item.visible = true;
                continue;
            }

            const isFavorite = !!favorites[app.get_id()];
            const isRunning = app.state === Shell.AppState.RUNNING;

            let visible = false;
            if (showFavorites && isFavorite)
                visible = true;
            if (showRunning && isRunning)
                visible = true;

            if (visible && isRunning && (isolateWs || isolateMon)) {
                const windows = app.get_windows().filter(w => {
                    if (isolateWs && !w.located_on_workspace(activeWs))
                        return false;
                    if (isolateMon && w.get_monitor() !== monitorIndex)
                        return false;
                    return true;
                });
                // Keep favorites visible even with zero matching windows.
                if (windows.length === 0 && !(showFavorites && isFavorite))
                    visible = false;
            }

            if (!showFavorites && isFavorite && !isRunning)
                visible = false;
            if (!showRunning && isRunning && !isFavorite)
                visible = false;

            item.visible = visible;
        }

        if (this._separator)
            this._separator.visible = showFavorites && showRunning;
    }

    _onItemAdded(item) {
        if (!item?.child)
            return;

        item.child.add_style_class_name('bottom-panel-app-icon');

        const icon = item.child.icon ?? item.child._icon;
        icon?.setIconSize?.(this._bpParams.iconSize);

        // Place labels above the panel.
        if (item.label) {
            item.label.connectObject('notify::visible', () => {
                if (!item.label.visible)
                    return;
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!item.label)
                        return GLib.SOURCE_REMOVE;
                    const [, stageY] = item.get_transformed_position();
                    const labelHeight = item.label.height || 20;
                    item.label.y = stageY - labelHeight - 8;
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        }
    }

    /**
     * Ignore overview-driven max size; keep the panel icon size fixed.
     *
     * @param {number} _maxWidth
     * @param {number} _maxHeight
     */
    setMaxSize(_maxWidth, _maxHeight) {
        const target = this._bpParams.iconSize;
        if (this.iconSize !== target) {
            this.iconSize = target;
            this._showAppsIcon?.icon?.setIconSize?.(target);
            for (const item of this._box.get_children()) {
                const icon = item.child?.icon ?? item.child?._icon;
                icon?.setIconSize?.(target);
            }
        }
        this._queueRedisplay();
    }

    /**
     * Update icon size from settings without recreating the dash.
     *
     * @param {number} size
     */
    setIconSize(size) {
        this._bpParams.iconSize = size;
        this.setMaxSize(-1, -1);
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._box?.disconnectObject(this);
        super.destroy();
    }
});

/**
 * Container widget that hosts PanelDash and exposes a stable actor for the panel.
 */
export const Taskbar = GObject.registerClass(
class Taskbar extends St.BoxLayout {
    /**
     * @param {object} params — forwarded to PanelDash
     */
    _init(params) {
        super._init({
            style_class: 'bottom-panel-taskbar',
            reactive: true,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });

        this._params = params;
        this._dash = null;

        // Defer Dash construction slightly so AppSystem favorites are ready.
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._createDash();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createDash() {
        this._dash = new PanelDash(this._params);

        // Dash layout: use its internal container for a compact strip.
        const container = this._dash._dashContainer ?? this._dash;
        if (container.get_parent())
            container.get_parent().remove_child(container);

        this.add_child(container);
        this._dashContainer = container;
    }

    /**
     * @param {Partial<typeof this._params>} updates
     */
    updateParams(updates) {
        Object.assign(this._params, updates);
        if (updates.iconSize && this._dash)
            this._dash.setIconSize(updates.iconSize);
        this._dash?._refilterItems?.();

        if (updates.showShowAppsButton !== undefined && this._dash?.showAppsButton) {
            if (updates.showShowAppsButton)
                this._dash.showAppsButton.show();
            else
                this._dash.showAppsButton.hide();
        }
    }

    destroy() {
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        this._dash?.destroy();
        this._dash = null;
        super.destroy();
    }
});
