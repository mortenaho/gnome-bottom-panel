/* Hide the panel off-screen; reveal from the bottom edge. */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHOW_MS = 220;
const HIDE_MS = 180;
const HOT_EDGE_SIZE = 4;
const SHOW_ZONE = 4;
const HIDE_HYSTERESIS = 12;
const POINTER_POLL_MS = 100;
const SHOW_GRACE_MS = 450;
const HIDE_COOLDOWN_MS = 400;

export class AutohideController {
    /**
     * @param {object} panel — BottomPanel actor
     */
    constructor(panel) {
        this._panel = panel;
        this._enabled = false;
        this._hidden = false;
        this._animating = false;
        this._animToken = 0;
        this._delay = 400;
        this._hideTimeout = 0;
        this._graceTimeout = 0;
        this._cooldownTimeout = 0;
        this._inShowGrace = false;
        this._inHideCooldown = false;
        /** Require pointer to leave the edge before the next reveal. */
        this._edgeArmed = true;
        this._pollId = 0;
        this._hotEdge = null;
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
            if (enabled)
                this._evaluatePointer();
            return;
        }

        if (enabled)
            this._enable();
        else
            this._disable();
    }

    destroy() {
        this._disable({teardown: true});
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
        this._edgeArmed = true;
        this._panel._setAffectsStruts(false);

        this._overviewIds.push(
            Main.overview.connect('showing', () => this._showImmediate()),
            Main.overview.connect('hiding', () => this._evaluatePointer()));

        this._ensureHotEdge();
        this._positionHotEdge();
        this._startPointerPoll();
        this._evaluatePointer();
    }

    /**
     * @param {{teardown?: boolean}} [opts]
     */
    _disable(opts = {}) {
        this._enabled = false;
        this._clearHideTimeout();
        this._clearGrace();
        this._clearCooldown();
        this._stopPointerPoll();
        this._disconnectOverview();
        this._destroyHotEdge();
        this._showImmediate();
        // During panel teardown never re-add chrome (Mutter crash risk).
        this._panel._setAffectsStruts(true, {teardown: !!opts.teardown});
    }

    _disconnectOverview() {
        for (const id of this._overviewIds)
            Main.overview.disconnect(id);
        this._overviewIds = [];
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
     * Clearly above the dock — only then may we hide.
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
     * Single decision point for show/hide based on pointer position.
     */
    _evaluatePointer() {
        if (!this._enabled || this._animating)
            return;

        if (this._isBlockedByShell()) {
            this._clearHideTimeout();
            this._edgeArmed = true;
            if (this._hidden)
                this._showImmediate();
            return;
        }

        // Re-arm reveal only after the pointer leaves the bottom edge.
        if (!this._edgeArmed && !this._isPointerInShowZone())
            this._edgeArmed = true;

        if (this._hidden) {
            this._clearHideTimeout();
            if (this._canReveal() &&
                (this._isPointerInShowZone() || this._hotEdge?.hover))
                this._show();
            return;
        }

        if (this._inShowGrace)
            return;

        // Panel is shown: hide only once the pointer is clearly away.
        if (this._isPointerFarFromDock())
            this._queueHide();
        else
            this._clearHideTimeout();
    }

    /** @returns {boolean} */
    _canReveal() {
        return this._edgeArmed && !this._inHideCooldown;
    }

    _queueHide() {
        if (!this._enabled || this._hidden || this._animating || this._inShowGrace)
            return;
        if (this._isBlockedByShell())
            return;
        if (!this._isPointerFarFromDock())
            return;
        if (this._hideTimeout)
            return;

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

    _clearGrace() {
        if (this._graceTimeout) {
            GLib.Source.remove(this._graceTimeout);
            this._graceTimeout = 0;
        }
        this._inShowGrace = false;
    }

    _clearCooldown() {
        if (this._cooldownTimeout) {
            GLib.Source.remove(this._cooldownTimeout);
            this._cooldownTimeout = 0;
        }
        this._inHideCooldown = false;
    }

    _beginShowGrace() {
        this._clearGrace();
        this._inShowGrace = true;
        this._graceTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SHOW_GRACE_MS, () => {
                this._graceTimeout = 0;
                this._inShowGrace = false;
                this._evaluatePointer();
                return GLib.SOURCE_REMOVE;
            });
    }

    _beginHideCooldown() {
        this._clearCooldown();
        this._inHideCooldown = true;
        // Stay disarmed while the pointer remains on the edge.
        this._edgeArmed = !this._isPointerInShowZone();
        this._cooldownTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, HIDE_COOLDOWN_MS, () => {
                this._cooldownTimeout = 0;
                this._inHideCooldown = false;
                this._evaluatePointer();
                return GLib.SOURCE_REMOVE;
            });
    }

    _tryHide() {
        if (!this._enabled || this._hidden || this._animating || this._inShowGrace)
            return;
        if (this._isBlockedByShell()) {
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

    /** Invalidate in-flight animation callbacks. */
    _invalidateAnimation() {
        this._animToken++;
        this._animating = false;
        this._panel.remove_all_transitions();
    }

    _showImmediate() {
        this._clearHideTimeout();
        this._clearGrace();
        this._clearCooldown();
        this._invalidateAnimation();
        this._edgeArmed = true;
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
        this._clearCooldown();
        this._invalidateAnimation();
        const token = this._animToken;

        this._hidden = false;
        this._animating = true;
        this._panel.reactive = true;

        if (!this._panel.visible)
            this._panel.show();

        if (this._panel.translation_y < 2 && this._panel.opacity < 10)
            this._panel.translation_y = this._hideOffset();

        this._syncHotEdgeVisibility();
        this._beginShowGrace();

        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: SHOW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                if (token !== this._animToken)
                    return;
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

        this._clearHideTimeout();
        this._invalidateAnimation();
        const token = this._animToken;

        this._hidden = true;
        this._animating = true;
        this._panel.reactive = false;

        this._panel.ease({
            opacity: 0,
            translation_y: this._hideOffset(),
            duration: HIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => {
                if (token !== this._animToken)
                    return;
                this._animating = false;

                // Only abort hide if the user is still pushing the edge.
                // Do NOT use the large "near dock" band — that bounced over
                // maximized windows when the pointer rested in the lower area.
                if (this._isPointerInShowZone() && this._canReveal()) {
                    this._hidden = false;
                    this._show();
                    return;
                }

                this._panel.reactive = false;
                this._panel.translation_y = this._hideOffset();
                this._panel.opacity = 0;
                this._syncHotEdgeVisibility();
                this._beginHideCooldown();
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
            if (this._hidden && !this._animating && this._canReveal())
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
            this._evaluatePointer();
        }
    }
}
