// Small helpers with no GNOME Shell dependencies, so they can be unit tested
// with plain gjs.

export const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

/**
 * Stable key for a player, used by the blocklist: the bus name without the
 * MPRIS prefix and without the per-instance suffix some players add
 * (e.g. "org.mpris.MediaPlayer2.firefox.instance_1_42" -> "firefox").
 *
 * @param {string} busName
 * @returns {string}
 */
export function playerKey(busName) {
    let key = busName.startsWith(MPRIS_PREFIX)
        ? busName.slice(MPRIS_PREFIX.length)
        : busName;
    key = key.replace(/\.instance[^.]*$/, '');
    return key.toLowerCase();
}

/**
 * Format microseconds as m:ss or h:mm:ss.
 *
 * @param {number} us
 * @returns {string}
 */
export function formatTime(us) {
    if (!Number.isFinite(us) || us < 0)
        us = 0;
    const total = Math.floor(us / 1_000_000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Quote a URI for use inside a CSS url("...") value.
 *
 * @param {string} uri
 * @returns {string}
 */
export function cssUrl(uri) {
    return `url("${uri.replace(/["\\\n\r]/g, c => `\\${c.charCodeAt(0).toString(16)} `)}")`;
}

/**
 * Join the non-empty parts with a separator.
 *
 * @param {string[]} parts
 * @param {string} sep
 * @returns {string}
 */
export function joinNonEmpty(parts, sep = ' · ') {
    return parts.filter(p => typeof p === 'string' && p.trim() !== '').join(sep);
}
