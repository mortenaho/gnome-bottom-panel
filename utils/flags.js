/**
 * Flat rectangular country-flag assets under flags/<iso>.png|.svg.
 */

import GLib from 'gi://GLib';

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
    for (const ext of ['png', 'svg']) {
        const path = GLib.build_filenamev([
            extensionPath, 'flags', `${stem}.${ext}`,
        ]);
        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return path;
    }
    return null;
}
