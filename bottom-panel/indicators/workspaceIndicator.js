/**
 * workspaceIndicator.js — Compact workspace dots for the bottom panel.
 *
 * Reuses Main.createWorkspacesAdjustment when available (GNOME 46+) so the
 * indicator stays in sync with dynamic workspaces and animations used by the
 * Activities button. Falls back to WorkspaceManager signals otherwise.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const INACTIVE_SCALE = 0.7;

const WorkspaceDot = GObject.registerClass({
    Properties: {
        'expansion': GObject.ParamSpec.double(
            'expansion', null, null,
            GObject.ParamFlags.READWRITE,
            0.0, 1.0, 0.0),
    },
}, class WorkspaceDot extends St.Widget {
    _init() {
        super._init({
            style_class: 'bottom-panel-ws-dot',
            reactive: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.connect('notify::expansion', () => this._updateVisuals());
        this._updateVisuals();
    }

    _updateVisuals() {
        const e = this.expansion;
        this.opacity = Math.round(Util.lerp(120, 255, e));
        this.scale_x = Util.lerp(INACTIVE_SCALE, 1.0, e);
        this.scale_y = Util.lerp(INACTIVE_SCALE, 1.0, e);
    }
});

/**
 * Horizontal row of workspace dots. Clicking a dot activates that workspace.
 * Scrolling over the indicator switches workspaces.
 */
export const WorkspaceIndicator = GObject.registerClass(
class WorkspaceIndicator extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'bottom-panel-ws-indicator',
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dots = [];
        this._adjustment = null;

        if (typeof Main.createWorkspacesAdjustment === 'function') {
            this._adjustment = Main.createWorkspacesAdjustment(this);
            this._adjustment.connectObject(
                'notify::value', () => this._updateExpansion(),
                'notify::upper', () => this._rebuild(),
                this);
        } else {
            global.workspace_manager.connectObject(
                'notify::n-workspaces', () => this._rebuild(),
                'active-workspace-changed', () => this._updateExpansion(),
                this);
        }

        this._rebuild();

        this.connect('scroll-event', (_a, event) =>
            Main.wm.handleWorkspaceScroll(event));
    }

    _workspaceCount() {
        if (this._adjustment)
            return Math.max(1, Math.round(this._adjustment.upper));
        return global.workspace_manager.n_workspaces;
    }

    _activeIndex() {
        if (this._adjustment)
            return this._adjustment.value;
        return global.workspace_manager.get_active_workspace_index();
    }

    _rebuild() {
        for (const dot of this._dots)
            dot.destroy();
        this._dots = [];

        const n = this._workspaceCount();
        for (let i = 0; i < n; i++) {
            const dot = new WorkspaceDot();
            const index = i;
            dot.connect('button-press-event', () => {
                const ws = global.workspace_manager.get_workspace_by_index(index);
                if (ws)
                    ws.activate(global.get_current_time());
                return Clutter.EVENT_STOP;
            });
            this.add_child(dot);
            this._dots.push(dot);
        }

        this._updateExpansion();
    }

    _updateExpansion() {
        const active = this._activeIndex();
        this._dots.forEach((dot, index) => {
            const distance = Math.abs(index - active);
            dot.expansion = Math.clamp(1 - distance, 0, 1);
        });
    }

    destroy() {
        this._adjustment?.disconnectObject?.(this);
        global.workspace_manager.disconnectObject(this);
        super.destroy();
    }
});
