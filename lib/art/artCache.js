import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {extractPalette} from './palette.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const PRUNE_DELAY_S = 10;
const PALETTE_MEMO_SIZE = 64;
const PRIORITY = GLib.PRIORITY_DEFAULT;

export function artCacheDir() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'encore-now-playing', 'art']));
}

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function isNotFound(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

/**
 * Turns an mpris:artUrl into a local file.
 *
 *  - file:// is used as is
 *  - http(s):// is downloaded (at most 8 MB) into ~/.cache/encore-now-playing/art
 *  - data: URIs are decoded into the same cache
 *
 * The cache is trimmed to `art-cache-size-mb`, least recently used first.
 * All I/O is asynchronous; nothing blocks the compositor.
 */
export class ArtCache {
    constructor(settings) {
        this._settings = settings;
        this._dir = artCacheDir();
        this._dirReady = null;
        this._session = null;
        this._pending = new Map(); // url -> Promise<Gio.File|null>
        this._palettes = new Map(); // uri -> palette (insertion ordered)
        this._cancellable = new Gio.Cancellable();
        this._pruneId = 0;
        this._userAgent = 'Encore-Now-Playing-GNOME-Extension';
    }

    setUserAgent(userAgent) {
        this._userAgent = userAgent;
    }

    /**
     * @param {string} url
     * @returns {Promise<Gio.File|null>}
     */
    resolve(url) {
        if (!url)
            return Promise.resolve(null);
        if (url.startsWith('file://') || url.startsWith('/'))
            return Promise.resolve(url.startsWith('/') ? Gio.File.new_for_path(url) : Gio.File.new_for_uri(url));
        if (!/^(https?:|data:)/i.test(url))
            return Promise.resolve(null);

        let promise = this._pending.get(url);
        if (!promise) {
            promise = this._fetch(url)
                .catch(e => {
                    if (!isCancelled(e))
                        console.warn(`[Encore] album art ${url.slice(0, 80)}: ${e.message}`);
                    return null;
                })
                .finally(() => this._pending.delete(url));
            this._pending.set(url, promise);
        }
        return promise;
    }

    /**
     * Dominant colors of an image file, memoized by URI.
     *
     * @param {Gio.File} file
     * @returns {Promise<object|null>}
     */
    async palette(file) {
        const uri = file.get_uri();
        if (this._palettes.has(uri))
            return this._palettes.get(uri);

        let palette = null;
        try {
            const stream = await file.read_async(PRIORITY, this._cancellable);
            const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream, 32, 32, false, this._cancellable);
            stream.close_async(PRIORITY, null).catch(() => {});
            palette = extractPalette(pixbuf.get_pixels(), pixbuf.get_width(),
                pixbuf.get_height(), pixbuf.get_rowstride(), pixbuf.get_n_channels());
        } catch (e) {
            if (isCancelled(e))
                return null;
            console.debug(`[Encore] palette for ${uri}: ${e.message}`);
        }

        this._palettes.set(uri, palette);
        if (this._palettes.size > PALETTE_MEMO_SIZE)
            this._palettes.delete(this._palettes.keys().next().value);
        return palette;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._pruneId) {
            GLib.source_remove(this._pruneId);
            this._pruneId = 0;
        }
        this._session?.abort();
        this._session = null;
        this._pending.clear();
        this._palettes.clear();
        this._settings = null;
    }

    // ---- Internals ---------------------------------------------------------

    async _fetch(url) {
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const file = this._dir.get_child(key);

        if (await this._touchIfExists(file))
            return file;

        const bytes = url.startsWith('data:')
            ? this._decodeDataUri(url)
            : await this._download(url);
        if (!bytes)
            return null;

        await this._ensureDir();
        await file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
        this._schedulePrune();
        return file;
    }

    async _touchIfExists(file) {
        try {
            await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                PRIORITY, this._cancellable);
        } catch (e) {
            if (isNotFound(e))
                return false;
            throw e;
        }
        // Bump the modification time so pruning is least-recently-used.
        try {
            const info = new Gio.FileInfo();
            info.set_attribute_uint64('time::modified', Math.floor(Date.now() / 1000));
            await file.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE,
                PRIORITY, this._cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        return true;
    }

    _ensureDir() {
        this._dirReady ??= (async () => {
            for (const dir of [this._dir.get_parent(), this._dir]) {
                try {
                    await dir.make_directory_async(PRIORITY, this._cancellable);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                        throw e;
                }
            }
        })().catch(e => {
            this._dirReady = null;
            throw e;
        });
        return this._dirReady;
    }

    _decodeDataUri(url) {
        const match = /^data:(image\/[\w.+-]+)?(;base64)?,(.*)$/is.exec(url);
        if (!match || !match[2])
            return null;
        const data = GLib.base64_decode(match[3]);
        if (data.length === 0 || data.length > MAX_DOWNLOAD_BYTES)
            return null;
        return new GLib.Bytes(data);
    }

    async _download(url) {
        this._session ??= new Soup.Session({
            timeout: 20,
            user_agent: this._userAgent,
        });

        const message = Soup.Message.new('GET', url);
        if (!message)
            return null;

        const stream = await this._session.send_async(message, PRIORITY, this._cancellable);
        try {
            const status = message.get_status();
            if (status !== Soup.Status.OK)
                throw new Error(`HTTP ${status}`);

            const headers = message.get_response_headers();
            const type = headers.get_content_type()[0] ?? '';
            if (type && !type.startsWith('image/'))
                throw new Error(`not an image (${type})`);
            if (headers.get_content_length() > MAX_DOWNLOAD_BYTES)
                throw new Error('image too large');

            const chunks = [];
            let total = 0;
            for (;;) {
                const chunk = await stream.read_bytes_async(CHUNK_BYTES, PRIORITY, this._cancellable);
                const size = chunk.get_size();
                if (size === 0)
                    break;
                total += size;
                if (total > MAX_DOWNLOAD_BYTES)
                    throw new Error('image too large');
                chunks.push(chunk.toArray());
            }

            const data = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
            }
            return new GLib.Bytes(data);
        } finally {
            stream.close_async(PRIORITY, null).catch(() => {});
        }
    }

    _schedulePrune() {
        if (this._pruneId)
            return;
        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PRUNE_DELAY_S, () => {
            this._pruneId = 0;
            this._prune().catch(e => {
                if (!isCancelled(e))
                    console.warn(`[Encore] pruning art cache: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    async _prune() {
        const limit = (this._settings?.get_int('art-cache-size-mb') ?? 50) * 1024 * 1024;
        const entries = [];
        const enumerator = await this._dir.enumerate_children_async(
            'standard::name,standard::size,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, this._cancellable);
        try {
            for (;;) {
                const infos = await enumerator.next_files_async(64, PRIORITY, this._cancellable);
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    entries.push({
                        name: info.get_name(),
                        size: info.get_size(),
                        mtime: info.get_attribute_uint64('time::modified'),
                    });
                }
            }
        } finally {
            enumerator.close_async(PRIORITY, null).catch(() => {});
        }

        let total = entries.reduce((sum, e) => sum + e.size, 0);
        entries.sort((a, b) => a.mtime - b.mtime);
        for (const entry of entries) {
            if (total <= limit)
                break;
            await this._dir.get_child(entry.name).delete_async(PRIORITY, this._cancellable)
                .catch(() => {});
            total -= entry.size;
        }
    }
}
