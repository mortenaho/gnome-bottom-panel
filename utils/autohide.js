/**
 * Auto-hide controller for a BottomPanel actor.
 *
 * Intellihide-style behavior when enabled:
 * - Empty desktop / no maximized window → panel stays visible
 * - Maximized or fullscreen window on this monitor → hide after the
 *   pointer leaves the dock zone; reveal from the bottom edge
 *
 * Uses pointer-position hysteresis (not Actor.hover) so slide animations
 * cannot bounce the panel. The actor stays mapped; "hidden" means
 * translated off-screen with reactive=false. Auto-hide disables struts.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHOW_MS = 200;
const HIDE_MS = 160;
const HOT_EDGE_SIZE = 8;
/** Pointer must enter this many px from the bottom to reveal. */
const SHOW_ZONE = 8;
/** Extra gap above the panel before a hide is allowed (hysteresis). */
const HIDE_HYSTERESIS = 40;
const POINTER_POLL_MS = 120;
/** Minimum hide delay — setting 0 still needs debounce against flicker. */
const MIN_HIDE_DELAY_MS = 280;

export class AutohideController {
    /**
     * @param {object} panel — BottomPanel actor
     */
    constructor(panel) {
        this._panel = panel;
        this._enabled = false;
        this._hidden = false;
        this._animating = false;
        this._delay = 400;
        this._hideTimeout = 0;
        this._windowCheckId = 0;
        this._pollId = 0;
        this._hotEdge = null;
        this._overviewIds = [];
        /** @type {Map<object, number[]>} */
        this._trackedWindows = new Map();
        this._displayTracked = false;
        this._wmTracked = false;
        this._wsTracked = false;
    }

    /**
     * @param {boolean} enabled
     * @param {number} [delayMs]
     */
    update(enabled, delayMs) {
        if (typeof delayMs === 'number')
            this._delay = Math.max(0, Math.min(5000, delayMs | 0));

        if (enabled === this._enabled) {
            if (enabled)
                this._syncToWindowState();
            return;
        }

        if (enabled)
            this._enable();
        else
            this._disable();
    }

    destroy() {
        this._disable();
    }

    /** @returns {boolean} */
    get enabled() {
        return this._enabled;
    }

    /** @returns {boolean} */
    get hidden() {
        return this._hidden;
    }

    _enable() {
        this._enabled = true;
        this._panel._setAffectsStruts(false);

        // Do NOT drive hide/show from notify::hover — it flickers while the
        // panel slides under a maximized window and caused the bounce loop.

        this._overviewIds.push(
            Main.overview.connect('showing', () => this._showImmediate()),
            Main.overview.connect('hiding', () => this._syncToWindowState()));

        this._connectWindowWatch();
        this._ensureHotEdge();
        this._positionHotEdge();
        this._startPointerPoll();
        this._syncToWindowState();
    }

    _disable() {
        this._enabled = false;
        this._clearHideTimeout();
        this._clearWindowCheck();
        this._stopPointerPoll();
        this._disconnectWindowWatch();
        this._disconnectOverview();
        this._destroyHotEdge();
        this._showImmediate();
        this._panel._setAffectsStruts(true);
    }

    _disconnectOverview() {
        for (const id of this._overviewIds)
            Main.overview.disconnect(id);
        this._overviewIds = [];
    }

