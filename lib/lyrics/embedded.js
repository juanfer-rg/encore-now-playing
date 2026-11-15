// Lyrics embedded in audio files, read straight from their tags:
//
//  - MP3 (ID3v2.2/2.3/2.4): USLT (plain) and SYLT (synced) frames
//  - FLAC: Vorbis comments LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS
//
// Only the tag area at the start of the file is read, and big parts such as
// the cover picture are skipped, never loaded. The parsing works on a small
// `source` interface ({read(n), skip(n)}), so it is unit tested with an
// in-memory source and runs on a Gio stream inside the Shell.

import {parseLrc} from './lrc.js';

const MAX_FRAME = 1024 * 1024; // a lyrics frame bigger than 1 MB is not lyrics
const MAX_TAG = 32 * 1024 * 1024; // only read whole tags when they must be de-unsynchronised

function latin1(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4096)
        out += String.fromCharCode(...bytes.subarray(i, i + 4096));
    return out;
}

function utf16(bytes, bigEndian) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2)
        out += String.fromCharCode(bigEndian ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8));
    return out;
}

/** Decode ID3 text in one of its four encodings. */
export function decodeId3Text(bytes, encoding) {
    switch (encoding) {
    case 0:
        return latin1(bytes);
    case 1: { // UTF-16 with BOM
        if (bytes[0] === 0xFE && bytes[1] === 0xFF)
            return utf16(bytes.subarray(2), true);
        if (bytes[0] === 0xFF && bytes[1] === 0xFE)
            return utf16(bytes.subarray(2), false);
        return utf16(bytes, false);
    }
    case 2:
        return utf16(bytes, true);
    default:
        return new TextDecoder().decode(bytes);
    }
}

/** Index just past a terminator ($00, or $00 00 aligned for UTF-16) from `start`. */
function skipTerminated(bytes, start, encoding) {
    const wide = encoding === 1 || encoding === 2;
    for (let i = start; i < bytes.length; i += wide ? 2 : 1) {
        if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0))
            return {end: i, next: i + (wide ? 2 : 1)};
    }
    return {end: bytes.length, next: bytes.length};
}

const clean = text => text.replace(/\0+$/, '').replace(/\r\n?/g, '\n').trim();

/** Body of a USLT frame → text. */
export function parseUslt(body) {
    const encoding = body[0];
    // encoding (1), language (3), content descriptor (terminated), text
    const {next} = skipTerminated(body, 4, encoding);
    return clean(decodeId3Text(body.subarray(next), encoding));
}

/** Body of a SYLT frame → timed lines (only when timestamps are in ms). */
export function parseSylt(body) {
    const encoding = body[0];
    const format = body[4]; // 1: MPEG frames, 2: milliseconds
    if (format !== 2)
        return [];
    let pos = skipTerminated(body, 6, encoding).next;
    const lines = [];
    while (pos < body.length) {
        const {end, next} = skipTerminated(body, pos, encoding);
        if (next + 4 > body.length)
            break;
        const text = clean(decodeId3Text(body.subarray(pos, end), encoding));
        const time = ((body[next] << 24) | (body[next + 1] << 16) | (body[next + 2] << 8) | body[next + 3]) >>> 0;
        lines.push({time, text: text.replace(/^\n+/, '')});
        pos = next + 4;
    }
    return lines.filter(l => l.text !== '').sort((a, b) => a.time - b.time);
}

/** Vorbis comment block (FLAC metadata type 4) → lyrics text, if any. */
export function parseVorbisComments(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let pos = 0;
    const u32 = () => {
        const v = view.getUint32(pos, true);
        pos += 4;
        return v;
    };
    const vendorLength = u32();
    pos += vendorLength; // vendor string
    const count = u32();
    const found = {};
    for (let i = 0; i < count && pos + 4 <= body.length; i++) {
        const len = u32();
        const comment = new TextDecoder().decode(body.subarray(pos, pos + len));
        pos += len;
        const eq = comment.indexOf('=');
        if (eq > 0)
            found[comment.slice(0, eq).toUpperCase()] = comment.slice(eq + 1);
    }
    return clean(found.SYNCEDLYRICS ?? found.LYRICS ?? found.UNSYNCEDLYRICS ??
        found['UNSYNCED LYRICS'] ?? '');
}

const syncsafe = b => (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3];
const be32 = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
const be24 = b => (b[0] << 16) | (b[1] << 8) | b[2];

/** Undo ID3 unsynchronisation ($FF 00 → $FF). */
function deunsync(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
        out.push(bytes[i]);
        if (bytes[i] === 0xFF && bytes[i + 1] === 0x00)
            i++;
    }
    return Uint8Array.from(out);
}

function memorySource(bytes) {
    let pos = 0;
    return {
        read: n => {
            const chunk = bytes.subarray(pos, pos + n);
            pos += chunk.length;
            return Promise.resolve(chunk);
        },
        skip: n => {
            pos += n;
            return Promise.resolve();
        },
    };
}

function toLyrics(text, synced = []) {
    if (synced.length)
        return {synced, plain: ''};
    if (!text)
        return null;
    // Some taggers store LRC text in the plain fields.
    const lrc = parseLrc(text);
    return lrc.length ? {synced: lrc, plain: ''} : {synced: [], plain: text};
}

async function readId3(source, header) {
    const major = header[3];
    const flags = header[5];
    const size = syncsafe(header.subarray(6, 10));

    if (flags & 0x80 && major < 4) {
        // Unsynchronised tag: frame sizes refer to the decoded data, so read
        // it whole (bounded) and parse from memory.
        if (size > MAX_TAG)
            return null;
        const tag = deunsync(await source.read(size));
        return readId3Frames(memorySource(tag), major, tag.length, 0);
    }
    return readId3Frames(source, major, size, flags);
}

