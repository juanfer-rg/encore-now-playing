import {decodeId3Text, readEmbeddedLyricsFromBytes} from '../lib/lyrics/embedded.js';
import {assert, assertEqual, done, test} from './harness.js';

// ---- Byte builders ------------------------------------------------------------

const ascii = s => Array.from(s, c => c.charCodeAt(0));
const utf8 = s => Array.from(new TextEncoder().encode(s));
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = n => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const utf16le = s => [0xFF, 0xFE, ...Array.from(s).flatMap(c => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])];

function id3(major, frames) {
    const body = frames.flat();
    return [...ascii('ID3'), major, 0, 0, ...syncsafe(body.length + 32), ...body, ...new Array(32).fill(0)];
}

function frame(major, id, body) {
    const size = major >= 4 ? syncsafe(body.length) : be32(body.length);
    return [...ascii(id), ...size, 0, 0, ...body];
}

// A fake cover big enough to make sure it is skipped, not parsed.
const apic = major => frame(major, 'APIC', [0, ...ascii('image/jpeg'), 0, 3, 0, ...new Array(200_000).fill(0xAB)]);

// ---- Tests --------------------------------------------------------------------

test('ID3 text encodings', () => {
    assertEqual(decodeId3Text(Uint8Array.from(ascii('caf') .concat([0xE9])), 0), 'café');
    assertEqual(decodeId3Text(Uint8Array.from(utf16le('Ñu')), 1), 'Ñu');
    assertEqual(decodeId3Text(Uint8Array.from(utf8('canción')), 3), 'canción');
});

test('MP3 ID3v2.3: USLT in UTF-16 after a big cover', async () => {
    const uslt = [1, ...ascii('spa'), 0xFF, 0xFE, 0, 0, ...utf16le('Primera línea\nSegunda línea').slice(2)];
    const bytes = Uint8Array.from([...id3(3, [apic(3), frame(3, 'USLT', uslt)]), ...new Array(100).fill(0xFF)]);
    const lyrics = await readEmbeddedLyricsFromBytes(bytes);
    assertEqual(lyrics, {synced: [], plain: 'Primera línea\nSegunda línea'});
});

test('MP3 ID3v2.4: SYLT with millisecond timestamps', async () => {
    const sylt = [3, ...ascii('eng'), 2, 1, 0,
        ...utf8('one'), 0, ...be32(1000),
        ...utf8('two'), 0, ...be32(3500)];
    const bytes = Uint8Array.from(id3(4, [apic(4), frame(4, 'SYLT', sylt)]));
    const lyrics = await readEmbeddedLyricsFromBytes(bytes);
    assertEqual(lyrics.synced, [{time: 1000, text: 'one'}, {time: 3500, text: 'two'}]);
});

test('USLT holding LRC text becomes synced', async () => {
    const uslt = [3, ...ascii('eng'), 0, ...utf8('[00:01.00]hola\n[00:02.00]mundo')];
    const lyrics = await readEmbeddedLyricsFromBytes(Uint8Array.from(id3(3, [frame(3, 'USLT', uslt)])));
    assertEqual(lyrics.synced.map(l => l.text), ['hola', 'mundo']);
});

test('FLAC: LYRICS comment after a picture block', async () => {
    const block = (type, body, last = false) => [(last ? 0x80 : 0) | type,
        (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
    const comment = s => [...le32(utf8(s).length), ...utf8(s)];
    const vorbis = [...le32(4), ...ascii('test'), ...le32(2),
        ...comment('TITLE=Canción'), ...comment('LYRICS=[00:05.00]letra en flac')];
    const bytes = Uint8Array.from([...ascii('fLaC'),
        ...block(0, new Array(34).fill(0)),
        ...block(6, new Array(150_000).fill(7)),
        ...block(4, vorbis, true),
        ...new Array(64).fill(0xFF)]);
    const lyrics = await readEmbeddedLyricsFromBytes(bytes);
    assertEqual(lyrics.synced, [{time: 5000, text: 'letra en flac'}]);
});

test('ID3v2.4 written with plain (v2.3-style) frame sizes', async () => {
    // MusicMatch-style: v2.4 header, but frame sizes are not syncsafe.
    const plainFrame = (id, body) => [...ascii(id), ...be32(body.length), 0, 0, ...body];
    const comm = [0, ...ascii('eng'), 0, ...new Array(300).fill(0x61)]; // 305 bytes: differs when syncsafe
    const uslt = [0, ...ascii('spa'), 0, ...ascii('letra completa '.repeat(20))];
    const body = [...plainFrame('COMM', comm), ...plainFrame('USLT', uslt)];
    const bytes = Uint8Array.from([...ascii('ID3'), 4, 0, 0, ...syncsafe(body.length), ...body]);
    assertEqual((await readEmbeddedLyricsFromBytes(bytes)).plain, 'letra completa '.repeat(20).trim());
});

test('lyrics in a second ID3 tag right after the first', async () => {
    const uslt = [3, ...ascii('spa'), 0, ...utf8('segunda etiqueta')];
    const bytes = Uint8Array.from([...id3(3, [frame(3, 'TIT2', [3, ...utf8('x')])]),
        ...id3(3, [frame(3, 'USLT', uslt)])]);
    assertEqual((await readEmbeddedLyricsFromBytes(bytes)).plain, 'segunda etiqueta');
});

test('no lyrics, or not an audio file', async () => {
    const bytes = Uint8Array.from(id3(3, [apic(3), frame(3, 'TIT2', [3, ...utf8('title')])]));
    assertEqual(await readEmbeddedLyricsFromBytes(bytes), null);
    assertEqual(await readEmbeddedLyricsFromBytes(Uint8Array.from(ascii('RIFF....WAVE'))), null);
    assert(true);
});

await done();
