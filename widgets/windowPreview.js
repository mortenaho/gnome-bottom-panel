/**
 * Windows-like window preview popup for multi-instance apps.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const PREVIEW_MAX_WIDTH = 220;
const PREVIEW_MAX_HEIGHT = 130;
const PREVIEW_ANIMATION_MS = 180;
const MAX_CLONE_ATTEMPTS = 12;

/**
 * Popup that lists live window thumbnails for an app icon.
 */
export class WindowPreviewMenu extends PopupMenu.PopupMenu {
    /**
     * @param {import('./taskbar.js').PanelDashIcon} source
     */
    constructor(source) {
        super(source, 0.5, St.Side.TOP);

        this.blockSourceEvents = true;
        this._source = source;

        // actor is the BoxPointer; box is .popup-menu-content
        this.actor.add_style_class_name('bottom-panel-window-preview-menu');
        this.box.add_style_class_name('bottom-panel-window-preview-content');
        this.actor.hide();

        // Kill stock menu chrome (opaque fill + arrow border).
        const clearChrome = 'background-color: transparent; border: none; box-shadow: none;';
        this.actor.set_style(clearChrome);
        this.box.set_style(`${clearChrome} padding: 0; margin: 0;`);
        this._boxPointer.bin?.set_style?.(clearChrome);

        this._mappedId = this._source.connect('notify::mapped', () => {
            if (!this._source.mapped)
                this.close();
        });

        Main.uiGroup.add_child(this.actor);
        this.connect('destroy', () => this._onDestroy());
    }

    _redisplay() {
        this._previewBox?.destroy();
        this._previewBox = new WindowPreviewList(this._source);
        this.addMenuItem(this._previewBox);
        this._previewBox.redisplay();
    }

    popup() {
        const windows = this._source.getInterestingWindows();
        if (windows.length === 0)
            return;

        this._redisplay();
        this.open(BoxPointer.PopupAnimation.FULL);
        this.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _onDestroy() {
        if (this._mappedId) {
            this._source.disconnect(this._mappedId);
            this._mappedId = 0;
        }
    }
}

class WindowPreviewList extends PopupMenu.PopupMenuSection {
    /**
     * @param {import('./taskbar.js').PanelDashIcon} source
     */
    constructor(source) {
        super();

        this._source = source;
        this.app = source.app;

        // Plain horizontal box — no ScrollView, so no scrollbar chrome.
        this.box.vertical = false;
        this.box.style_class = 'bottom-panel-window-preview-list';
        this.actor = this.box;
        this.actor._delegate = this;

        this._shownInitially = false;
        this._windowsChangedId = this.app.connect('windows-changed',
            () => this.redisplay());
        this.actor.connect('destroy', () => this._onDestroy());
    }

    redisplay() {
        const existing = this._getMenuItems().filter(item => item._window);
        const oldWindows = existing.map(item => item._window);
        const newWindows = this._source.getInterestingWindows()
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());

        const added = [];
        const removed = [];
        let newIndex = 0;
        let oldIndex = 0;

        while (newIndex < newWindows.length || oldIndex < oldWindows.length) {
            const oldWin = oldWindows[oldIndex];
            const newWin = newWindows[newIndex];

            if (oldWin === newWin) {
                oldIndex++;
                newIndex++;
                continue;
            }

            if (oldWin && !newWindows.includes(oldWin)) {
                removed.push(existing[oldIndex]);
                oldIndex++;
                continue;
            }

            if (newWin && !oldWindows.includes(newWin)) {
                added.push({
                    item: new WindowPreviewMenuItem(newWin),
                    pos: newIndex,
                });
                newIndex++;
                continue;
            }

            const insertHere = newWindows[newIndex + 1] === oldWin;
            const alreadyRemoved = removed.some(item => item._window === newWin);
            if (insertHere || alreadyRemoved) {
                added.push({
                    item: new WindowPreviewMenuItem(newWin),
                    pos: newIndex + removed.length,
                });
                newIndex++;
            } else {
                removed.push(existing[oldIndex]);
                oldIndex++;
            }
        }

        for (const entry of added)
            this.addMenuItem(entry.item, entry.pos);

        for (const item of removed) {
            if (this._shownInitially)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }

        const animate = this._shownInitially;
        this._shownInitially = true;
        for (const entry of added)
            entry.item.showPreview(animate);

        this.box.queue_relayout();

        if (newWindows.length < 1)
            this._getTopMenu().close();
    }

    _onDestroy() {
        if (this._windowsChangedId) {
            this.app.disconnect(this._windowsChangedId);
            this._windowsChangedId = 0;
        }
    }
}

