/**
 * Favorites + running apps based on the stock GNOME Dash.
 * Left-click shows Windows-like window previews when an app has multiple instances.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { WindowPreviewMenu } from './windowPreview.js';

/**
 * Dash icon with Windows-like multi-window activation.
 */
export const PanelDashIcon = GObject.registerClass(
    class PanelDashIcon extends Dash.DashIcon {
        /**
         * @param {Shell.App} app
         * @param {PanelDash} panelDash
         */
        _init(app, panelDash) {
            super._init(app);
            this._panelDash = panelDash;
            this._previewMenu = null;
            this._previewMenuManager = null;
            this._windowsChangedId = 0;

            this._windowsChangedId = this.app.connect('windows-changed',
                () => this.updateIconGeometry());

            this.connect('destroy', () => {
                if (this._windowsChangedId) {
                    this.app.disconnect(this._windowsChangedId);
                    this._windowsChangedId = 0;
                }
                this._previewMenu?.destroy();
                this._previewMenu = null;
                this._previewMenuManager = null;
            });

            // Allocation may not be ready yet during construction.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.updateIconGeometry();
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Point Shell's minimize/unminimize animation at this taskbar icon
         * (bottom panel) instead of the default top-left fallback.
         */
        updateIconGeometry() {
            if (!this.get_stage())
                return;

            const rect = new Mtk.Rectangle();
            [rect.x, rect.y] = this.get_transformed_position();
            [rect.width, rect.height] = this.get_transformed_size();

            if (rect.width < 1 || rect.height < 1)
                return;

            const monitorIndex = this._panelDash._monitorIndex;
            const windows = this.app.get_windows().filter(w => {
                if (w.is_skip_taskbar())
                    return false;
                // Always bind windows to the panel on their monitor when possible.
                return w.get_monitor() === monitorIndex;
            });

            for (const window of windows)
                window.set_icon_geometry(rect);
        }

        /**
         * Windows for this app, filtered by isolate settings and skip-taskbar.
         *
         * @returns {Meta.Window[]}
         */
        getInterestingWindows() {
            const params = this._panelDash._bpParams;
            let windows = this.app.get_windows().filter(w => !w.is_skip_taskbar());

            if (params.isolateWorkspaces) {
                const activeWs = global.workspace_manager.get_active_workspace();
                windows = windows.filter(w => w.located_on_workspace(activeWs));
            }

            if (params.isolateMonitors) {
                const monitorIndex = this._panelDash._monitorIndex;
                windows = windows.filter(w => w.get_monitor() === monitorIndex);
            }

            return windows;
        }

        _isAppFocused() {
            const focusWindow = global.display.focus_window;
            if (!focusWindow)
                return false;

            const windows = this.getInterestingWindows();
            return windows.some(w =>
                w === focusWindow ||
                focusWindow.is_attached_dialog() && focusWindow.get_transient_for() === w);
        }

        _toggleWindowPreviews() {
            if (!this._previewMenu) {
                this._previewMenuManager = new PopupMenu.PopupMenuManager(this);
                this._previewMenu = new WindowPreviewMenu(this);
                this._previewMenuManager.addMenu(this._previewMenu);

                this._previewMenu.connect('open-state-changed', (_menu, isOpen) => {
                    this.emit('menu-state-changed', isOpen);
                    if (!isOpen)
                        this.sync_hover();
                });

                const overviewId = Main.overview.connect('hiding', () => {
                    this._previewMenu?.close();
                });
                this._previewMenu.actor.connect('destroy', () => {
                    Main.overview.disconnect(overviewId);
                });
            }

            if (this._previewMenu.isOpen)
                this._previewMenu.close();
            else
                this._previewMenu.popup();
        }

        /**
         * @param {number} [button]
         */
        activate(button) {
            const event = Clutter.get_current_event();
            const modifiers = event ? event.get_state() : 0;
            const isMiddleButton = button === Clutter.BUTTON_MIDDLE;
            const isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
            const openNewWindow = this.app.can_open_new_window() &&
                this.app.state === Shell.AppState.RUNNING &&
                (isCtrlPressed || isMiddleButton);

            if (openNewWindow) {
                this.animateLaunch();
                this.app.open_new_window(-1);
                Main.overview.hide();
                return;
            }

            if (this.app.state === Shell.AppState.STOPPED) {
                this.animateLaunch();
                this.app.activate();
                Main.overview.hide();
                return;
            }

            const windows = this.getInterestingWindows();

            if (windows.length === 0) {
                this.app.activate();
                Main.overview.hide();
                return;
            }

            if (windows.length === 1) {
                const [win] = windows;
                this.updateIconGeometry();
                if (this._isAppFocused() && !Main.overview.visible)
                    win.minimize();
                else
                    Main.activateWindow(win);
                Main.overview.hide();
                return;
            }

            // Multiple instances: show Windows-like thumbnails to pick a window.
            this._toggleWindowPreviews();
            Main.overview.hide();
        }

        shouldShowTooltip() {
            return super.shouldShowTooltip() && !this._previewMenu?.isOpen;
        }
    });

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
            this._scrollView = null;

            this.add_style_class_name('bottom-panel-dash');

            // Stock Dash puts show-apps on the side; keep it but restyle.
            if (!params.showShowAppsButton)
                this.showAppsButton?.hide();
            else
                this.showAppsButton?.show();

            // Keep a fixed icon size; stock Dash resizes itself for the overview.
            this.iconSize = params.iconSize;
            this._showAppsIcon?.icon?.setIconSize?.(params.iconSize);

            // Stock DashIconsLayout uses min-width 0 + clip, so extra icons
            // vanish when the panel runs out of space. Scroll instead.
            this._installScrollView();

            this._box.connectObject(
                'child-added', (_a, item) => this._onItemAdded(item),
                this);

            // Restyle items already present.
            for (const child of this._box.get_children())
                this._onItemAdded(child);

            this._hookAppFilters();
        }

        /**
         * Wrap the icon strip in a horizontal ScrollView so a long taskbar
         * stays usable at a fixed icon size.
         *
         * GNOME 50+ St.ScrollView only accepts an StScrollable child.
         * Dash._box is an St.Widget (custom layout), so it must be wrapped
         * in St.BoxLayout — otherwise PanelDash construction throws and the
         * taskbar stays empty.
         */
        _installScrollView() {
            const box = this._box;
            const parent = box?.get_parent();
            if (!box || !parent || this._scrollView)
                return;

            try {
                parent.remove_child(box);
                box.clip_to_allocation = false;

                this._scrollContent = new St.BoxLayout({
                    style_class: 'bottom-panel-dash-scroll-content',
                    y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._scrollContent.add_child(box);

                this._scrollView = new St.ScrollView({
                    style_class: 'bottom-panel-dash-scroll',
                    x_expand: true,
                    y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    hscrollbar_policy: St.PolicyType.EXTERNAL,
                    vscrollbar_policy: St.PolicyType.NEVER,
                    overlay_scrollbars: true,
                });
                try {
                    this._scrollView.enable_mouse_scrolling = false;
                } catch (_e) {
                    // older St may not expose the property
                }

                if (typeof this._scrollView.set_child === 'function')
                    this._scrollView.set_child(this._scrollContent);
                else
                    this._scrollView.child = this._scrollContent;

                parent.insert_child_at_index(this._scrollView, 0);
                this._scrollView.connect('scroll-event',
                    this._onDashScroll.bind(this));
            } catch (e) {
                console.error(`Bottom Panel: dash scroll setup failed: ${e}`);
                // Fall back to the stock non-scrolling layout.
                this._scrollView = null;
                this._scrollContent = null;
                if (box.get_parent() !== parent) {
                    box.get_parent()?.remove_child(box);
                    parent.insert_child_at_index(box, 0);
                }
            }
        }

        /**
         * @param {Clutter.Actor} _actor
         * @param {Clutter.Event} event
         */
        _onDashScroll(_actor, event) {
            const adjustment = this._scrollView?.hadjustment ??
                this._scrollView?.hscroll?.adjustment;
            if (!adjustment)
                return Clutter.EVENT_PROPAGATE;

            // Let workspace-scroll on the panel handle it when everything fits.
            if (adjustment.upper <= adjustment.page_size + 1)
                return Clutter.EVENT_PROPAGATE;

            let delta = 0;
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();
                const step = adjustment.step_increment || this.iconSize;
                delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * step;
            } else if (direction === Clutter.ScrollDirection.UP ||
                       direction === Clutter.ScrollDirection.LEFT) {
                delta = -(adjustment.step_increment || this.iconSize);
            } else if (direction === Clutter.ScrollDirection.DOWN ||
                       direction === Clutter.ScrollDirection.RIGHT) {
                delta = adjustment.step_increment || this.iconSize;
            } else {
                return Clutter.EVENT_PROPAGATE;
            }

            if (delta === 0)
                return Clutter.EVENT_PROPAGATE;

            adjustment.set_value(adjustment.get_value() + delta);
            return Clutter.EVENT_STOP;
        }

        /**
         * Use PanelDashIcon so left-click can show multi-window previews.
         *
         * @param {Shell.App} app
         */
        _createAppItem(app) {
            const item = new Dash.DashItemContainer();
            const appIcon = new PanelDashIcon(app, this);

            appIcon.connect('menu-state-changed', (_o, opened) => {
                this._itemMenuStateChanged(item, opened);
            });

            item.setChild(appIcon);

            appIcon.label_actor = null;
            item.setLabelText(app.get_name());

            appIcon.icon.setIconSize(this.iconSize);
            this._hookUpLabel(item, appIcon);

            // Keep minimize targets in sync when the icon moves/resizes.
            item.connectObject(
                'notify::position', () => appIcon.updateIconGeometry(),
                'notify::size', () => appIcon.updateIconGeometry(),
                appIcon);

            return item;
        }

        /**
         * Refresh minimize targets for every taskbar icon.
         */
        updateIconGeometries() {
            for (const item of this._box.get_children())
                item.child?.updateIconGeometry?.();
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
                        if (w.is_skip_taskbar())
                            return false;
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

            this.updateIconGeometries();
        }

        _onItemAdded(item) {
            if (!item?.child)
                return;

            item.child.add_style_class_name('bottom-panel-app-icon');

            const icon = item.child.icon ?? item.child._icon;
            icon?.setIconSize?.(this._bpParams.iconSize);

            if (item.child instanceof PanelDashIcon) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    item.child?.updateIconGeometry?.();
                    return GLib.SOURCE_REMOVE;
                });
            }

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
            this.setIconSize(this._bpParams.iconSize);
        }

        /**
         * Update icon size from settings without recreating the dash.
         *
         * @param {number} size
         */
        setIconSize(size) {
            const next = Math.max(16, Math.round(Number(size) || 32));
            this._bpParams.iconSize = next;
            this.iconSize = next;
            this._showAppsIcon?.icon?.setIconSize?.(next);
            for (const item of this._box?.get_children() ?? []) {
                const icon = item.child?.icon ?? item.child?._icon;
                icon?.setIconSize?.(next);
            }
            this._queueRedisplay?.();
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
                // Expand so the panel can shrink us when many apps are open;
                // PanelDash scrolls internally instead of clipping icons.
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
                clip_to_allocation: true,
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

            container.x_expand = true;
            container.y_expand = true;
            this.add_child(container);
            this._dashContainer = container;
            this.setDirection(this._params.direction);

            this.connectObject('notify::allocation', () => {
                this._dash?.updateIconGeometries?.();
            }, this);
        }

        /**
         * Refresh minimize animation targets for all app icons.
         */
        updateIconGeometries() {
            this._dash?.updateIconGeometries?.();
        }

        /**
         * @param {string} [direction] — `"ltr"` or `"rtl"`
         */
        setDirection(direction) {
            const value = direction === 'rtl' ? 'rtl' : 'ltr';
            this._params.direction = value;
            const dir = value === 'rtl'
                ? Clutter.TextDirection.RTL
                : Clutter.TextDirection.LTR;

            this.text_direction = dir;
            if (this._dashContainer)
                this._dashContainer.text_direction = dir;
            if (this._dash?._box)
                this._dash._box.text_direction = dir;
        }

        /**
         * @param {Partial<typeof this._params>} updates
         */
        updateParams(updates) {
            Object.assign(this._params, updates);
            if (updates.iconSize !== undefined && this._dash)
                this._dash.setIconSize(updates.iconSize);
            this._dash?._refilterItems?.();

            if (updates.direction !== undefined)
                this.setDirection(updates.direction);

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
