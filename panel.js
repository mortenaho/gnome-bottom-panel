/**
 * panel.js — BottomPanel actor for a single monitor.
 *
 * Layout (left → right):
 *   [ Workspaces? ] [ Taskbar (favorites + running) ] … [ Clock? ] … [ System tray ]
 *
 * The panel is registered with Main.layoutManager.addChrome so Mutter reserves
 * a bottom strut (windows maximize above it). Geometry respects HiDPI via
 * St.ThemeContext / monitor scale.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WorkspaceIndicator} from './indicators/workspaceIndicator.js';
import {
    SystemTrayManager,
    SecondaryClock,
} from './indicators/systemTray.js';
import {Taskbar} from './widgets/taskbar.js';
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
            style_class: 'bottom-panel',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.monitorIndex = monitorIndex;
        this.isPrimary = isPrimary;
        this._options = {...options};
        this._blurEffect = null;
        this._systemTray = null;
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
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._centerBox = new St.BoxLayout({
            style_class: 'bottom-panel-center',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rightBox = new St.BoxLayout({
            style_class: 'bottom-panel-right',
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

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

        this._taskbar = new Taskbar({
            iconSize: opts.iconSize,
            showFavorites: opts.showFavorites,
            showRunningApps: opts.showRunningApps,
            showShowAppsButton: opts.showShowAppsButton,
            monitorIndex: this.monitorIndex,
            isolateMonitors: opts.isolateMonitors,
            isolateWorkspaces: opts.isolateWorkspaces,
        });
        this._leftBox.add_child(this._taskbar);

        if (this.isPrimary) {
            try {
                this._systemTray = new SystemTrayManager(
                    this._rightBox,
                    this._centerBox,
                    {
                        showClock: opts.showClock,
                        clockPosition: opts.clockPosition,
                        showSystemIndicators: opts.showSystemIndicators,
                    });
                this._systemTray.enable();
            } catch (e) {
                console.error(`Bottom Panel: system tray setup failed: ${e}`);
                this._systemTray?.destroy();
                this._systemTray = null;
            }
        } else if (opts.showClock) {
            this._secondaryClock = new SecondaryClock();
            if (opts.clockPosition === 'center')
                this._centerBox.add_child(this._secondaryClock);
            else
                this._rightBox.add_child(this._secondaryClock);
        }
    }

    _applyVisuals() {
        applyThemeClasses(this);
        const style = buildPanelInlineStyle(this._options);
        this._shell.set_style(style);

        this._blurEffect = applyBlurEffect(
            this._shell,
            this._options.enableBlur);
    }

    /**
     * Place the panel along the bottom edge of its monitor with optional margin.
     */
    _positionOnMonitor() {
        const monitor = Main.layoutManager.monitors[this.monitorIndex];
        if (!monitor)
            return;

        const margin = scaleForMonitor(
            this._options.panelMargin, this.monitorIndex);
        const height = scaleForMonitor(
            this._options.panelHeight, this.monitorIndex);

        const width = Math.max(0, monitor.width - 2 * margin);
        const x = monitor.x + margin;
        const y = monitor.y + monitor.height - height - margin;

        this.set_position(x, y);
        this.set_size(width, height);
    }

    /**
     * Register with the layout manager so maximized windows avoid the panel.
     */
    _trackChrome() {
        if (this._chromeTracked)
            return;

        // affectsStruts: reserve work-area space.
        // trackFullscreen: auto-hide when a fullscreen window is focused.
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
            duration: 320,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * Apply updated settings without recreating the whole panel when possible.
     *
     * @param {object} options
     */
    updateOptions(options) {
        const prev = this._options;
        this._options = {...options};

        this._taskbar?.updateParams({
            iconSize: options.iconSize,
            showFavorites: options.showFavorites,
            showRunningApps: options.showRunningApps,
            showShowAppsButton: options.showShowAppsButton,
            isolateMonitors: options.isolateMonitors,
            isolateWorkspaces: options.isolateWorkspaces,
        });

        this._applyVisuals();
        this._positionOnMonitor();

        // Structural changes (clock position, trays, workspaces) need rebuild
        // by PanelManager — signal via return value.
        return prev.showWorkspaces !== options.showWorkspaces ||
            prev.showClock !== options.showClock ||
            prev.clockPosition !== options.clockPosition ||
            prev.showSystemIndicators !== options.showSystemIndicators ||
            prev.panelMargin !== options.panelMargin;
    }

    _onDestroy() {
        global.display.disconnectObject(this);
        this._disposeColorWatch?.();
        this._disposeColorWatch = null;

        this._systemTray?.destroy();
        this._systemTray = null;

        this._untrackChrome();
    }
});
