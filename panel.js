/**
 * BottomPanel actor for a single monitor.
 * Layout: [workspaces?] [Start + taskbar] [clock? + tray + keyboard]
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
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
import {Taskbar} from './widgets/taskbar.js';
import {StartButton} from './widgets/startButton.js';
import {
    applyThemeClasses,
    applyBlurEffect,
    buildPanelInlineStyle,
    scaleForMonitor,
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

        this._shell = new St.BoxLayout({
            style_class: 'bottom-panel-shell',
            x_expand: true,
            y_expand: true,
            vertical: false,
        });
        this.add_child(this._shell);

        this._leftBox = new St.BoxLayout({
            style_class: 'bottom-panel-left',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
        });
        this._centerBox = new St.BoxLayout({
            style_class: 'bottom-panel-center',
            x_expand: false,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rightBox = new St.BoxLayout({
            style_class: 'bottom-panel-right',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        // Center cluster: Start + taskbar (Win11 style)
        this._centerCluster = new St.BoxLayout({
            style_class: 'bottom-panel-center-cluster',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._centerBox.add_child(this._centerCluster);

        this._shell.add_child(this._leftBox);
        this._shell.add_child(this._centerBox);
        this._shell.add_child(this._rightBox);

        this._buildContents();
        this._applyVisuals();
        this._positionOnMonitor();
        this._trackChrome();

        if (this._options.scrollPanelWorkspaces) {
            this.connect('scroll-event', (_a, event) =>
                Main.wm.handleWorkspaceScroll(event));
        }

        this._disposeColorWatch = watchColorScheme(() => this._applyVisuals());

        global.display.connectObject(
            'workareas-changed', () => this._positionOnMonitor(),
            this);

        if (this._options.animateStartup)
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
            this._startButton = new StartButton(opts.iconSize);
            this._centerCluster.add_child(this._startButton);
        }

        this._taskbar = new Taskbar({
            iconSize: opts.iconSize,
            showFavorites: opts.showFavorites,
            showRunningApps: opts.showRunningApps,
            showShowAppsButton: false, // use StartButton instead
            monitorIndex: this.monitorIndex,
            isolateMonitors: opts.isolateMonitors,
            isolateWorkspaces: opts.isolateWorkspaces,
        });
        this._centerCluster.add_child(this._taskbar);

        const clockBox = opts.clockPosition === 'center'
            ? this._centerBox
            : this._rightBox;

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
                this._rightBox,
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
        } catch (e) {
            console.error(`Bottom Panel: system tray setup failed: ${e}`);
            this._systemTray?.destroy();
            this._systemTray = null;
            return;
        }

        if (clockCentered && opts.showClock)
            this._placeClockItem(clockBox);

        for (const id of order) {
            if (id === 'clock') {
                if (!clockCentered)
                    this._placeClockItem(this._rightBox);
            } else if (id === 'system') {
                this._systemTray?.placeSystemIndicators(this._rightBox);
            } else if (id === 'keyboard') {
                this._placeKeyboardItem();
            }
        }

        this._applyTrayIconSize(opts.trayIconSize);
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
        this._rightBox.add_child(this._keyboard.container);
    }

    /**
     * @param {number} size
     */
    _applyTrayIconSize(size) {
        const n = Math.max(12, Math.min(48, size | 0));
        this._rightBox.set_style(`icon-size: ${n}px;`);
        this._systemTray?.applyTrayIconSize(n);
        this._keyboard?.setIconSize?.(n);
    }

    /**
     * @returns {SevenSegmentClock}
     */
    _createSevenSegmentClock() {
        const opts = this._options;
        return new SevenSegmentClock({
            format: opts.clockFormat,
            colonBlink: opts.clockColonBlink,
            ledColor: opts.clockLedColor,
            hourFormat: opts.clockHourFormat,
            thickness: opts.clockSegmentThickness,
        });
    }

    _applyVisuals() {
        applyThemeClasses(this, this._options);
        this.add_style_class_name('win11-panel');
        const style = buildPanelInlineStyle(this._options);
        this._shell.set_style(style);

        this._blurEffect = applyBlurEffect(
            this._shell,
            this._options.enableBlur);
    }

    _positionOnMonitor() {
        const monitor = Main.layoutManager.monitors[this.monitorIndex];
        if (!monitor)
            return;

        const margin = scaleForMonitor(
            this._options.panelMargin, this.monitorIndex);
        const height = scaleForMonitor(
            this._options.panelHeight, this.monitorIndex);

        // Win11-like: full-bleed when margin is 0, floating when > 0.
        const width = Math.max(0, monitor.width - 2 * margin);
        const x = monitor.x + margin;
        const y = monitor.y + monitor.height - height - margin;

        this.set_position(x, y);
        this.set_size(width, height);
    }

    _trackChrome() {
        if (this._chromeTracked)
            return;

        Main.layoutManager.addChrome(this, {
            affectsStruts: true,
            trackFullscreen: true,
        });
        this._chromeTracked = true;
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
            showFavorites: options.showFavorites,
            showRunningApps: options.showRunningApps,
            showShowAppsButton: false,
            isolateMonitors: options.isolateMonitors,
            isolateWorkspaces: options.isolateWorkspaces,
        });

        this._startButton?.setIconSize?.(options.iconSize);
        this._keyboard?.setDisplayMode?.(options.keyboardDisplayMode);
        this._applyTrayIconSize(options.trayIconSize);

        if (this._sevenSegClock) {
            this._sevenSegClock.setOptions({
                format: options.clockFormat,
                colonBlink: options.clockColonBlink,
                ledColor: options.clockLedColor,
                hourFormat: options.clockHourFormat,
                thickness: options.clockSegmentThickness,
            });
        }

        if (this._startButton && !options.showShowAppsButton) {
            this._startButton.hide();
        } else if (this._startButton && options.showShowAppsButton) {
            this._startButton.show();
        }

        this._applyVisuals();
        this._positionOnMonitor();

        const orderChanged =
            JSON.stringify(normalizePanelItemOrder(prev.panelItemOrder)) !==
            JSON.stringify(normalizePanelItemOrder(options.panelItemOrder));

        return prev.showWorkspaces !== options.showWorkspaces ||
            prev.showClock !== options.showClock ||
            prev.clockPosition !== options.clockPosition ||
            prev.clockStyle !== options.clockStyle ||
            prev.showSystemIndicators !== options.showSystemIndicators ||
            prev.showShowAppsButton !== options.showShowAppsButton ||
            prev.showKeyboardLayout !== options.showKeyboardLayout ||
            prev.panelMargin !== options.panelMargin ||
            orderChanged;
    }

    _onDestroy() {
        global.display.disconnectObject(this);
        this._disposeColorWatch?.();
        this._disposeColorWatch = null;

        this._systemTray?.destroy();
        this._systemTray = null;

        this._keyboard?.destroy();
        this._keyboard = null;

        this._untrackChrome();
    }
});