async function readId3Frames(source, major, size, flags) {
    let remaining = size;
    if (flags & 0x40) { // extended header
        const ext = await source.read(4);
        const extSize = major >= 4 ? syncsafe(ext) - 4 : be32(ext);
        await source.skip(extSize);
        remaining -= 4 + extSize;
    }

    const headerSize = major === 2 ? 6 : 10;
    // Frame ids are meant to be [A-Z0-9], but taggers also write ids such
    // as "CM1 " with spaces; the size checks catch real garbage.
    const validId = h => /^[A-Z0-9][A-Z0-9 ]{2,3}$/.test(latin1(h.subarray(0, major === 2 ? 3 : 4)));
    // ID3v2.4 frame sizes should be syncsafe, but some taggers (MusicMatch,
    // old iTunes) write plain v2.3-style sizes. Which one a tag uses is
    // decided at the first frame where they differ.
    let sizes = major >= 4 ? 'unknown' : 'plain';
    let plain = '';
    let synced = [];
    let fh = remaining >= headerSize ? await source.read(headerSize) : null;
    while (fh && fh.length === headerSize && remaining >= headerSize) {
        if (fh[0] === 0 || !validId(fh)) {
            // Padding or garbage: skip to the end of the tag.
            await source.skip(Math.max(remaining - headerSize, 0));
            remaining = 0;
            break;
        }
        const id = latin1(fh.subarray(0, major === 2 ? 3 : 4));
        const plainSize = major === 2 ? be24(fh.subarray(3, 6)) : be32(fh.subarray(4, 8));
        const safeSize = major >= 4 ? syncsafe(fh.subarray(4, 8)) : plainSize;
        if (major >= 4 && fh.subarray(4, 8).some(b => b & 0x80))
            sizes = 'plain'; // cannot be syncsafe
        const frameSize = sizes === 'plain' ? plainSize : safeSize;
        if (frameSize > remaining - headerSize) {
            await source.skip(Math.max(remaining - headerSize, 0));
            remaining = 0;
            break;
        }
        const formatFlags = major >= 3 ? fh[9] : 0;
        const wanted = ['USLT', 'SYLT', 'ULT', 'SLT'].includes(id) && frameSize <= MAX_FRAME;

        let body = null;
        if (wanted)
            body = await source.read(frameSize);
        else
            await source.skip(frameSize);
        remaining -= headerSize + frameSize;
        fh = remaining >= headerSize ? await source.read(headerSize) : null;

        if (sizes === 'unknown' && safeSize !== plainSize && fh) {
            const extra = plainSize - safeSize - headerSize;
            if (!validId(fh) && fh[0] !== 0 && extra >= 0 && extra <= remaining - headerSize) {
                // The syncsafe reading lands mid-frame: this tag uses plain sizes.
                sizes = 'plain';
                if (body) {
                    const whole = new Uint8Array(plainSize);
                    whole.set(body);
                    whole.set(fh, safeSize);
                    whole.set(await source.read(extra), safeSize + headerSize);
                    body = whole;
                } else {
                    await source.skip(extra);
                }
                remaining -= plainSize - safeSize;
                fh = remaining >= headerSize ? await source.read(headerSize) : null;
            } else if (validId(fh)) {
                sizes = 'syncsafe';
            }
        }

        if (!body || body.length === 0)
            continue;
        if (major >= 4 && formatFlags & 0x02)
            body = deunsync(body);
        if (major >= 4 && formatFlags & 0x01)
            body = body.subarray(4); // data length indicator
        if (id === 'SYLT' || id === 'SLT')
            synced = synced.length ? synced : parseSylt(body);
        else
            plain = plain || parseUslt(body);
    }
    if (fh && fh.length === headerSize && remaining >= headerSize)
        remaining -= headerSize; // a header we read but did not use
    if (remaining > 0)
        await source.skip(remaining);
    if (flags & 0x10) // footer
        await source.skip(10);
    return toLyrics(plain, synced);
}

async function readFlac(source) {
    for (;;) {
        const header = await source.read(4);
        if (header.length < 4)
            return null;
        const last = header[0] & 0x80;
        const type = header[0] & 0x7F;
        const length = be24(header.subarray(1, 4));
        if (type === 4 && length <= MAX_FRAME * 4)
            return toLyrics(parseVorbisComments(await source.read(length)));
        await source.skip(length);
        if (last)
            return null;
    }
}

/**
 * Lyrics embedded in an MP3 or FLAC file.
 *
 * @param {{read: function(number): Promise<Uint8Array>, skip: function(number): Promise<void>}} source
 * @returns {Promise<{synced: object[], plain: string}|null>}
 */
export async function readEmbeddedLyrics(source) {
    const head = await source.read(4);
    if (latin1(head.subarray(0, 4)) === 'fLaC')
        return readFlac(source);
    // Some files carry several ID3 tags back to back (re-tagged files), and
    // FLAC files sometimes have one in front of the stream.
    let marker = head;
    for (let i = 0; i < 4 && latin1(marker.subarray(0, 3)) === 'ID3'; i++) {
        const header = new Uint8Array(10);
        header.set(marker);
        header.set(await source.read(6), 4);
        const id3 = await readId3(source, header);
        if (id3)
            return id3;
        marker = await source.read(4);
    }
    return latin1(marker) === 'fLaC' ? readFlac(source) : null;
}

/** For tests: read lyrics from a whole file held in memory. */
export function readEmbeddedLyricsFromBytes(bytes) {
    return readEmbeddedLyrics(memorySource(bytes));
}