export const WindowPreviewMenuItem = GObject.registerClass(
class WindowPreviewMenuItem extends PopupMenu.PopupBaseMenuItem {
    /**
     * @param {Meta.Window} window
     */
    _init(window) {
        super._init({
            style_class: 'bottom-panel-window-preview-item',
        });

        this._window = window;
        this.remove_child(this._ornamentIcon);

        this._cloneBin = new St.Bin({
            style_class: 'bottom-panel-window-preview-clone',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._updatePreviewSize();

        const buttonLayout = Meta.prefs_get_button_layout();
        const closeOnLeft = buttonLayout.left_buttons.includes(Meta.ButtonFunction.CLOSE);
        this._closeButton = new St.Button({
            style_class: 'window-close bottom-panel-window-preview-close',
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: closeOnLeft ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._closeButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 16,
        }));
        this._closeButton.connect('clicked', () => this._closeWindow());

        const overlay = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });
        overlay.add_child(this._cloneBin);
        overlay.add_child(this._closeButton);

        this._titleLabel = new St.Label({
            text: window.get_title() || '',
            style_class: 'bottom-panel-window-preview-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._titleId = window.connect('notify::title', () => {
            this._titleLabel.text = this._window.get_title() || '';
        });

        const box = new St.BoxLayout({
            vertical: true,
            reactive: true,
            x_expand: true,
            style_class: 'bottom-panel-window-preview-box',
        });
        box.add_child(overlay);
        box.add_child(this._titleLabel);
        this.add_child(box);

        this._cloneTexture(window);
        this.connect('destroy', () => this._onDestroy());
    }

    _getPreviewMetrics() {
        const mutterWindow = this._window.get_compositor_private();
        if (!mutterWindow?.get_texture())
            return [0, 0, 0];

        const [width, height] = mutterWindow.get_size();
        if (!width || !height)
            return [0, 0, 0];

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scaleFactor;
        const scale = Math.min(
            1.0,
            PREVIEW_MAX_WIDTH / width,
            PREVIEW_MAX_HEIGHT / height) * scaleFactor;
        return [width, height, scale];
    }

    _updatePreviewSize() {
        [this._width, this._height, this._scale] = this._getPreviewMetrics();
        this._cloneBin.set_size(
            Math.max(1, this._width * this._scale),
            Math.max(1, this._height * this._scale));
    }

    _cloneTexture(metaWin) {
        if (!this._width || !this._height) {
            this._cloneAttempt = (this._cloneAttempt || 0) + 1;
            if (this._cloneAttempt > MAX_CLONE_ATTEMPTS)
                return;

            this._cloneLater = global.compositor.get_laters().add(
                Meta.LaterType.BEFORE_REDRAW, () => {
                    this._cloneLater = 0;
                    this._updatePreviewSize();
                    this._cloneTexture(metaWin);
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }

        const mutterWindow = metaWin.get_compositor_private();
        if (!mutterWindow)
            return;

        const clone = new Clutter.Clone({
            source: mutterWindow,
            reactive: true,
            width: this._width * this._scale,
            height: this._height * this._scale,
        });

        this._destroyId = mutterWindow.connect('destroy', () => {
            clone.destroy();
            this._destroyId = 0;
            this.animateOutAndDestroy();
        });

        this._clone = clone;
        this._mutterWindow = mutterWindow;
        this._cloneBin.set_child(clone);

        clone.connect('destroy', () => {
            if (this._destroyId && this._mutterWindow) {
                this._mutterWindow.disconnect(this._destroyId);
                this._destroyId = 0;
            }
            this._clone = null;
        });
    }

    _closeWindow() {
        this._window.delete(global.get_current_time());
    }

    vfunc_enter_event(crossingEvent) {
        this._showCloseButton();
        return super.vfunc_enter_event(crossingEvent);
    }

    vfunc_leave_event(crossingEvent) {
        this._hideCloseButton();
        return super.vfunc_leave_event(crossingEvent);
    }

    _showCloseButton() {
        if (!this._window.can_close())
            return;
        this._closeButton.show();
        this._closeButton.remove_all_transitions();
        this._closeButton.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideCloseButton() {
        if (this._closeButton.has_pointer)
            return;
        this._closeButton.remove_all_transitions();
        this._closeButton.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    /**
     * @param {boolean} animate
     */
    showPreview(animate) {
        const fullWidth = this.get_width();
        this.opacity = 0;
        this.set_width(0);
        this.remove_all_transitions();
        this.ease({
            opacity: 255,
            width: fullWidth || -1,
            duration: animate ? PREVIEW_ANIMATION_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    animateOutAndDestroy() {
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            width: 0,
            duration: PREVIEW_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this.destroy(),
        });
    }

    activate(_event) {
        Main.activateWindow(this._window);
        this._getTopMenu().close();
    }

    _onDestroy() {
        if (this._cloneLater) {
            global.compositor.get_laters().remove(this._cloneLater);
            this._cloneLater = 0;
        }
        if (this._titleId) {
            this._window.disconnect(this._titleId);
            this._titleId = 0;
        }
        if (this._destroyId && this._mutterWindow) {
            this._mutterWindow.disconnect(this._destroyId);
            this._destroyId = 0;
        }
    }
});
