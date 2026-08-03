/**
 * flags.js — Flat rectangular country-flag assets (no emoji / no wave).
 *
 * Primary assets are user-provided PNGs under flags/<iso>.png
 * (e.g. US/EN and IR). SVG is only a fallback for other countries.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** Layout / language id → ISO 3166-1 alpha-2 (lowercase file stem). */
export const LAYOUT_TO_COUNTRY = {
    fa: 'ir',
    ir: 'ir',
    us: 'us',
    usa: 'us',
    eng: 'us',
    en: 'us',
    gb: 'gb',
    uk: 'gb',
    de: 'de',
    fr: 'fr',
    es: 'es',
    it: 'it',
    ru: 'ru',
    tr: 'tr',
    ar: 'sa',
};

/**
 * @param {object} source — InputSource
 * @returns {string} lowercase ISO country code or ''
 */
export function sourceToCountry(source) {
    if (!source)
        return '';

    const candidates = [
        source.id,
        source.xkbId,
        source.shortName,
        source.displayName,
    ].filter(Boolean).map(s => String(s).toLowerCase());

    for (const raw of candidates) {
        const parts = raw.split(/[:.+_\-()\s/]/).filter(Boolean);
        for (const part of parts) {
            if (LAYOUT_TO_COUNTRY[part])
                return LAYOUT_TO_COUNTRY[part];
        }
    }

    const sn = String(source.shortName || '').toLowerCase();
    return LAYOUT_TO_COUNTRY[sn] ?? '';
}

/**
 * Absolute path to a bundled flag SVG, or null if missing.
 *
 * @param {string} extensionPath
 * @param {string} country — lowercase ISO
 * @returns {string|null}
 */
export function flagFilePath(extensionPath, country) {
    if (!extensionPath || !country)
        return null;
    const stem = country.toLowerCase();
    // Prefer PNG (reliable in St.Icon); fall back to SVG.
    for (const ext of ['png', 'svg']) {
        const path = GLib.build_filenamev([
            extensionPath, 'flags', `${stem}.${ext}`,
        ]);
        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return path;
    }
    return null;
}

/**
 * Build an St.Icon showing a flat rectangular flag.
 *
 * @param {string} extensionPath
 * @param {string} country
 * @param {number} [height=14]
 * @returns {St.Icon|null}
 */
export function createFlagIcon(extensionPath, country, height = 14) {
    const path = flagFilePath(extensionPath, country);
    if (!path)
        return null;

    const file = Gio.File.new_for_path(path);
    const gicon = new Gio.FileIcon({file});

    // 3:2 rectangle — width = height * 1.5
    const width = Math.round(height * 1.5);

    const icon = new St.Icon({
        gicon,
        style_class: 'bottom-panel-kb-flag-icon',
        // St.Icon uses square icon_size; we constrain via CSS bin instead.
        icon_size: Math.max(width, height),
    });

    return {icon, width, height};
}
