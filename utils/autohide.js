/**
 * Auto-hide controller for a BottomPanel actor.
 *
 * Hides the panel after the pointer leaves (configurable delay). While
 * hidden the panel is unmapped so it cannot steal events; a hot edge plus
 * pointer proximity at the monitor bottom reveal it again. Overview and
 * modal dialogs keep the panel visible. Auto-hide disables window struts.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHOW_MS = 220;
const HIDE_MS = 180;
/** Visible/hit target along the bottom edge while the panel is hidden. */
const HOT_EDGE_SIZE = 12;
/** Extra pixels above the edge that still count as a reveal zone. */
const REVEAL_THRESHOLD = 16;
const POINTER_POLL_MS = 80;

export class AutohideController {
    /**
     * @param {object} panel — BottomPanel actor
     */
    constructor(panel) {
        this._panel = panel;
        this._enabled = false;
        this._hidden = false;
        this._delay = 400;
        this._hideTimeout = 0;
        this._recheckTimeout = 0;
        this._pollId = 0;
        this._hotEdge = null;
        this._signalIds = [];
        this._overviewIds = [];
    }

    /**
     * @param {boolean} enabled
     * @param {number} [delayMs]
     */
    update(enabled, delayMs) {
        if (typeof delayMs === 'number')
            this._delay = Math.max(0, Math.min(5000, delayMs | 0));

        if (enabled === this._enabled) {
            if (enabled && !this._hidden && !this._shouldStayVisible())
                this._queueHide();
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
            Main.overview.connect('hiding', () => this._queueHide()));

        this._ensureHotEdge();
        this._positionHotEdge();
        this._startPointerPoll();

        if (this._shouldStayVisible())
            this._showImmediate();
        else
            this._queueHide();
    }

    _disable() {
        this._enabled = false;
        this._clearHideTimeout();
        this._clearRecheckTimeout();
        this._stopPointerPoll();
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

    _onPanelEnter() {
        this._clearHideTimeout();
        this._show();
    }

    _onPanelLeave() {
        this._queueHide();
    }

    _queueHide() {
        if (!this._enabled)
            return;

        this._clearHideTimeout();

        const delay = this._delay;
        if (delay <= 0) {
            this._tryHide();
            return;
        }

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
                if (this._hidden)
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
        if (!this._hidden || this._isBlockedByShell())
            return;

        const monitor = Main.layoutManager.monitors[this._panel.monitorIndex];
        if (!monitor)
            return;

        const [x, y] = global.get_pointer();
        if (x < monitor.x || x >= monitor.x + monitor.width)
            return;
        if (y < monitor.y + monitor.height - REVEAL_THRESHOLD)
            return;
        if (y > monitor.y + monitor.height)
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

        this._syncHotEdgeVisibility();

        if (!needsReveal) {
            this._panel.translation_y = 0;
            this._panel.opacity = 255;
            return;
        }

        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _hide() {
        if (this._hidden)
            return;

        this._hidden = true;
        const offset = Math.max(this._panel.height || 40, 40) + 4;

        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 0,
            translation_y: offset,
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                if (!this._hidden)
                    return;
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

        this._hotEdge.connect('enter-event', () => {
            this._clearHideTimeout();
            this._show();
        });
        this._hotEdge.connect('leave-event', () => this._queueHide());
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

        if (this._enabled && this._hidden) {
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
        if (this._enabled)
            this._positionHotEdge();
    }
}
