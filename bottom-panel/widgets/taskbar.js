/**
 * Favorites and running apps via stock Dash.
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
 * Dash icon with multi-window activation.
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

            this._geomIdle = 0;
            this.connect('destroy', () => {
                if (this._geomIdle) {
                    GLib.Source.remove(this._geomIdle);
                    this._geomIdle = 0;
                }
                if (this._windowsChangedId) {
                    this.app.disconnect(this._windowsChangedId);
                    this._windowsChangedId = 0;
                }
                this._previewMenu?.destroy();
                this._previewMenu = null;
                this._previewMenuManager = null;
            });

            // Allocation may not be ready yet during construction.
            this._geomIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._geomIdle = 0;
                this.updateIconGeometry();
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Point Shell's minimize/unminimize animation at this taskbar icon
         * (bottom panel) instead of the default top-left fallback.
         */
        updateIconGeometry() {
            if (!this.get_stage?.())
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
         * App windows for this icon, filtered by isolate settings.
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

            // Multiple windows: show previews.
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
    {
        Signals: {
            'content-size-changed': {},
        },
    },
    class PanelDash extends Dash.Dash {
        /**
         * @param {{
         *   iconSize: number,
         *   iconPadding?: number,
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

            this._bpParams = {
                iconPadding: 4,
                ...params,
            };
            this._monitorIndex = params.monitorIndex;
            this.iconSize = params.iconSize;
            this._scrollView = null;
            this._scrollContent = null;
            this._scrollLeftBtn = null;
            this._scrollRightBtn = null;
            this._adjSignalIds = [];
            this._lockingStripWidth = false;
            this._lockStripIdle = 0;
            this._refilterIdle = 0;
            this._arrowUpdateIdle = 0;
            this._contentWidth = 0;

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
                'child-added', (_a, item) => {
                    this._onItemAdded(item);
                    this._queueLockIconStripWidth();
                },
                'child-removed', () => this._queueLockIconStripWidth(),
                this);

            // Restyle items already present.
            for (const child of this._box.get_children())
                this._onItemAdded(child);

            this._hookAppFilters();
            this._queueLockIconStripWidth();
        }

        /**
         * Wrap Dash._box in St.BoxLayout for St.ScrollView (needs StScrollable).
         */
        _installScrollView() {
            const box = this._box;
            const parent = box?.get_parent();
            if (!box || !parent || this._scrollView)
                return;

            try {
                parent.remove_child(box);
                // Keep the full icon strip; ScrollView clips/scrolls the overflow.
                box.clip_to_allocation = false;
                box.x_expand = false;
                box.x_align = Clutter.ActorAlign.START;

                this._scrollContent = new St.BoxLayout({
                    style_class: 'bottom-panel-dash-scroll-content',
                    y_expand: true,
                    x_expand: false,
                    x_align: Clutter.ActorAlign.START,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this._scrollContent.add_child(box);

                this._scrollView = new St.ScrollView({
                    style_class: 'bottom-panel-dash-scroll',
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                    hscrollbar_policy: St.PolicyType.EXTERNAL,
                    vscrollbar_policy: St.PolicyType.NEVER,
                    overlay_scrollbars: true,
                    clip_to_allocation: true,
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

                this._scrollLeftBtn = this._createScrollArrow('start');
                this._scrollRightBtn = this._createScrollArrow('end');

                // [◀] [icons…] [▶]
                parent.insert_child_at_index(this._scrollLeftBtn, 0);
                parent.insert_child_at_index(this._scrollView, 1);
                parent.insert_child_at_index(this._scrollRightBtn, 2);

                this._scrollView.connect('scroll-event',
                    this._onDashScroll.bind(this));
                this._scrollView.connect('notify::allocation',
                    () => this._queueUpdateScrollArrows());

                const adjustment = this._getHAdjustment();
                if (adjustment) {
                    for (const prop of ['value', 'upper', 'page-size', 'lower']) {
                        const id = adjustment.connect(`notify::${prop}`,
                            () => this._queueUpdateScrollArrows());
                        this._adjSignalIds.push([adjustment, id]);
                    }
                }

                // DashIconsLayout reports min-width 0, so without locking the
                // strip to its natural width the viewport shrinks icons away
                // instead of scrolling. Re-lock after layout settles.
                box.connect('notify::allocation',
                    () => this._queueLockIconStripWidth());
            } catch (e) {
                console.error(`Bottom Panel: dash scroll setup failed: ${e}`);
                // Fall back to the stock non-scrolling layout.
                this._scrollView = null;
                this._scrollContent = null;
                this._scrollLeftBtn = null;
                this._scrollRightBtn = null;
                if (box.get_parent() !== parent) {
                    box.get_parent()?.remove_child(box);
                    parent.insert_child_at_index(box, 0);
                }
            }
        }

        /**
         * @param {'start'|'end'} side
         * @returns {St.Button}
         */
        _createScrollArrow(side) {
            const rtl = this.get_text_direction?.() === Clutter.TextDirection.RTL;
            const goingStart = side === 'start';
            // Physical left/right relative to LTR panel chrome.
            const iconName = (goingStart !== rtl)
                ? 'go-previous-symbolic'
                : 'go-next-symbolic';

            const btn = new St.Button({
                style_class: 'bottom-panel-scroll-arrow',
                reactive: true,
                can_focus: true,
                track_hover: true,
                visible: false,
                x_expand: false,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: iconName,
                    style_class: 'bottom-panel-scroll-arrow-icon',
                    icon_size: 16,
                }),
            });
            btn.connect('clicked', () => this._scrollByPage(goingStart ? -1 : 1));
            return btn;
        }

        /**
         * @returns {object|null}
         */
        _getHAdjustment() {
            return this._scrollView?.hadjustment ??
                this._scrollView?.hscroll?.adjustment ??
                null;
        }

        /**
         * @param {number} direction — -1 toward start, +1 toward end
         */
        _scrollByPage(direction) {
            const adjustment = this._getHAdjustment();
            if (!adjustment)
                return;
            const page = Math.max(
                adjustment.page_size * 0.75,
                adjustment.step_increment || this.iconSize || 32);
            const next = Math.max(
                adjustment.lower,
                Math.min(
                    adjustment.upper - adjustment.page_size,
                    adjustment.value + direction * page));
            if (typeof adjustment.ease === 'function') {
                adjustment.ease(next, {
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                adjustment.set_value(next);
            }
            this._queueUpdateScrollArrows();
        }

        _queueUpdateScrollArrows() {
            if (this._arrowUpdateIdle || !this.get_stage?.())
                return;
            this._arrowUpdateIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._arrowUpdateIdle = 0;
                if (this.get_stage?.())
                    this._updateScrollArrows();
                return GLib.SOURCE_REMOVE;
            });
        }

        _updateScrollArrows() {
            const left = this._scrollLeftBtn;
            const right = this._scrollRightBtn;
            const adjustment = this._getHAdjustment();
            if (!left || !right || !adjustment) {
                left && (left.visible = false);
                right && (right.visible = false);
                return;
            }

            const overflow = adjustment.upper > adjustment.page_size + 1;
            const atStart = adjustment.value <= adjustment.lower + 1;
            const atEnd = adjustment.value >=
                adjustment.upper - adjustment.page_size - 1;

            left.visible = overflow && !atStart;
            right.visible = overflow && !atEnd;
            left.reactive = left.visible;
            right.reactive = right.visible;
        }

        /**
         * Natural width of the icon strip (all visible apps), ignoring the
         * ScrollView viewport. Used so the panel can grow the taskbar area
         * before enabling scroll.
         *
         * @returns {number}
         */
        getIconStripWidth() {
            if (this._contentWidth > 0)
                return this._contentWidth;
            return this._measureIconStripWidth();
        }

        /**
         * @returns {number}
         */
        _measureIconStripWidth() {
            if (!this._box)
                return 0;
            let width = 0;
            const children = this._box.get_children().filter(c => c.visible);
            const spacing = this._box.get_theme_node?.()
                ?.get_length?.('spacing') ?? 0;
            for (let i = 0; i < children.length; i++) {
                const [, nat] = children[i].get_preferred_width(-1);
                width += Math.ceil(nat);
                if (i > 0)
                    width += spacing;
            }
            return Math.max(0, width);
        }

        /**
         * Desired taskbar width including scroll arrows when overflowing.
         *
         * @returns {number}
         */
        getDesiredWidth() {
            const strip = this.getIconStripWidth();
            let arrows = 0;
            if (this._scrollLeftBtn?.visible)
                arrows += Math.ceil(this._scrollLeftBtn.get_preferred_width(-1)[1]);
            if (this._scrollRightBtn?.visible)
                arrows += Math.ceil(this._scrollRightBtn.get_preferred_width(-1)[1]);
            // Reserve arrow slots when overflow is imminent so layout doesn't jump.
            const viewport = this._scrollView?.width ?? 0;
            if (arrows === 0 && strip > 0 && viewport > 0 && strip > viewport + 1)
                arrows = 28 * 2;
            return strip + arrows;
        }

        /**
         * Debounce strip-width locking across rapid child/layout updates.
         */
        _queueLockIconStripWidth() {
            if (this._lockStripIdle || !this.get_stage?.())
                return;
            this._lockStripIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._lockStripIdle = 0;
                if (this.get_stage?.())
                    this._lockIconStripWidth();
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Force the icon strip to its fixed-size natural width so overflow
         * scrolls at the trailing edge instead of DashIconsLayout shrinking
         * icons to fit (or to zero).
         */
        _lockIconStripWidth() {
            if (this._lockingStripWidth || !this._box || !this._scrollView)
                return;

            this._lockingStripWidth = true;
            try {
                const width = Math.max(1, this._measureIconStripWidth());
                this._contentWidth = width;

                if (Math.abs(this._box.width - width) > 0.5)
                    this._box.set_width(width);
                if (this._scrollContent &&
                    Math.abs(this._scrollContent.width - width) > 0.5)
                    this._scrollContent.set_width(width);

                this._updateScrollArrows();
                this.emit('content-size-changed');
            } finally {
                this._lockingStripWidth = false;
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
            this._queueUpdateScrollArrows();
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
            if (!this.get_stage?.() || !this._box)
                return;
            for (const item of this._box.get_children())
                item.child?.updateIconGeometry?.();
        }

        _hookAppFilters() {
            if (!this._bpParams.isolateWorkspaces && !this._bpParams.isolateMonitors)
                return;

            // When isolating, hide DashIcon items that don't match.
            const refilter = () => {
                if (this.get_stage?.())
                    this._refilterItems();
            };
            global.workspace_manager.connectObject(
                'active-workspace-changed', refilter, this);
            global.display.connectObject(
                'restacked', refilter,
                'notify::focus-window', refilter,
                this);

            this._box.connectObject('child-added', () => {
                if (this._refilterIdle)
                    return;
                this._refilterIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._refilterIdle = 0;
                    if (this.get_stage?.())
                        this._refilterItems();
                    return GLib.SOURCE_REMOVE;
                });
            }, this);

            this._refilterItems();
        }

        _refilterItems() {
            if (!this.get_stage?.() || !this._box)
                return;

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
            this._queueLockIconStripWidth();
            this._queueUpdateScrollArrows();
        }

        _onItemAdded(item) {
            if (!item?.child)
                return;

            item.child.add_style_class_name('bottom-panel-app-icon');
            this._applyIconPadding(item.child);

            const icon = item.child.icon ?? item.child._icon;
            icon?.setIconSize?.(this._bpParams.iconSize);

            if (item.child instanceof PanelDashIcon) {
                const child = item.child;
                if (child._itemGeomIdle) {
                    GLib.Source.remove(child._itemGeomIdle);
                    child._itemGeomIdle = 0;
                }
                child._itemGeomIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    child._itemGeomIdle = 0;
                    if (child.get_stage?.())
                        child.updateIconGeometry?.();
                    return GLib.SOURCE_REMOVE;
                });
            }

            // Place labels above the panel.
            if (item.label) {
                item.label.connectObject('notify::visible', () => {
                    if (!item.label?.visible || !item.get_stage?.())
                        return;
                    if (item._labelPosIdle) {
                        GLib.Source.remove(item._labelPosIdle);
                        item._labelPosIdle = 0;
                    }
                    item._labelPosIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        item._labelPosIdle = 0;
                        if (!item.label || !item.get_stage?.())
                            return GLib.SOURCE_REMOVE;
                        try {
                            const [, stageY] = item.get_transformed_position();
                            const labelHeight = item.label.height || 20;
                            item.label.y = stageY - labelHeight - 8;
                        } catch (_e) {
                            // disposed mid-rebuild
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }, this);
            }
        }

        /**
         * @param {Clutter.Actor} actor
         */
        _applyIconPadding(actor) {
            const pad = Math.max(0, Math.min(16,
                Math.round(Number(this._bpParams.iconPadding) || 0)));
            actor.set_style(`padding: ${pad}px;`);
        }

        /**
         * @param {number} padding
         */
        setIconPadding(padding) {
            this._bpParams.iconPadding = Math.max(0, Math.min(16,
                Math.round(Number(padding) || 0)));
            for (const item of this._box?.get_children() ?? []) {
                if (item.child)
                    this._applyIconPadding(item.child);
            }
            this._queueLockIconStripWidth();
            this._queueRedisplay?.();
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
            this._queueLockIconStripWidth();
            this._queueRedisplay?.();
        }

        destroy() {
            if (this._lockStripIdle) {
                GLib.Source.remove(this._lockStripIdle);
                this._lockStripIdle = 0;
            }
            if (this._refilterIdle) {
                GLib.Source.remove(this._refilterIdle);
                this._refilterIdle = 0;
            }
            if (this._arrowUpdateIdle) {
                GLib.Source.remove(this._arrowUpdateIdle);
                this._arrowUpdateIdle = 0;
            }
            for (const [obj, id] of this._adjSignalIds) {
                try {
                    obj.disconnect(id);
                } catch (_e) {
                    // disposed
                }
            }
            this._adjSignalIds = [];
            try {
                global.workspace_manager.disconnectObject(this);
                global.display.disconnectObject(this);
                this._box?.disconnectObject(this);
            } catch (_e) {
                // already disconnected
            }
            this._unwrapScrollView();
            try {
                super.destroy();
            } catch (e) {
                console.warn(`Bottom Panel: PanelDash destroy: ${e}`);
            }
        }

        /**
         * Restore stock Dash layout before destroy.
         */
        _unwrapScrollView() {
            if (!this._scrollView || !this._box)
                return;
            try {
                const box = this._box;
                const scrollParent = this._scrollView.get_parent();
                const scrollIndex = scrollParent
                    ? scrollParent.get_children().indexOf(this._scrollView)
                    : 0;
                this._scrollContent?.remove_child?.(box);
                scrollParent?.remove_child?.(this._scrollView);
                this._scrollLeftBtn?.destroy?.();
                this._scrollRightBtn?.destroy?.();
                this._scrollLeftBtn = null;
                this._scrollRightBtn = null;
                this._scrollView.destroy();
                this._scrollView = null;
                this._scrollContent = null;
                if (scrollParent && box.get_parent() !== scrollParent)
                    scrollParent.insert_child_at_index(
                        box, Math.max(0, scrollIndex));
            } catch (e) {
                console.warn(`Bottom Panel: unwrap dash scroll failed: ${e}`);
                this._scrollView = null;
                this._scrollContent = null;
                this._scrollLeftBtn = null;
                this._scrollRightBtn = null;
            }
        }
    });

/**
 * Taskbar host for PanelDash.
 */
export const Taskbar = GObject.registerClass(
    {
        Signals: {
            'content-size-changed': {},
        },
    },
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
                // Pack from the start so leftover room stays at the trailing end.
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.FILL,
                clip_to_allocation: true,
            });

            this._params = {
                iconPadding: 4,
                ...params,
            };
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
            container.x_align = Clutter.ActorAlign.FILL;
            this.add_child(container);
            this._dashContainer = container;
            this.setDirection(this._params.direction);

            this._dash.connectObject(
                'content-size-changed', () => this.emit('content-size-changed'),
                this);

            this.connectObject('notify::allocation', () => {
                if (!this.get_stage?.())
                    return;
                this._dash?.updateIconGeometries?.();
                this._dash?._queueLockIconStripWidth?.();
                this._dash?._queueUpdateScrollArrows?.();
            }, this);
        }

        /**
         * Natural width the panel should reserve for the taskbar before scroll.
         *
         * @returns {number}
         */
        getDesiredWidth() {
            return this._dash?.getDesiredWidth?.() ??
                Math.ceil(this.get_preferred_width(-1)[1] || 0);
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
            if (this._dash?._bpParams)
                Object.assign(this._dash._bpParams, updates);
            if (updates.iconSize !== undefined && this._dash)
                this._dash.setIconSize(updates.iconSize);
            if (updates.iconPadding !== undefined && this._dash)
                this._dash.setIconPadding(updates.iconPadding);
            this._dash?._queueRedisplay?.();
            this._dash?._refilterItems?.();
            this._dash?._queueLockIconStripWidth?.();
            this._dash?._queueUpdateScrollArrows?.();

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
