/**
 * Light/dark adaptation and panel visual styling.
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
 * Parse #RRGGBB into RGB components, or null if invalid.
 *
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}|null}
 */
export function parseHexColor(hex) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? '').trim());
    if (!match)
        return null;
    const n = parseInt(match[1], 16);
    return {
        r: (n >> 16) & 255,
        g: (n >> 8) & 255,
        b: n & 255,
    };
}

/**
 * Relative luminance heuristic for choosing light vs dark chrome (text/icons).
 *
 * @param {string} hex
 * @returns {boolean}
 */
export function isHexColorDark(hex) {
    const rgb = parseHexColor(hex);
    if (!rgb)
        return isDarkTheme();
    // Rec. 709 luma
    const luma = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luma < 0.5;
}

/**
 * Apply light/dark style classes on a panel actor.
 * When a custom panel color is active, chrome contrast follows that color.
 *
 * @param {St.Widget} actor
 * @param {{useCustomPanelColor?: boolean, panelColor?: string}} [options]
 */
export function applyThemeClasses(actor, options = {}) {
    const dark = options.useCustomPanelColor && options.panelColor
        ? isHexColorDark(options.panelColor)
        : isDarkTheme();
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
 * Shared panel chrome colors (background + border) from user settings /
 * light-dark preference. Used by the dock and floating surfaces (flyouts).
 *
 * @param {{
 *   panelOpacity: number,
 *   useCustomPanelColor?: boolean,
 *   panelColor?: string,
 * }} options
 * @returns {{bg: string, border: string, dark: boolean}}
 */
export function getPanelChromeColors(options) {
    const customRgb = options.useCustomPanelColor
        ? parseHexColor(options.panelColor)
        : null;
    const dark = customRgb
        ? isHexColorDark(options.panelColor)
        : isDarkTheme();

    let bg;
    if (customRgb) {
        bg = `rgba(${customRgb.r}, ${customRgb.g}, ${customRgb.b}, ${options.panelOpacity})`;
    } else {
        bg = dark
            ? `rgba(32, 32, 32, ${options.panelOpacity})`
            : `rgba(243, 243, 243, ${options.panelOpacity})`;
    }

    const border = dark
        ? 'rgba(255, 255, 255, 0.06)'
        : 'rgba(0, 0, 0, 0.08)';

    return {bg, border, dark};
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
 *   useCustomPanelColor?: boolean,
 *   panelColor?: string,
 * }} options
 * @returns {string}
 */
export function buildPanelInlineStyle(options) {
    const {bg, border} = getPanelChromeColors(options);
    const radius = options.borderRadius;
    return [
        `height: ${options.panelHeight}px;`,
        `border-radius: ${radius}px;`,
        `background-color: ${bg};`,
        radius > 0 ? `border: 1px solid ${border};` : `border-top: 1px solid ${border};`,
        `padding-left: ${options.panelSpacing}px;`,
        `padding-right: ${options.panelSpacing}px;`,
    ].join(' ');
}

/**
 * Inline style for floating chrome (tray overflow flyout, etc.).
 * Matches panel color / opacity / border; geometry stays flyout-specific.
 *
 * `minOpacity` floors panel opacity so tray icons stay readable when the
 * dock itself is nearly transparent.
 *
 * @param {{
 *   panelOpacity: number,
 *   useCustomPanelColor?: boolean,
 *   panelColor?: string,
 * }} options
 * @param {{padding?: string, borderRadius?: number, minOpacity?: number}} [chrome]
 * @returns {string}
 */
export function buildFloatingChromeStyle(options, chrome = {}) {
    const minOpacity = Math.max(0, Math.min(1, chrome.minOpacity ?? 0));
    const opacity = Math.max(minOpacity, Number(options.panelOpacity) || 0);
    const {bg, border} = getPanelChromeColors({...options, panelOpacity: opacity});
    const padding = chrome.padding ?? '8px 10px';
    const radius = chrome.borderRadius ?? 10;
    return [
        `padding: ${padding};`,
        `border-radius: ${radius}px;`,
        `background-color: ${bg};`,
        `border: 1px solid ${border};`,
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
    const existing = actor.get_effect?.('bottom-panel-blur');
    if (existing)
        actor.remove_effect(existing);

    if (!enabled)
        return null;

    if (!Shell.BlurEffect)
        return null;

    try {
        // GNOME 50 uses "radius" (not "sigma"). Prefer BACKGROUND for mica;
        // fall back to ACTOR if BACKGROUND is missing.
        const mode = (Shell.BlurMode && 'BACKGROUND' in Shell.BlurMode)
            ? Shell.BlurMode.BACKGROUND
            : Shell.BlurMode.ACTOR;

        const effect = new Shell.BlurEffect({
            name: 'bottom-panel-blur',
            mode,
            radius: 30,
            brightness: 0.65,
        });
        actor.add_effect(effect);
        return effect;
    } catch (e) {
        // Blur is optional — opacity styling still applies.
        console.debug(`Bottom Panel: blur unavailable (${e.message})`);
        return null;
    }
}

/**
 * Vertical CSS padding on `.bottom-panel-app-icon` (top + bottom).
 * Icons must leave at least this much room inside the panel height.
 */
export const TASKBAR_ICON_PAD = 8;

/**
 * Scale a logical pixel value by the monitor's scale factor.
 *
 * Prefer logical pixels for Clutter/St layout when Mutter uses
 * `scale-monitor-framebuffer` (stage coords are already logical).
 * Use this only for APIs that still expect device pixels.
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
 * Keep taskbar icons square inside the panel: never taller than the dock.
 *
 * @param {number} iconSize
 * @param {number} panelHeight
 * @returns {number}
 */
export function fitIconSize(iconSize, panelHeight) {
    const size = Math.max(16, Math.round(Number(iconSize) || 32));
    const height = Math.max(32, Math.round(Number(panelHeight) || 48));
    return Math.min(size, Math.max(16, height - TASKBAR_ICON_PAD));
}

/**
 * Panel height that can host `iconSize` without squashing icons.
 *
 * @param {number} panelHeight
 * @param {number} iconSize
 * @returns {number}
 */
export function fitPanelHeight(panelHeight, iconSize) {
    const height = Math.max(32, Math.round(Number(panelHeight) || 48));
    const size = Math.max(16, Math.round(Number(iconSize) || 32));
    return Math.max(height, size + TASKBAR_ICON_PAD);
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