    _connectWindowWatch() {
        if (this._displayTracked)
            return;

        const schedule = () => this._scheduleWindowCheck();

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._trackWindow(win);
                schedule();
            },
            this);
        this._displayTracked = true;

        global.window_manager.connectObject(
            'minimize', schedule,
            'unminimize', schedule,
            'size-changed', schedule,
            'destroy', schedule,
            this);
        this._wmTracked = true;

        global.workspace_manager.connectObject(
            'active-workspace-changed', schedule,
            this);
        this._wsTracked = true;

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win)
                this._trackWindow(win);
        }
    }

    _disconnectWindowWatch() {
        if (this._displayTracked) {
            global.display.disconnectObject(this);
            this._displayTracked = false;
        }
        if (this._wmTracked) {
            global.window_manager.disconnectObject(this);
            this._wmTracked = false;
        }
        if (this._wsTracked) {
            global.workspace_manager.disconnectObject(this);
            this._wsTracked = false;
        }

        for (const win of [...this._trackedWindows.keys()])
            this._untrackWindow(win);
        this._trackedWindows.clear();
    }

    /**
     * @param {Meta.Window} win
     */
    _trackWindow(win) {
        if (!win || this._trackedWindows.has(win))
            return;

        const schedule = () => this._scheduleWindowCheck();
        const ids = [
            win.connect('notify::maximized-horizontally', schedule),
            win.connect('notify::maximized-vertically', schedule),
            win.connect('notify::fullscreen', schedule),
            win.connect('notify::minimized', schedule),
            win.connect('unmanaged', () => {
                this._untrackWindow(win);
                schedule();
            }),
        ];
        this._trackedWindows.set(win, ids);
    }

    /**
     * @param {Meta.Window} win
     */
    _untrackWindow(win) {
        const ids = this._trackedWindows.get(win);
        if (!ids)
            return;
        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch (_e) {
                // window may already be gone
            }
        }
        this._trackedWindows.delete(win);
    }

    _scheduleWindowCheck() {
        if (!this._enabled || this._windowCheckId)
            return;

        this._windowCheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._windowCheckId = 0;
            if (this._enabled)
                this._syncToWindowState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearWindowCheck() {
        if (this._windowCheckId) {
            GLib.Source.remove(this._windowCheckId);
            this._windowCheckId = 0;
        }
    }

    _syncToWindowState() {
        if (!this._enabled)
            return;

        if (this._isBlockedByShell() || !this._hasObscuringWindow()) {
            this._clearHideTimeout();
            this._showImmediate();
            return;
        }

        // Maximized window present: let the pointer poll decide hide/show.
        this._evaluatePointer();
    }

    /**
     * @returns {boolean}
     */
    _hasObscuringWindow() {
        const monitorIndex = this._panel.monitorIndex;
        const workspace = global.workspace_manager.get_active_workspace();

        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win || win.minimized)
                continue;
            if (!win.showing_on_its_workspace())
                continue;
            if (win.get_monitor() !== monitorIndex)
                continue;
            if (!win.located_on_workspace(workspace))
                continue;

            const type = win.get_window_type();
            if (type !== Meta.WindowType.NORMAL &&
                type !== Meta.WindowType.DIALOG &&
                type !== Meta.WindowType.MODAL_DIALOG)
                continue;

            if (typeof win.is_fullscreen === 'function'
                ? win.is_fullscreen()
                : win.fullscreen)
                return true;

            if (win.maximized_vertically)
                return true;
        }

        return false;
    }

    _panelHeight() {
        return Math.max(this._panel.height || 0,
            this._panel.get_preferred_height?.(-1)?.[1] || 0,
            40);
    }

    /**
     * Near the absolute bottom — used to reveal a hidden panel.
     *
     * @returns {boolean}
     */
    _isPointerInShowZone() {
        const monitor = Main.layoutManager.monitors[this._panel.monitorIndex];
        if (!monitor)
            return false;

        const [x, y] = global.get_pointer();
        if (x < monitor.x || x >= monitor.x + monitor.width)
            return false;

        return y >= monitor.y + monitor.height - SHOW_ZONE &&
            y <= monitor.y + monitor.height + 2;
    }

    /**
     * Clearly above the dock — only then may we hide (hysteresis).
     *
     * @returns {boolean}
     */
    _isPointerFarFromDock() {
        const monitor = Main.layoutManager.monitors[this._panel.monitorIndex];
        if (!monitor)
            return true;

        const [x, y] = global.get_pointer();
        if (x < monitor.x || x >= monitor.x + monitor.width)
            return true;

        const keepUntil = monitor.y + monitor.height -
            this._panelHeight() - HIDE_HYSTERESIS;
        return y < keepUntil;
    }

    /** @returns {boolean} */
    _isBlockedByShell() {
        return Main.overview.visible ||
            Main.overview.animationInProgress ||
            Main.modalCount > 0;
    }

    _startPointerPoll() {
        if (this._pollId)
            return;

        this._pollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
                if (!this._enabled) {
                    this._pollId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._evaluatePointer();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPointerPoll() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
    }

    /**
     * Single decision point for show/hide based on pointer + window state.
     */
    _evaluatePointer() {
        if (!this._enabled || this._animating)
            return;

        if (this._isBlockedByShell() || !this._hasObscuringWindow()) {
            this._clearHideTimeout();
            if (this._hidden)
                this._showImmediate();
            return;
        }

        if (this._hidden) {
            this._clearHideTimeout();
            if (this._isPointerInShowZone() || this._hotEdge?.hover)
                this._show();
            return;
        }

        // Panel is shown: only schedule hide once the pointer is clearly away.
        if (this._isPointerFarFromDock())
            this._queueHide();
        else
            this._clearHideTimeout();
    }

    _queueHide() {
        if (!this._enabled || this._hidden || this._animating)
            return;
        if (!this._hasObscuringWindow() || this._isBlockedByShell())
            return;
        if (!this._isPointerFarFromDock())
            return;
        if (this._hideTimeout)
            return;

        const delay = Math.max(this._delay, MIN_HIDE_DELAY_MS);
        this._hideTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._hideTimeout = 0;
                this._tryHide();
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearHideTimeout() {
        if (this._hideTimeout) {
            GLib.Source.remove(this._hideTimeout);
            this._hideTimeout = 0;
        }
    }

    _tryHide() {
        if (!this._enabled || this._hidden || this._animating)
            return;
        if (this._isBlockedByShell() || !this._hasObscuringWindow()) {
            this._showImmediate();
            return;
        }
        if (!this._isPointerFarFromDock())
            return;

        this._hide();
    }

    _hideOffset() {
        return this._panelHeight() + 8;
    }

    _showImmediate() {
        this._clearHideTimeout();
        this._animating = false;
        this._panel.remove_all_transitions();
        this._panel.reactive = true;
        this._panel.translation_y = 0;
        this._panel.opacity = 255;
        if (!this._panel.visible)
            this._panel.show();
        this._hidden = false;
        this._syncHotEdgeVisibility();
    }

    _show() {
        if (!this._hidden && this._panel.translation_y === 0 &&
            this._panel.opacity >= 255)
            return;

        this._clearHideTimeout();
        this._hidden = false;
        this._animating = true;
        this._panel.reactive = true;

        if (!this._panel.visible)
            this._panel.show();

        // Start from off-screen if we were fully tucked.
        if (this._panel.translation_y < 2 && this._panel.opacity < 10)
            this._panel.translation_y = this._hideOffset();

        this._syncHotEdgeVisibility();

        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                this._animating = false;
                this._panel.translation_y = 0;
                this._panel.opacity = 255;
                this._syncHotEdgeVisibility();
            },
        });
    }

    _hide() {
        if (this._hidden || this._animating)
            return;

        this._hidden = true;
        this._animating = true;
        this._panel.reactive = false;

        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 0,
            translation_y: this._hideOffset(),
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                this._animating = false;
                // Abort if the pointer came back during the animation.
                if (this._isPointerInShowZone() || !this._isPointerFarFromDock()) {
                    this._hidden = false;
                    this._show();
                    return;
                }
                this._panel.reactive = false;
                this._syncHotEdgeVisibility();
            },
        });
    }

    _ensureHotEdge() {
        if (this._hotEdge)
            return;

        this._hotEdge = new Clutter.Actor({
            name: `bottom-panel-hot-edge-${this._panel.monitorIndex}`,
            reactive: true,
            opacity: 0,
        });

        this._hotEdge.connect('enter-event', () => {
            if (this._hidden && !this._animating)
                this._show();
        });

        Main.layoutManager.addChrome(this._hotEdge, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(
                this._hotEdge, null);
        } catch (_e) {
            // best-effort
        }
    }

    _positionHotEdge() {
        if (!this._hotEdge)
            return;

        const monitor = Main.layoutManager.monitors[this._panel.monitorIndex];
        if (!monitor)
            return;

        this._hotEdge.set_position(
            monitor.x,
            monitor.y + monitor.height - HOT_EDGE_SIZE);
        this._hotEdge.set_size(monitor.width, HOT_EDGE_SIZE);
        this._syncHotEdgeVisibility();
    }

    _syncHotEdgeVisibility() {
        if (!this._hotEdge)
            return;

        if (this._enabled && this._hidden && !this._animating) {
            this._hotEdge.show();
            try {
                Main.layoutManager.uiGroup.set_child_above_sibling(
                    this._hotEdge, null);
            } catch (_e) {
                // ignore
            }
        } else {
            this._hotEdge.hide();
        }
    }

    _destroyHotEdge() {
        if (!this._hotEdge)
            return;
        Main.layoutManager.removeChrome(this._hotEdge);
        this._hotEdge.destroy();
        this._hotEdge = null;
    }

    onMonitorChanged() {
        if (this._enabled) {
            this._positionHotEdge();
            this._syncToWindowState();
        }
    }
}
