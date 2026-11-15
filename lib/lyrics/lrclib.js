import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {parseLrc} from './lrc.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const API = 'https://lrclib.net/api';
const MEMO_SIZE = 50;
const MAX_BYTES = 1024 * 1024;

/**
 * @typedef {object} Lyrics
 * @property {{time: number, text: string}[]} synced - empty when not synced
 * @property {string} plain
 * @property {boolean} instrumental
 * @property {string} source - 'player' | 'lrclib'
 */

/**
 * Finds lyrics for a track: first from the player itself (xesam:asText),
 * then, only when the user enabled it, from lrclib.net.
 */
export class LyricsProvider {
    constructor(settings, userAgent) {
        this._settings = settings;
        this._userAgent = userAgent;
        this._session = null;
        this._memo = new Map();
        this._cancellable = new Gio.Cancellable();
    }

    get onlineEnabled() {
        return this._settings?.get_boolean('lyrics-online-lookup') ?? false;
    }

    /**
     * @param {object} metadata - MprisPlayer.metadata
     * @returns {Promise<Lyrics|null>}
     */
    async lookup(metadata) {
        if (metadata.lyrics) {
            const synced = parseLrc(metadata.lyrics);
            return {
                synced,
                plain: synced.length ? '' : metadata.lyrics,
                instrumental: false,
                source: 'player',
            };
        }

        if (!this.onlineEnabled || !metadata.title)
            return null;

        const artist = metadata.artists[0] ?? '';
        const key = `${artist}\n${metadata.title}\n${metadata.album}\n${Math.round(metadata.length / 1e6)}`;
        if (this._memo.has(key))
            return this._memo.get(key);

        const result = await this._fetch(artist, metadata.title, metadata.album, metadata.length);
        this._memo.set(key, result);
        if (this._memo.size > MEMO_SIZE)
            this._memo.delete(this._memo.keys().next().value);
        return result;
    }

    destroy() {
        this._cancellable.cancel();
        this._session?.abort();
        this._session = null;
        this._memo.clear();
        this._settings = null;
    }

    async _fetch(artist, title, album, lengthUs) {
        const exact = {
            track_name: title,
            artist_name: artist,
        };
        if (album)
            exact.album_name = album;
        if (lengthUs > 0)
            exact.duration = String(Math.round(lengthUs / 1e6));

        // The exact endpoint needs all fields to match; fall back to search.
        let record = artist ? await this._request('/get', exact) : null;
        if (!record) {
            const results = await this._request('/search', {track_name: title, artist_name: artist});
            if (Array.isArray(results))
                record = results.find(r => r.syncedLyrics) ?? results.find(r => r.plainLyrics) ?? null;
        }
        if (!record)
            return null;

        return {
            synced: parseLrc(record.syncedLyrics ?? ''),
            plain: record.plainLyrics ?? '',
            instrumental: !!record.instrumental,
            source: 'lrclib',
        };
    }

    async _request(path, params) {
        this._session ??= new Soup.Session({timeout: 15, user_agent: this._userAgent});

        const query = Object.entries(params)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`)
            .join('&');
        const message = Soup.Message.new('GET', `${API}${path}?${query}`);

        try {
            const bytes = await this._session.send_and_read_async(message,
                GLib.PRIORITY_DEFAULT, this._cancellable);
            if (message.get_status() !== Soup.Status.OK || bytes.get_size() > MAX_BYTES)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                console.debug(`[Encore] lrclib ${path}: ${e.message}`);
            return null;
        }
    }
}
