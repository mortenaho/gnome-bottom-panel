/**
 * theming.js — Light/dark adaptation and panel visual styling.
 *
 * Follows org.gnome.desktop.interface color-scheme so the bottom panel
 * tracks the same preference as the rest of GNOME Shell / libadwaita.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DESKTOP_INTERFACE = 'org.gnome.desktop.interface';

/**
 * Returns true when the desktop prefers a dark appearance.
 *
 * @returns {boolean}
 */
export function isDarkTheme() {
    try {
        const settings = new Gio.Settings({schema_id: DESKTOP_INTERFACE});
        const scheme = settings.get_string('color-scheme');
        if (scheme === 'prefer-dark')
            return true;
        if (scheme === 'prefer-light')
            return false;
    } catch (_e) {
        // Fall through to stylesheet heuristic.
    }

    // Fallback: inspect the shell theme context.
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    const theme = themeContext.get_theme();
    if (!theme)
        return true;

    // Yaru / Adwaita dark stylesheets typically include "-dark" in a path.
    const paths = theme.get_custom_stylesheets?.() ?? [];
    return paths.some(uri => String(uri).includes('-dark'));
}

/**
 * Apply light/dark style classes on a panel actor.
 *
 * @param {St.Widget} actor
 */
export function applyThemeClasses(actor) {
    const dark = isDarkTheme();
    actor.remove_style_class_name('bottom-panel-light');
    actor.remove_style_class_name('bottom-panel-dark');
    actor.add_style_class_name(dark ? 'bottom-panel-dark' : 'bottom-panel-light');
}

/**
 * Watch color-scheme changes and invoke callback. Returns a disposer.
 *
 * @param {() => void} callback
 * @returns {() => void}
 */
export function watchColorScheme(callback) {
    let settings = null;
    let id = 0;

    try {
        settings = new Gio.Settings({schema_id: DESKTOP_INTERFACE});
        id = settings.connect('changed::color-scheme', callback);
    } catch (_e) {
        return () => {};
    }

    return () => {
        if (settings && id)
            settings.disconnect(id);
        settings = null;
        id = 0;
    };
}

/**
 * Build inline CSS for panel geometry / opacity so runtime settings
 * override stylesheet defaults without rewriting the CSS file.
 *
 * @param {{
 *   panelHeight: number,
 *   borderRadius: number,
 *   panelOpacity: number,
 *   panelSpacing: number,
 *   panelMargin: number,
 * }} options
 * @returns {string}
 */
export function buildPanelInlineStyle(options) {
    const dark = isDarkTheme();
    const bg = dark
        ? `rgba(32, 32, 32, ${options.panelOpacity})`
        : `rgba(245, 245, 245, ${options.panelOpacity})`;
    const border = dark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.08)';

    return [
        `height: ${options.panelHeight}px;`,
        `border-radius: ${options.borderRadius}px;`,
        `background-color: ${bg};`,
        `border: 1px solid ${border};`,
        `padding-left: ${options.panelSpacing}px;`,
        `padding-right: ${options.panelSpacing}px;`,
    ].join(' ');
}

/**
 * Attach a Shell.BlurEffect when available and requested.
 * Returns the effect instance (or null) so callers can remove it later.
 *
 * Limitation: Shell.BlurMode.BACKGROUND blurs whatever is behind the actor
 * in the stage paint order. On some NVIDIA / fractional-scale setups blur
 * can be expensive or visually incorrect; opacity-only fallback still works.
 *
 * @param {Clutter.Actor} actor
 * @param {boolean} enabled
 * @returns {Shell.BlurEffect|null}
 */
export function applyBlurEffect(actor, enabled) {
    // Remove any previous blur effect we may have attached.
    const existing = actor.get_effect?.('bottom-panel-blur');
    if (existing)
        actor.remove_effect(existing);

    if (!enabled)
        return null;

    if (!Shell.BlurEffect) {
        console.debug('Bottom Panel: Shell.BlurEffect unavailable');
        return null;
    }

    try {
        const effect = new Shell.BlurEffect({
            name: 'bottom-panel-blur',
            sigma: 36,
            brightness: 0.6,
            mode: Shell.BlurMode.ACTOR,
        });
        actor.add_effect(effect);
        return effect;
    } catch (e) {
        console.warn(`Bottom Panel: failed to create blur effect: ${e}`);
        return null;
    }
}

/**
 * Scale a logical pixel value by the monitor's scale factor.
 *
 * @param {number} logicalPx
 * @param {number} monitorIndex
 * @returns {number}
 */
export function scaleForMonitor(logicalPx, monitorIndex) {
    const scale = global.display.get_monitor_scale(monitorIndex);
    return Math.round(logicalPx * scale);
}

/**
 * Force the shell UI to restyle after theme switches.
 */
export function restyleShellChrome() {
    // Queuing a relayout is enough for St theme nodes to recompute.
    Main.layoutManager.uiGroup.queue_relayout();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        Main.panel?.queue_relayout();
        return GLib.SOURCE_REMOVE;
    });
}
