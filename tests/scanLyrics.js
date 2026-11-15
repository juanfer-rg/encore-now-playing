#!/usr/bin/env -S gjs -m
// Development tool: check the embedded-lyrics reader against a music folder.
//
//   gjs -m tests/scanLyrics.js DIR [LIMIT] [--verbose]
//
// For a sample of MP3/FLAC files it compares a raw search of the tag area
// (does it contain USLT/SYLT/LYRICS at all?) with what the reader extracts,
// and lists the files where they disagree. Nothing is modified.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {localLyrics} from '../lib/lyrics/local.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const args = ARGV.filter(a => !a.startsWith('--'));
const verbose = ARGV.includes('--verbose');
const [dir, limitArg] = args;
if (!dir) {
    printerr('usage: gjs -m tests/scanLyrics.js DIR [LIMIT] [--verbose]');
    imports.system.exit(2);
}
const limit = Number(limitArg ?? 2000);

async function collect(root) {
    const files = [];
    const queue = [Gio.File.new_for_path(root)];
    while (queue.length) {
        const d = queue.shift();
        let en;
        try {
            en = await d.enumerate_children_async('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        } catch {
            continue;
        }
        for (;;) {
            const infos = await en.next_files_async(200, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            for (const info of infos) {
                const child = d.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    queue.push(child);
                else if (/\.(mp3|flac)$/i.test(info.get_name()))
                    files.push(child);
            }
        }
    }
    return files;
}

// Raw check: does the first 2 MB (enough for most tags) contain a lyrics
// frame id or comment name? A plain byte search, no text decoding.
const MARKERS = ['USLT', 'SYLT', 'LYRICS=', 'UNSYNCEDLYRICS=', 'UNSYNCED LYRICS=',
    'lyrics=', 'unsyncedlyrics='].map(m => Uint8Array.from(m, c => c.charCodeAt(0)));

function contains(bytes, needle) {
    const first = needle[0];
    for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
        let j = 1;
        while (j < needle.length && bytes[i + j] === needle[j])
            j++;
        if (j === needle.length)
            return true;
    }
    return false;
}

async function rawHasLyrics(file) {
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, null);
    const bytes = (await stream.read_bytes_async(2 * 1024 * 1024, GLib.PRIORITY_DEFAULT, null)).toArray();
    stream.close(null);
    return MARKERS.some(m => contains(bytes, m));
}

const all = await collect(dir);
// A spread-out sample: every n-th file, so all artists are represented.
const step = Math.max(1, Math.floor(all.length / limit));
const sample = all.filter((_, i) => i % step === 0).slice(0, limit);

const stats = {files: 0, raw: 0, found: 0, synced: 0, plain: 0, bySource: {}, misses: [], errors: 0};
const t0 = GLib.get_monotonic_time();
for (const file of sample) {
    stats.files++;
    let raw = false, result = null;
    try {
        raw = await rawHasLyrics(file);
        result = await localLyrics(file.get_uri(), null);
    } catch (e) {
        stats.errors++;
        if (verbose)
            print(`ERROR ${file.get_path()}: ${e.message}`);
        continue;
    }
    if (raw)
        stats.raw++;
    if (result) {
        stats.found++;
        stats[result.synced.length ? 'synced' : 'plain']++;
        stats.bySource[result.source] = (stats.bySource[result.source] ?? 0) + 1;
    } else if (raw) {
        stats.misses.push(file.get_path());
    }
}
const seconds = (GLib.get_monotonic_time() - t0) / 1e6;

print(`scanned ${stats.files} of ${all.length} files in ${seconds.toFixed(1)} s`);
print(`raw lyrics markers: ${stats.raw}   extracted: ${stats.found} (synced ${stats.synced}, plain ${stats.plain})`);
print(`by source: ${JSON.stringify(stats.bySource)}   errors: ${stats.errors}`);
print(`marker but nothing extracted: ${stats.misses.length}`);
for (const m of stats.misses.slice(0, verbose ? 200 : 15))
    print(`  ${m}`);
