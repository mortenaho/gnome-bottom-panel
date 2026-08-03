/**
 * settings.js — Typed accessors and change helpers for the extension schema.
 *
 * Centralizes GSettings reads so panel and widget code stays free of
 * duplicated key strings and can subscribe to changes with one helper.
 */

import Gio from 'gi://Gio';

/** @type {Gio.Settings|null} */
let _settings = null;

const LED_PRESETS = {
    red: '#ff3b30',
    green: '#34c759',
    blue: '#0a84ff',
    amber: '#ff9f0a',
    white: '#ffffff',
};

/**
 * @param {string} value
 * @returns {string} `#rrggbb`
 */
function normalizeClockLedColor(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (LED_PRESETS[raw])
        return LED_PRESETS[raw];
    if (/^#[0-9a-f]{6}$/.test(raw))
        return raw;
    if (/^#[0-9a-f]{3}$/.test(raw))
        return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    return LED_PRESETS.red;
}

/**
 * Initialize the module-level settings handle.
 *
 * @param {Gio.Settings} settings
 */
export function initSettings(settings) {
    _settings = settings;
}

/**
 * Clear the module-level settings handle (call from Extension.disable).
 */
export function clearSettings() {
    _settings = null;
}

/**
 * @returns {Gio.Settings}
 */
export function getSettings() {
    if (!_settings)
        throw new Error('Bottom Panel: settings not initialized');
    return _settings;
}

/**
 * Subscribe to one or more keys. Returns a disconnect callback.
 *
 * @param {string|string[]} keys
 * @param {() => void} callback
 * @returns {() => void}
 */
export function onSettingsChanged(keys, callback) {
    const settings = getSettings();
    const keyList = Array.isArray(keys) ? keys : [keys];
    const ids = keyList.map(key =>
        settings.connect(`changed::${key}`, callback));

    return () => {
        for (const id of ids)
            settings.disconnect(id);
    };
}

/**
 * Snapshot of visual / layout settings used by BottomPanel.
 *
 * @returns {object}
 */
export function getPanelOptions() {
    const s = getSettings();
    return {
        panelHeight: s.get_int('panel-height'),
        iconSize: s.get_int('icon-size'),
        trayIconSize: s.get_int('tray-icon-size'),
        panelItemOrder: s.get_strv('panel-item-order'),
        panelSpacing: s.get_int('panel-spacing'),
        panelMargin: s.get_int('panel-margin'),
        borderRadius: s.get_int('border-radius'),
        panelOpacity: s.get_double('panel-opacity'),
        useCustomPanelColor: s.get_boolean('use-custom-panel-color'),
        panelColor: s.get_string('panel-color'),
        enableBlur: s.get_boolean('enable-blur'),
        showFavorites: s.get_boolean('show-favorites'),
        showRunningApps: s.get_boolean('show-running-apps'),
        showShowAppsButton: s.get_boolean('show-show-apps-button'),
        appsButtonIcon: s.get_string('apps-button-icon') || 'view-app-grid-symbolic',
        taskbarDirection: s.get_string('taskbar-direction'),
        taskbarAlignment: s.get_string('taskbar-alignment'),
        showWorkspaces: s.get_boolean('show-workspaces'),
        showClock: s.get_boolean('show-clock'),
        clockPosition: s.get_string('clock-position'),
        clockStyle: s.get_string('clock-style'),
        clockFormat: s.get_string('clock-format'),
        clockColonBlink: s.get_boolean('clock-colon-blink'),
        clockLedColor: normalizeClockLedColor(s.get_string('clock-led-color')),
        clockSegmentThickness: s.get_int('clock-segment-thickness'),
        clockHourFormat: s.get_string('clock-hour-format'),
        showSystemIndicators: s.get_boolean('show-system-indicators'),
        multiMonitor: s.get_boolean('multi-monitor'),
        isolateMonitors: s.get_boolean('isolate-monitors'),
        isolateWorkspaces: s.get_boolean('isolate-workspaces'),
        hideOverviewDash: s.get_boolean('hide-overview-dash'),
        animateStartup: s.get_boolean('animate-startup'),
        scrollPanelWorkspaces: s.get_boolean('scroll-panel-workspaces'),
        showKeyboardLayout: s.get_boolean('show-keyboard-layout'),
        keyboardDisplayMode: s.get_string('keyboard-display-mode'),
    };
}
