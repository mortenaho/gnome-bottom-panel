/**
 * Auto-hide controller for a BottomPanel actor.
 *
 * Intellihide-style behavior when enabled:
 * - Empty desktop / no maximized window → panel stays visible
 * - Maximized or fullscreen window on this monitor → hide after the
 *   pointer leaves; reveal from the bottom edge
 *
 * While hidden the panel is unmapped so it cannot steal events. Overview
 * and modal dialogs keep the panel visible. Auto-hide disables window struts.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHOW_MS = 220;
const HIDE_MS = 180;
/** Visible/hit target along the bottom edge while the panel is hidden. */
const HOT_EDGE_SIZE = 12;
/** Extra pixels above the edge that still count as a reveal / stay zone. */
const REVEAL_THRESHOLD = 20;
const POINTER_POLL_MS = 100;
/** After revealing, ignore hide requests briefly to avoid show/hide flicker. */
const SHOW_GRACE_MS = 350;

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
        this._recheckTimeout = 0;
        this._windowCheckId = 0;
        this._pollId = 0;
        this._graceTimeout = 0;
        this._inShowGrace = false;
        this._hotEdge = null;
        this._signalIds = [];
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

        this._signalIds.push(
            this._panel.connect('notify::hover', () => {
                if (this._panel.hover)
                    this._onPanelEnter();
                else
                    this._onPanelLeave();
            }));

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
        this._clearRecheckTimeout();
        this._clearWindowCheck();
        this._clearShowGrace();
        this._stopPointerPoll();
        this._disconnectWindowWatch();
        this._disconnectSignals();
        this._destroyHotEdge();
        this._showImmediate();
        this._panel._setAffectsStruts(true);
    }

    _disconnectSignals() {
        for (const id of this._signalIds)
            this._panel.disconnect(id);
        this._signalIds = [];

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

    /**
     * Keep the panel out when a maximized/fullscreen window is present;
     * otherwise force it visible (desktop / normal windows).
     */
    _syncToWindowState() {
        if (!this._enabled)
            return;

        if (this._isBlockedByShell() || !this._hasObscuringWindow()) {
            this._showImmediate();
            return;
        }

        if (this._shouldStayVisible())
            return;

        this._queueHide();
    }

    /**
     * True when a maximized or fullscreen window covers this monitor's
     * current workspace — the only case where auto-hide may tuck the panel.
     *
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

            // Bottom panel is covered once the window is vertically maximized.
            if (win.maximized_vertically)
                return true;
        }

        return false;
    }

    /**
     * Pointer is over the panel height (or the thin reveal strip). More
     * reliable than Actor.hover while the panel is animating in/out.
     *
     * @returns {boolean}
     */
    _isPointerInPanelZone() {
        const monitor = Main.layoutManager.monitors[this._panel.monitorIndex];
        if (!monitor)
            return false;

        const [x, y] = global.get_pointer();
        if (x < monitor.x || x >= monitor.x + monitor.width)
            return false;

        const zone = Math.max(
            this._panel.height || 40,
            HOT_EDGE_SIZE,
            REVEAL_THRESHOLD);
        return y >= monitor.y + monitor.height - zone &&
            y <= monitor.y + monitor.height + 2;
    }

    _beginShowGrace() {
        this._clearShowGrace();
        this._inShowGrace = true;
        this._graceTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SHOW_GRACE_MS, () => {
                this._graceTimeout = 0;
                this._inShowGrace = false;
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearShowGrace() {
        if (this._graceTimeout) {
            GLib.Source.remove(this._graceTimeout);
            this._graceTimeout = 0;
        }
        this._inShowGrace = false;
    }

    _onPanelEnter() {
        this._clearHideTimeout();
        this._show();
    }

    _onPanelLeave() {
        // Hover often flickers during slide-in; always re-check via timer.
        this._queueHide();
    }

    _queueHide() {
        if (!this._enabled)
            return;

        // Never tuck away on an empty desktop / non-maximized layout.
        if (!this._hasObscuringWindow()) {
            this._showImmediate();
            return;
        }

        // Pointer still in the dock zone → keep shown (stops bounce loop).
        if (this._inShowGrace || this._isPointerInPanelZone()) {
            this._clearHideTimeout();
            return;
        }

        this._clearHideTimeout();

        const delay = Math.max(this._delay, 50);
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

    _clearRecheckTimeout() {
        if (this._recheckTimeout) {
            GLib.Source.remove(this._recheckTimeout);
            this._recheckTimeout = 0;
        }
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
                // Only reveal after the panel is fully unmapped — never while
                // a hide animation is still running (that caused flicker).
                if (this._hidden && !this._panel.visible && !this._animating)
                    this._checkPointerNearEdge();
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
     * Reveal when the pointer is in the bottom strip of this monitor.
     * Works even if the hot-edge actor is covered by another chrome actor.
     */
    _checkPointerNearEdge() {
        if (!this._hidden || this._panel.visible || this._animating)
            return;
        if (this._isBlockedByShell())
            return;

        if (!this._isPointerInPanelZone())
            return;

        this._show();
    }

    /** @returns {boolean} */
    _isBlockedByShell() {
        return Main.overview.visible ||
            Main.overview.animationInProgress ||
            Main.modalCount > 0;
    }

    _shouldStayVisible() {
        if (!this._enabled)
            return true;
        if (this._isBlockedByShell())
            return true;
        if (this._inShowGrace)
            return true;
        // Desktop / floating windows: always keep the panel out.
        if (!this._hasObscuringWindow())
            return true;
        if (this._isPointerInPanelZone())
            return true;
        if (this._panel.visible && this._panel.hover)
            return true;
        if (this._hotEdge?.visible && this._hotEdge.hover)
            return true;
        return false;
    }

    _tryHide() {
        if (this._shouldStayVisible()) {
            if (this._enabled && this._isBlockedByShell())
                this._scheduleRecheck();
            return;
        }
        this._hide();
    }

    _scheduleRecheck() {
        if (this._recheckTimeout)
            return;

        this._recheckTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 250, () => {
                this._recheckTimeout = 0;
                if (!this._enabled || this._hidden)
                    return GLib.SOURCE_REMOVE;

                if (this._shouldStayVisible()) {
                    if (this._isBlockedByShell())
                        this._scheduleRecheck();
                    return GLib.SOURCE_REMOVE;
                }

                this._hide();
                return GLib.SOURCE_REMOVE;
            });
    }

    _showImmediate() {
        this._clearHideTimeout();
        this._clearRecheckTimeout();
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
        this._clearHideTimeout();
        this._beginShowGrace();

        const needsReveal = this._hidden || !this._panel.visible ||
            this._panel.translation_y !== 0 || this._panel.opacity < 255;

        this._hidden = false;
        this._panel.reactive = true;

        if (!this._panel.visible) {
            const offset = Math.max(this._panel.height || 40, 40) + 4;
            this._panel.translation_y = offset;
            this._panel.opacity = 0;
            this._panel.show();
        }

        // Hide hot edge without queuing a hide (leave-event is not connected).
        this._syncHotEdgeVisibility();

        if (!needsReveal) {
            this._animating = false;
            this._panel.translation_y = 0;
            this._panel.opacity = 255;
            return;
        }

        this._animating = true;
        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                this._animating = false;
            },
        });
    }

    _hide() {
        if (this._hidden || this._animating)
            return;

        // Safety: never hide without an obscuring maximized window.
        if (!this._hasObscuringWindow()) {
            this._showImmediate();
            return;
        }

        // Final pointer check — avoids hide→show bounce at the bottom edge.
        if (this._isPointerInPanelZone() || this._inShowGrace)
            return;

        this._hidden = true;
        this._animating = true;
        const offset = Math.max(this._panel.height || 40, 40) + 4;

        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 0,
            translation_y: offset,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this._animating = false;
                if (!this._hidden)
                    return;
                // If the pointer came back during the animation, abort hide.
                if (this._isPointerInPanelZone()) {
                    this._show();
                    return;
                }
                // Unmap so the panel cannot steal pointer events from the
                // hot edge / desktop at the bottom of the screen.
                this._panel.reactive = false;
                this._panel.hide();
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

        // Only reveal on enter — never queue hide on leave. Hiding the hot
        // edge when the panel appears synthesizes leave-event and used to
        // bounce the panel up and down.
        this._hotEdge.connect('enter-event', () => {
            this._clearHideTimeout();
            this._show();
        });
        this._hotEdge.connect('notify::hover', () => {
            if (this._hotEdge.hover) {
                this._clearHideTimeout();
                this._show();
            }
        });

        Main.layoutManager.addChrome(this._hotEdge, {
            affectsStruts: false,
            trackFullscreen: false,
        });

        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(
                this._hotEdge, null);
        } catch (_e) {
            // uiGroup stacking is best-effort.
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

        if (this._enabled && this._hidden && !this._panel.visible) {
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

    /** Reposition hot edge after monitor geometry changes. */
    onMonitorChanged() {
        if (this._enabled) {
            this._positionHotEdge();
            this._syncToWindowState();
        }
    }
}
