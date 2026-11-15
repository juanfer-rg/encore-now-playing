import GLib from 'gi://GLib';

import {distributePlainLyrics, findLineIndex} from '../lyrics/lrc.js';

const TICK_MS = 250;
const RESYNC_US = 5_000_000;
const LEAD_MS = 250;

/**
 * Follows the active player's lyrics for the top bar, even while the card
 * is closed: looks the lyrics up when the track changes, reads the position
 * every few seconds, advances it locally in between, and reports the
 * current line through `onLine(text)` ('' before the first line, null when
 * the track has no lyrics).
 *
 * It only works while enabled, and its timer only runs while the player
 * plays.
 */
export class PanelLyrics {
    constructor(provider, onLine) {
        this._provider = provider;
        this._onLine = onLine;
        this._enabled = false;
        this._player = null;
        this._trackKey = null;
        this._status = null;
        this._lines = null;
        this._index = -2;
        this._position = 0;
        this._t0 = 0;
        this._lastSync = 0;
        this._serial = 0;
        this._tickId = 0;
    }

    setEnabled(enabled) {
        if (enabled === this._enabled)
            return;
        this._enabled = enabled;
        this._trackKey = null;
        this.update(this._player);
    }

    /** Call when the active player changed or its state changed. */
    update(player) {
        this._player = player;
        if (!this._enabled || !player) {
            this._stop();
            this._lines = null;
            this._trackKey = null;
            return;
        }
        if (player.trackKey !== this._trackKey) {
            this._trackKey = player.trackKey;
            this._lines = null;
            this._index = -2;
            this._position = 0;
            this._t0 = GLib.get_monotonic_time();
            this._load(player);
            this._sync();
        } else if (player.status !== this._status) {
            // Paused or resumed: ask the player where it is.
            this._t0 = GLib.get_monotonic_time();
            this._sync();
        }
        this._status = player.status;
        this._updateTimer();
    }

    /** The player jumped (Seeked signal). */
    onSeeked(position) {
        this._position = position;
        this._t0 = GLib.get_monotonic_time();
        this._lastSync = this._t0;
        this._emitCurrent();
    }

    destroy() {
        this._stop();
        this._serial++;
        this._player = null;
        this._provider = null;
        this._onLine = null;
    }

    // ---- Internals -----------------------------------------------------------

    async _load(player) {
        const serial = ++this._serial;
        this._onLine?.(null);
        const lyrics = await this._provider?.lookup(player.metadata).catch(() => null);
        if (serial !== this._serial)
            return;
        if (lyrics?.synced.length)
            this._lines = lyrics.synced;
        else if (lyrics?.plain)
            this._lines = distributePlainLyrics(lyrics.plain, player.metadata.length / 1000);
        else
            this._lines = null;
        this._index = -2;
        this._emitCurrent();
        this._updateTimer();
    }

    async _sync() {
        const player = this._player;
        if (!player)
            return;
        const serial = this._serial;
        this._lastSync = GLib.get_monotonic_time();
        const position = await player.getPosition();
        if (serial !== this._serial || player !== this._player || position === null)
            return;
        this._position = position;
        this._t0 = GLib.get_monotonic_time();
        this._emitCurrent();
    }

    _currentPosition() {
        const elapsed = this._player?.isPlaying ? GLib.get_monotonic_time() - this._t0 : 0;
        return this._position + elapsed;
    }

    _emitCurrent() {
        if (!this._lines) {
            if (this._index !== -3) {
                this._index = -3;
                this._onLine?.(null);
            }
            return;
        }
        const index = findLineIndex(this._lines, this._currentPosition() / 1000 + LEAD_MS);
        if (index === this._index)
            return;
        this._index = index;
        this._onLine?.(index >= 0 ? this._lines[index].text : '');
    }

    _updateTimer() {
        const want = this._enabled && this._lines && this._player?.isPlaying;
        if (want && !this._tickId) {
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                if (GLib.get_monotonic_time() - this._lastSync > RESYNC_US)
                    this._sync();
                this._emitCurrent();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want) {
            this._stop();
        }
    }

    _stop() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }
}
