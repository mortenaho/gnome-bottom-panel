/**
 * BottomPanel actor for a single monitor.
 * Layout: [workspaces?] [Start + taskbar] [clock? + tray + keyboard]
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WorkspaceIndicator} from './indicators/workspaceIndicator.js';
import {
    SystemTrayManager,
    SecondaryClock,
    normalizePanelItemOrder,
} from './indicators/systemTray.js';
import {SevenSegmentClock} from './indicators/sevenSegmentClock.js';
import {KeyboardLayoutIndicator} from './indicators/keyboardLayout.js';
import {AppIndicatorTray} from './indicators/appTray.js';
import {Taskbar} from './widgets/taskbar.js';
import {StartButton} from './widgets/startButton.js';
import {AutohideController} from './utils/autohide.js';
import {
    applyThemeClasses,
    applyBlurEffect,
    buildPanelInlineStyle,
    fitIconSize,
    watchColorScheme,
} from './utils/theming.js';

export const BottomPanel = GObject.registerClass(
class BottomPanel extends St.Widget {
    /**
     * @param {{
     *   monitorIndex: number,
     *   isPrimary: boolean,
     *   options: object,
     * }} params
     */
    _init({monitorIndex, isPrimary, options}) {
        super._init({
            name: `bottom-panel-monitor-${monitorIndex}`,
            style_class: 'bottom-panel win11-panel',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.monitorIndex = monitorIndex;
        this.isPrimary = isPrimary;
        this._options = {...options};
        this._blurEffect = null;
        this._systemTray = null;
        this._keyboard = null;
        this._disposeColorWatch = null;
        this._chromeTracked = false;
        this._affectsStruts = true;
        this._trackFullscreen = true;
        this._autohide = null;
        this._minimizeTargetIdle = 0;
        this._tornDown = false;

        // Panel chrome is always LTR so left/center/right stay in fixed
        // screen positions even when the session language is RTL.
        this.text_direction = Clutter.TextDirection.LTR;

        // Non-overlapping columns: tray/clock/keyboard never sit under apps.
        this._shell = new St.BoxLayout({
            style_class: 'bottom-panel-shell',
            x_expand: true,
            y_expand: true,
            vertical: false,
            text_direction: Clutter.TextDirection.LTR,
        });
        this.add_child(this._shell);

        this._leftBox = new St.BoxLayout({
            style_class: 'bottom-panel-left',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            text_direction: Clutter.TextDirection.LTR,
        });
        this._centerBox = new St.BoxLayout({
            style_class: 'bottom-panel-center',
            x_expand: false,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rightBox = new St.Widget({
            style_class: 'bottom-panel-right',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
            layout_manager: new Clutter.BinLayout(),
        });
        // Inner tray strip stays pinned to the physical right edge even when
        // the outer column is widened to keep the taskbar screen-centered.
        this._rightContent = new St.BoxLayout({
            style_class: 'bottom-panel-right-content',
            y_expand: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            text_direction: Clutter.TextDirection.LTR,
        });
        this._rightBox.add_child(this._rightContent);

        // Center cluster: Start + taskbar (direction is configurable).
        // Expand so a capped center column still gives the taskbar a real
        // viewport width for horizontal scrolling.
        this._centerCluster = new St.BoxLayout({
            style_class: 'bottom-panel-center-cluster',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._centerBox.add_child(this._centerCluster);

        this._shell.add_child(this._leftBox);
        this._shell.add_child(this._centerBox);
        this._shell.add_child(this._rightBox);

        this._balancingSides = false;
        this._shell.connect('notify::allocation', () => {
            if (this._tornDown || !this.get_stage?.())
                return;
            this._balanceSideColumns();
            this._queueMinimizeTargetUpdate();
        });
        this._centerCluster.connect('notify::allocation',
            () => {
                if (!this._tornDown)
                    this._balanceSideColumns();
            });
        this._rightBox.connect('notify::allocation',
            () => {
                if (!this._tornDown)
                    this._balanceSideColumns();
            });
        this._rightContent.connect('notify::allocation',
            () => {
                if (!this._tornDown)
                    this._balanceSideColumns();
            });

        this._buildContents();
        this._applyVisuals();
        this._positionOnMonitor();
        this._balanceSideColumns();
        this._trackChrome();
        this._queueMinimizeTargetUpdate();

        if (this._options.scrollPanelWorkspaces) {
            this.connect('scroll-event', (_a, event) =>
                Main.wm.handleWorkspaceScroll(event));
        }

        this._disposeColorWatch = watchColorScheme(() => this._applyVisuals());

        global.display.connectObject(
            'workareas-changed', () => {
                if (this._tornDown || !this.get_stage?.())
                    return;
                this._positionOnMonitor();
                this._queueMinimizeTargetUpdate();
            },
            'window-created', () => {
                if (!this._tornDown)
                    this._queueMinimizeTargetUpdate();
            },
            this);

        this._autohide = new AutohideController(this);
        this._autohide.update(
            !!this._options.autohide,
            this._options.autohideDelay ?? 400);

        if (this._options.animateStartup && !this._options.autohide)
            this._animateIn();

        this.connect('destroy', () => this._onDestroy());
    }

    _buildContents() {
        const opts = this._options;

        if (opts.showWorkspaces) {
            this._workspaceIndicator = new WorkspaceIndicator();
            this._leftBox.add_child(this._workspaceIndicator);
        }

        if (opts.showShowAppsButton) {
            this._startButton = new StartButton(
                opts.iconSize, opts.appsButtonIcon);
            this._centerCluster.add_child(this._startButton);
        }

        this._taskbar = new Taskbar({
            iconSize: opts.iconSize,
            iconPadding: opts.iconPadding ?? 4,
            showFavorites: opts.showFavorites,
            showRunningApps: opts.showRunningApps,
            showShowAppsButton: false, // use StartButton instead
            monitorIndex: this.monitorIndex,
            isolateMonitors: opts.isolateMonitors,
            isolateWorkspaces: opts.isolateWorkspaces,
            direction: opts.taskbarDirection,
        });
        this._centerCluster.add_child(this._taskbar);
        this._taskbar.connectObject(
            'content-size-changed', () => this._balanceSideColumns(),
            this);

        this._applyTaskbarDirection(opts.taskbarDirection);
        this._applyTaskbarAlignment(opts.taskbarAlignment);

        const clockBox = opts.clockPosition === 'center'
            ? this._centerBox
            : this._rightContent;

        if (this.isPrimary) {
            this._buildPrimaryTray(clockBox);
        } else if (opts.showClock) {
            if (opts.clockStyle === 'seven-segment') {
                this._sevenSegClock = this._createSevenSegmentClock();
                clockBox.add_child(this._sevenSegClock);
            } else {
                this._secondaryClock = new SecondaryClock();
                clockBox.add_child(this._secondaryClock);
            }
        }
    }

    /**
     * Place clock / system / keyboard according to panel-item-order.
     * When clock-position is "center", the clock is placed in the center box
     * and skipped in the right-side order loop.
     *
     * @param {St.BoxLayout} clockBox
     */
    _buildPrimaryTray(clockBox) {
        const opts = this._options;
        const order = normalizePanelItemOrder(opts.panelItemOrder);
        const clockCentered = opts.clockPosition === 'center';

        try {
            this._systemTray = new SystemTrayManager(
                this._rightContent,
                clockBox,
                {
                    showClock: opts.showClock,
                    clockPosition: opts.clockPosition,
                    clockStyle: opts.clockStyle,
                    showSystemIndicators: opts.showSystemIndicators,
                    showKeyboardLayout: opts.showKeyboardLayout,
                    trayIconSize: opts.trayIconSize,
                });
            this._systemTray.prepareKeyboard();

            if (clockCentered && opts.showClock)
                this._placeClockItem(clockBox);

            for (const id of order) {
                if (id === 'clock') {
                    if (!clockCentered)
                        this._placeClockItem(this._rightContent);
                } else if (id === 'system') {
                    this._systemTray?.placeSystemIndicators(this._rightContent);
                } else if (id === 'keyboard') {
                    this._placeKeyboardItem();
                } else if (id === 'tray') {
                    this._placeAppTrayItem();
                }
            }

            this._applyTrayIconSize(opts.trayIconSize);
        } catch (e) {
            console.error(`Bottom Panel: primary tray setup failed: ${e}`);
            // Restore any Shell singletons already reparented before aborting.
            try {
                this._appTray?.destroy();
            } catch (_e) { /* ignore */ }
            this._appTray = null;
            try {
                this._systemTray?.destroy();
            } catch (_e) { /* ignore */ }
            this._systemTray = null;
            try {
                this._keyboard?.destroy();
            } catch (_e) { /* ignore */ }
            this._keyboard = null;
            try {
                this._sevenSegClock?.destroy();
            } catch (_e) { /* ignore */ }
            this._sevenSegClock = null;
        }
    }

    _placeAppTrayItem() {
        const opts = this._options;
        if (!opts.showAppTray)
            return;

        this._appTray = new AppIndicatorTray({
            iconSize: opts.trayIconSize,
            maxVisible: opts.trayMaxVisible ?? 0,
        });
        this._rightContent.add_child(this._appTray);
    }

    /**
     * Apply LTR/RTL packing to the Start + taskbar cluster only.
     * Panel chrome (left / right tray) stays LTR so clock, keyboard, and
     * system indicators remain on the physical right edge.
     *
     * @param {string} direction — `"ltr"` or `"rtl"`
     */
    _applyTaskbarDirection(direction) {
        this.text_direction = Clutter.TextDirection.LTR;
        this._shell.text_direction = Clutter.TextDirection.LTR;
        this._leftBox.text_direction = Clutter.TextDirection.LTR;
        this._rightContent.text_direction = Clutter.TextDirection.LTR;

        const dir = direction === 'rtl'
            ? Clutter.TextDirection.RTL
            : Clutter.TextDirection.LTR;
        this._centerCluster.text_direction = dir;
        this._taskbar?.setDirection?.(direction);
    }

    /**
     * Place the Start + taskbar cluster in the center or toward the right
     * (just before clock / keyboard / tray).
     *
     * @param {string} alignment — `"center"` or `"right"`
     */
    _applyTaskbarAlignment(alignment) {
        if (alignment === 'right') {
            this._leftBox.set_width(-1);
            this._rightBox.set_width(-1);
            this._leftBox.x_expand = true;
            this._rightBox.x_expand = false;
        } else {
            // Fixed side columns → true screen center, no overlap.
            this._leftBox.x_expand = false;
            this._rightBox.x_expand = false;
        }
        this._balanceSideColumns();
        this._shell.queue_relayout();
    }

    /**
     * Keep the taskbar near screen center without clipping the right tray.
     * Grow the center to fit all apps while space remains; only then scroll.
     */
    _balanceSideColumns() {
        if (this._balancingSides || this._tornDown || !this._shell)
            return;

        if (!this.get_stage?.())
            return;

        const shellW = this._shell.width;
        if (shellW <= 0)
            return;

        this._balancingSides = true;
        try {
            this._leftBox.set_width(-1);
            this._rightBox.set_width(-1);
            this._centerBox.set_width(-1);

            const themeNode = this._shell.get_theme_node?.();
            const padL = themeNode?.get_padding?.(St.Side.LEFT) ?? 0;
            const padR = themeNode?.get_padding?.(St.Side.RIGHT) ?? 0;
            // Stage / St layout use logical pixels (scale-monitor-framebuffer).
            const spacing = this._options.panelSpacing ?? 0;
            const horizontalPad = Math.max(padL + padR, spacing * 2);
            const usable = Math.max(0, shellW - horizontalPad);

            const leftNat = Math.ceil(
                this._leftBox.get_preferred_width(-1)[1]);
            const rightNat = Math.ceil(
                this._rightContent.get_preferred_width(-1)[1]);

            // ScrollView reports a tiny preferred width — use the real icon
            // strip so the center grows with apps until the tray blocks it.
            const startW = this._startButton
                ? Math.ceil(this._startButton.get_preferred_width(-1)[1])
                : 0;
            const clusterNode = this._centerCluster.get_theme_node?.();
            const clusterPad =
                (clusterNode?.get_padding?.(St.Side.LEFT) ?? 0) +
                (clusterNode?.get_padding?.(St.Side.RIGHT) ?? 0);
            const clusterSpacing = clusterNode?.get_length?.('spacing') ?? 2;
            const taskbarWant = Math.ceil(
                this._taskbar?.getDesiredWidth?.() ??
                this._taskbar?.get_preferred_width?.(-1)?.[1] ??
                0);
            const centerFromApps = startW + taskbarWant + clusterPad +
                (startW && taskbarWant ? clusterSpacing : 0);
            const centerPref = Math.ceil(
                this._centerBox.get_preferred_width(-1)[1]);
            const centerNat = Math.max(centerPref, centerFromApps);

            // Reserve tray / workspaces first; leftover capacity stays in the
            // side columns (end space). The taskbar scrolls inside centerMax.
            const centerMax = Math.max(0, usable - leftNat - rightNat);
            const centerW = Math.min(centerNat, centerMax);

            if ((this._options.taskbarAlignment ?? 'center') === 'right') {
                this._centerBox.set_width(centerW);
                this._rightBox.set_width(rightNat);
                this._leftBox.set_width(-1);
                return;
            }

            const remaining = Math.max(0, usable - centerW);
            let leftW;
            let rightW;

            // Prefer true centering when the tray fits in the right half.
            const idealSide = Math.floor(remaining / 2);
            if (rightNat <= idealSide && leftNat <= idealSide) {
                leftW = Math.max(leftNat, idealSide);
                rightW = remaining - leftW;
                if (rightW < rightNat) {
                    rightW = rightNat;
                    leftW = Math.max(leftNat, remaining - rightW);
                }
            } else {
                // Collision: keep the right tray fully visible; extra room
                // goes to the left (trailing flexible space toward the end
                // of the leading side rather than eating the tray).
                rightW = Math.min(rightNat, remaining);
                leftW = Math.max(0, remaining - rightW);
                if (leftW < leftNat && remaining >= leftNat) {
                    leftW = leftNat;
                    rightW = Math.max(0, remaining - leftW);
                }
            }

            this._leftBox.set_width(Math.max(0, leftW));
            this._rightBox.set_width(Math.max(0, rightW));
            // Always pin the center width: natural when it fits, capped when
            // apps overflow so the ScrollView gets a real viewport and icons
            // stay reachable instead of shrinking to zero.
            this._centerBox.set_width(centerW);
        } finally {
            this._balancingSides = false;
        }
    }

    /**
     * @param {St.BoxLayout} box
     */
    _placeClockItem(box) {
        const opts = this._options;
        if (!opts.showClock)
            return;

        if (opts.clockStyle === 'seven-segment') {
            this._sevenSegClock = this._createSevenSegmentClock();
            box.add_child(this._sevenSegClock);
        }

        this._systemTray?.placeClock(box);
    }

    _placeKeyboardItem() {
        const opts = this._options;
        if (!opts.showKeyboardLayout)
            return;

        this._keyboard = new KeyboardLayoutIndicator(
            opts.keyboardDisplayMode,
            opts.extensionPath ?? '');
        this._keyboard.setIconSize(opts.trayIconSize ?? 16);
        this._rightContent.add_child(this._keyboard.container);
    }

    /**
     * @param {number} size
     */
    _applyTrayIconSize(size) {
        const n = Math.max(12, Math.min(48, size | 0));
        this._rightContent.set_style(`icon-size: ${n}px;`);
        this._systemTray?.applyTrayIconSize(n);
        this._keyboard?.setIconSize?.(n);
        this._appTray?.setIconSize?.(n);
    }

    /**
     * @returns {SevenSegmentClock}
     */
    _createSevenSegmentClock() {
        const opts = this._options;
        const clock = new SevenSegmentClock({
            format: opts.clockFormat,
            colonBlink: opts.clockColonBlink,
            ledColor: opts.clockLedColor,
            hourFormat: opts.clockHourFormat,
            thickness: opts.clockSegmentThickness,
            panelHeight: opts.panelHeight,
            extensionPath: opts.extensionPath ?? '',
        });
        // DSEG width is locked in JS; rebalance when font/size settles.
        clock.connect('metrics-changed', () => this._balanceSideColumns());
        return clock;
    }

    _applyVisuals() {
        applyThemeClasses(this, this._options);
        this.add_style_class_name('win11-panel');
        const style = buildPanelInlineStyle(this._options);
        this._shell.set_style(style);

        this._blurEffect = applyBlurEffect(
            this._shell,
            this._options.enableBlur);

        // Overflow flyout uses the same color / opacity / blur as the dock.
        this._appTray?.applyVisuals?.(this._options);
    }

    _positionOnMonitor() {
        if (this._tornDown || !this.get_stage?.())
            return;

        const monitor = Main.layoutManager.monitors[this.monitorIndex];
        if (!monitor)
            return;

        // layoutManager geometry is logical pixels under modern Mutter.
        const margin = Math.max(0, this._options.panelMargin ?? 0);
        const height = Math.max(32, this._options.panelHeight ?? 48);

        // full-bleed when margin is 0
        const width = Math.max(0, monitor.width - 2 * margin);
        const x = monitor.x + margin;
        const y = monitor.y + monitor.height - height - margin;

        this.set_position(x, y);
        this.set_size(width, height);
        this._balanceSideColumns();
        this._autohide?.onMonitorChanged();
        this._queueMinimizeTargetUpdate();
    }

    _queueMinimizeTargetUpdate() {
        if (this._minimizeTargetIdle || this._tornDown)
            return;
        this._minimizeTargetIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._minimizeTargetIdle = 0;
            if (!this._tornDown && this.get_stage?.())
                this._updateMinimizeTargets();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Aim Shell minimize/unminimize animations at the bottom panel.
     * App icons win when present; otherwise use the panel center.
     */
    _updateMinimizeTargets() {
        if (this._tornDown || !this.get_stage())
            return;

        const iconSize = fitIconSize(
            this._options.iconSize ?? 32,
            this._options.panelHeight ?? 48,
            this._options.iconPadding ?? 4);
        const [panelX, panelY] = this.get_transformed_position();
        const [panelW, panelH] = this.get_transformed_size();
        if (panelW < 1 || panelH < 1)
            return;

        const fallback = new Mtk.Rectangle();
        fallback.x = Math.round(panelX + (panelW - iconSize) / 2);
        fallback.y = Math.round(panelY + (panelH - iconSize) / 2);
        fallback.width = iconSize;
        fallback.height = iconSize;

        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(w =>
            !w.is_skip_taskbar() && w.get_monitor() === this.monitorIndex);

        for (const window of windows)
            window.set_icon_geometry(fallback);

        // Per-app icons override the panel-center fallback.
        this._taskbar?.updateIconGeometries?.();
    }

    _trackChrome() {
        if (this._chromeTracked)
            return;

        Main.layoutManager.addChrome(this, {
            affectsStruts: this._affectsStruts,
            trackFullscreen: this._trackFullscreen,
        });
        this._chromeTracked = true;
    }

    /**
     * Update whether maximized windows reserve space for the panel.
     * Auto-hide disables struts and fullscreen tracking so the Shell does
     * not fight our own hide/show animations.
     *
     * @param {boolean} affectsStruts
     * @param {{teardown?: boolean}} [opts] — teardown: only remove chrome
     */
    _setAffectsStruts(affectsStruts, opts = {}) {
        const trackFullscreen = affectsStruts;
        if (this._affectsStruts === affectsStruts &&
            this._trackFullscreen === trackFullscreen &&
            !opts.teardown)
            return;

        this._affectsStruts = affectsStruts;
        this._trackFullscreen = trackFullscreen;
        if (!this._chromeTracked)
            return;

        // During teardown never re-add chrome (workareas thrash / crash risk).
        if (opts.teardown || this._tornDown) {
            this._untrackChrome();
            return;
        }

        Main.layoutManager.removeChrome(this);
        this._chromeTracked = false;
        this._trackChrome();
    }

    _untrackChrome() {
        if (!this._chromeTracked)
            return;
        Main.layoutManager.removeChrome(this);
        this._chromeTracked = false;
    }

    _animateIn() {
        this.opacity = 0;
        this.translation_y = this.height || 40;
        this.ease({
            opacity: 255,
            translation_y: 0,
            duration: 280,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * @param {object} options
     * @returns {boolean} whether a full rebuild is needed
     */
    updateOptions(options) {
        const prev = this._options;
        this._options = {...options};

        this._taskbar?.updateParams({
            iconSize: options.iconSize,
            iconPadding: options.iconPadding ?? 4,
            showFavorites: options.showFavorites,
            showRunningApps: options.showRunningApps,
            showShowAppsButton: false,
            isolateMonitors: options.isolateMonitors,
            isolateWorkspaces: options.isolateWorkspaces,
            direction: options.taskbarDirection,
        });

        this._applyTaskbarDirection(options.taskbarDirection);
        this._applyTaskbarAlignment(options.taskbarAlignment);
        this._balanceSideColumns();

        this._startButton?.setIconSize?.(options.iconSize);
        this._startButton?.setIconName?.(options.appsButtonIcon);
        this._keyboard?.setDisplayMode?.(options.keyboardDisplayMode);
        this._applyTrayIconSize(options.trayIconSize);
        this._appTray?.setMaxVisible?.(options.trayMaxVisible ?? 0);

        if (this._sevenSegClock) {
            this._sevenSegClock.setOptions({
                format: options.clockFormat,
                colonBlink: options.clockColonBlink,
                ledColor: options.clockLedColor,
                hourFormat: options.clockHourFormat,
                thickness: options.clockSegmentThickness,
                panelHeight: options.panelHeight,
                extensionPath: options.extensionPath ?? '',
            });
            this._balanceSideColumns();
        }

        if (this._startButton && !options.showShowAppsButton) {
            this._startButton.hide();
        } else if (this._startButton && options.showShowAppsButton) {
            this._startButton.show();
        }

        this._applyVisuals();
        this._positionOnMonitor();

        this._autohide?.update(
            !!options.autohide,
            options.autohideDelay ?? 400);

        const orderChanged =
            JSON.stringify(normalizePanelItemOrder(prev.panelItemOrder)) !==
            JSON.stringify(normalizePanelItemOrder(options.panelItemOrder));

        return prev.showWorkspaces !== options.showWorkspaces ||
            prev.showClock !== options.showClock ||
            prev.clockPosition !== options.clockPosition ||
            prev.clockStyle !== options.clockStyle ||
            prev.showSystemIndicators !== options.showSystemIndicators ||
            prev.showAppTray !== options.showAppTray ||
            prev.showShowAppsButton !== options.showShowAppsButton ||
            prev.showKeyboardLayout !== options.showKeyboardLayout ||
            prev.panelMargin !== options.panelMargin ||
            orderChanged;
    }

    /**
     * Restore shell indicators before destroying the panel actor.
     */
    teardown() {
        if (this._tornDown)
            return;
        this._tornDown = true;

        if (this._minimizeTargetIdle) {
            GLib.Source.remove(this._minimizeTargetIdle);
            this._minimizeTargetIdle = 0;
        }

        try {
            this.remove_all_transitions?.();
        } catch (_e) {
            // ignore
        }

        // Clear dateMenu sourceActor before destroying the clock widget.
        try {
            const dateMenu = Main.panel.statusArea?.dateMenu;
            if (dateMenu?.menu &&
                (dateMenu.menu.sourceActor === this._sevenSegClock ||
                 dateMenu.menu.sourceActor === this._secondaryClock))
                dateMenu.menu.sourceActor = dateMenu;
        } catch (_e) {
            // ignore
        }

        try {
            this._taskbar?.disconnectObject?.(this);
        } catch (_e) {
            // ignore
        }

        try {
            this._autohide?.destroy();
        } catch (e) {
            console.warn(`Bottom Panel: autohide teardown: ${e}`);
        }
        this._autohide = null;

        try {
            this._appTray?.destroy();
        } catch (e) {
            console.warn(`Bottom Panel: app tray teardown: ${e}`);
        }
        this._appTray = null;

        try {
            this._systemTray?.destroy();
        } catch (e) {
            console.warn(`Bottom Panel: system tray teardown: ${e}`);
        }
        this._systemTray = null;

        try {
            this._keyboard?.destroy();
        } catch (e) {
            console.warn(`Bottom Panel: keyboard teardown: ${e}`);
        }
        this._keyboard = null;

        try {
            this._sevenSegClock?.destroy();
        } catch (e) {
            console.warn(`Bottom Panel: clock teardown: ${e}`);
        }
        this._sevenSegClock = null;

        this._untrackChrome();
    }

    _onDestroy() {
        this.teardown();

        global.display.disconnectObject(this);
        this._disposeColorWatch?.();
        this._disposeColorWatch = null;
    }
});
