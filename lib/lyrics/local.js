import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readEmbeddedLyrics} from './embedded.js';
import {parseLrc} from './lrc.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'skip_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const MAX_LRC_BYTES = 512 * 1024;
const PRIORITY = GLib.PRIORITY_DEFAULT;

/** A {read, skip} source over a Gio input stream, all asynchronous. */
function streamSource(stream, cancellable) {
    return {
        async read(n) {
            const out = new Uint8Array(n);
            let got = 0;
            while (got < n) {
                const bytes = await stream.read_bytes_async(n - got, PRIORITY, cancellable);
                const size = bytes.get_size();
                if (size === 0)
                    break;
                out.set(bytes.toArray(), got);
                got += size;
            }
            return out.subarray(0, got);
        },
        async skip(n) {
            let left = n;
            while (left > 0) {
                const skipped = await stream.skip_async(left, PRIORITY, cancellable);
                if (skipped <= 0)
                    break;
                left -= skipped;
            }
        },
    };
}

async function embedded(file, cancellable) {
    let stream = null;
    try {
        stream = await file.read_async(PRIORITY, cancellable);
        return await readEmbeddedLyrics(streamSource(stream, cancellable));
    } catch {
        return null;
    } finally {
        stream?.close_async(PRIORITY, null).catch(() => {});
    }
}

async function sidecar(file, cancellable) {
    const name = file.get_basename();
    const dir = file.get_parent();
    if (!name || !dir)
        return null;
    const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    for (const candidate of [`${stem}.lrc`, `${stem}.LRC`]) {
        const lrc = dir.get_child(candidate);
        try {
            const info = await lrc.query_info_async('standard::size',
                Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
            if (info.get_size() > MAX_LRC_BYTES)
                continue;
            const [bytes] = await lrc.load_contents_async(cancellable);
            const text = new TextDecoder().decode(bytes).trim();
            const synced = parseLrc(text);
            if (synced.length || text)
                return {synced, plain: synced.length ? '' : text};
        } catch {
            // Not there or not readable: try the next name.
        }
    }
    return null;
}

/**
 * Lyrics for a local track: a "<name>.lrc" file beside it, or lyrics
 * embedded in the file's tags (MP3 ID3, FLAC Vorbis comments). Synced
 * lyrics win; the .lrc file wins between two of the same kind.
 *
 * @param {string} url - xesam:url of the track
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<{synced: object[], plain: string, instrumental: boolean, source: string}|null>}
 */
export async function localLyrics(url, cancellable) {
    if (!url?.startsWith('file://'))
        return null;
    const file = Gio.File.new_for_uri(url);
    const [fromLrc, fromTags] = await Promise.all([
        sidecar(file, cancellable),
        embedded(file, cancellable),
    ]);
    const pick = [fromLrc, fromTags].find(l => l?.synced.length) ??
        [fromLrc, fromTags].find(l => l?.plain) ?? null;
    if (!pick)
        return null;
    return {...pick, instrumental: false, source: pick === fromLrc ? 'lrc-file' : 'tags'};
}
