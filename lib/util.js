// Small helpers with no GNOME Shell dependencies, so they can be unit tested
// with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

// Microseconds as m:ss or h:mm:ss.
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

// A URI inside a CSS url("..."), with quotes, backslashes and newlines
// written as CSS hex escapes.
export function cssUrl(uri) {
    return `url("${uri.replace(/["\\\n\r]/g, c => `\\${c.charCodeAt(0).toString(16)} `)}")`;
}

export function joinNonEmpty(parts, sep = ' · ') {
    return parts.filter(p => typeof p === 'string' && p.trim() !== '').join(sep);
}

export function isIoError(e, code) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);
}

export function isCancelled(e) {
    return isIoError(e, Gio.IOErrorEnum.CANCELLED);
}
