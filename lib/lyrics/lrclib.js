import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {localLyrics} from './local.js';
import {parseLrc} from './lrc.js';
import {isCancelled} from '../util.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const LRCLIB = 'https://lrclib.net/api';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';
const MEMO_SIZE = 80;
const MAX_BYTES = 1024 * 1024;
const MAX_DURATION_DIFF_S = 5;

/**
 * @typedef {object} Lyrics
 * @property {{time: number, text: string}[]} synced - empty when not synced
 * @property {string} plain - unsynced text, when there is no synced version
 * @property {boolean} instrumental
 * @property {string} source - 'player' | 'lrc-file' | 'tags' | 'lrclib' | 'lyrics.ovh'
 */

/**
 * Lyrics from, in order: the player (xesam:asText), local files (local.js),
 * and, only when online lookup is on, lrclib.net (exact match and search)
 * and lyrics.ovh queried in parallel. Synced beats plain, lrclib beats
 * lyrics.ovh. Online answers are memoized per track.
 */
export class LyricsProvider {
    constructor(settings, userAgent) {
        this._settings = settings;
        this._userAgent = userAgent;
        this._session = null;
        this._memo = new Map();
        this._inflight = new Map();
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

        const local = await localLyrics(metadata.url, this._cancellable);
        if (local)
            return local;

        if (!this.onlineEnabled || !metadata.title)
            return null;

        const artist = metadata.artists[0] ?? '';
        const seconds = Math.round(metadata.length / 1e6);
        const key = `${artist}\n${metadata.title}\n${metadata.album}\n${seconds}`;
        if (this._memo.has(key))
            return this._memo.get(key);
        if (this._inflight.has(key))
            return this._inflight.get(key);

        const promise = this._fetchAll(artist, metadata.title, metadata.album, seconds)
            .finally(() => this._inflight.delete(key));
        this._inflight.set(key, promise);
        const result = await promise;

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
        this._inflight.clear();
        this._settings = null;
    }

    async _fetchAll(artist, title, album, seconds) {
        const [exact, search, ovh] = await Promise.all([
            artist ? this._lrclibExact(artist, title, album, seconds) : null,
            this._lrclibSearch(artist, title, seconds),
            artist ? this._lyricsOvh(artist, title) : null,
        ].map(p => Promise.resolve(p).catch(() => null)));

        const lrclib = [exact, search].filter(Boolean);
        return lrclib.find(r => r.synced.length) ??
            lrclib.find(r => r.plain || r.instrumental) ??
            ovh ?? null;
    }

    async _lrclibExact(artist, title, album, seconds) {
        const params = {track_name: title, artist_name: artist};
        if (album)
            params.album_name = album;
        if (seconds > 0)
            params.duration = String(seconds);
        return this._fromLrclib(await this._request(`${LRCLIB}/get`, params));
    }

    async _lrclibSearch(artist, title, seconds) {
        const results = await this._request(`${LRCLIB}/search`, {q: `${title} ${artist}`.trim()});
        if (!Array.isArray(results) || results.length === 0)
            return null;

        // Synced first, then closest in duration; more than a few seconds
        // off is probably another recording.
        const usable = results.filter(r => r.syncedLyrics || r.plainLyrics);
        const distance = r => (seconds > 0 ? Math.abs((r.duration ?? 0) - seconds) : 0);
        usable.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || distance(a) - distance(b));
        const best = usable.find(r => seconds <= 0 || distance(r) <= MAX_DURATION_DIFF_S);
        return best ? this._fromLrclib(best) : null;
    }

    _fromLrclib(record) {
        if (!record || typeof record !== 'object' || Array.isArray(record))
            return null;
        const synced = parseLrc(record.syncedLyrics ?? '');
        const plain = synced.length ? '' : record.plainLyrics ?? '';
        if (!synced.length && !plain && !record.instrumental)
            return null;
        return {synced, plain, instrumental: !!record.instrumental, source: 'lrclib'};
    }

    async _lyricsOvh(artist, title) {
        const enc = s => GLib.Uri.escape_string(s.trim(), null, false);
        const data = await this._request(`${LYRICS_OVH}/${enc(artist)}/${enc(title)}`, {});
        const text = typeof data?.lyrics === 'string' ? data.lyrics.trim() : '';
        return text ? {synced: [], plain: text, instrumental: false, source: 'lyrics.ovh'} : null;
    }

    async _request(url, params) {
        this._session ??= new Soup.Session({timeout: 8, user_agent: this._userAgent});

        const query = Object.entries(params)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`)
            .join('&');
        const message = Soup.Message.new('GET', query ? `${url}?${query}` : url);
        message.get_request_headers().append('Accept', 'application/json');

        try {
            const bytes = await this._session.send_and_read_async(message,
                GLib.PRIORITY_DEFAULT, this._cancellable);
            if (message.get_status() !== Soup.Status.OK || bytes.get_size() > MAX_BYTES)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`[Encore] lyrics ${url}: ${e.message}`);
            return null;
        }
    }
}
