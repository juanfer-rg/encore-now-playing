import {distributePlainLyrics, findLineIndex, parseLrc} from '../lib/lyrics/lrc.js';
import {cssUrl, formatTime, joinNonEmpty, playerKey} from '../lib/util.js';
import {assertEqual, done, test} from './harness.js';

test('parses simple LRC', () => {
    assertEqual(parseLrc('[00:01.00]one\n[00:02.50]two'), [
        {time: 1000, text: 'one'},
        {time: 2500, text: 'two'},
    ]);
});

test('fraction precision: 1, 2 and 3 digits', () => {
    assertEqual(parseLrc('[00:01.5]a\n[00:01.25]b\n[00:01.125]c').map(l => l.time), [1125, 1250, 1500]);
});

test('several time tags on one line, sorted output', () => {
    assertEqual(parseLrc('[00:10.00][00:01.00]chorus\n[00:05.00]verse'), [
        {time: 1000, text: 'chorus'},
        {time: 5000, text: 'verse'},
        {time: 10000, text: 'chorus'},
    ]);
});

test('metadata tags are ignored, offset applied', () => {
    assertEqual(parseLrc('[ar:Someone]\n[offset:+500]\n[00:02.00]x'), [{time: 1500, text: 'x'}]);
});

test('empty and garbage input', () => {
    assertEqual(parseLrc(''), []);
    assertEqual(parseLrc(null), []);
    assertEqual(parseLrc('just text\nno tags'), []);
});

test('findLineIndex', () => {
    const lines = [{time: 1000}, {time: 2000}, {time: 3000}];
    assertEqual(findLineIndex(lines, 0), -1);
    assertEqual(findLineIndex(lines, 1000), 0);
    assertEqual(findLineIndex(lines, 2999), 1);
    assertEqual(findLineIndex(lines, 99999), 2);
    assertEqual(findLineIndex([], 5), -1);
});

test('plain lyrics are spread over the track, tags dropped', () => {
    const lines = distributePlainLyrics('[Verse 1]\none\n\ntwo\nthree\n[Chorus]', 40_000);
    assertEqual(lines.map(l => l.text), ['one', 'two', 'three']);
    assertEqual(lines.map(l => l.time), [10000, 20000, 30000]);
    assertEqual(distributePlainLyrics('a', 0)[0].time, 120000);
    assertEqual(distributePlainLyrics('', 1000), []);
});

test('playerKey strips prefix and instance suffix', () => {
    assertEqual(playerKey('org.mpris.MediaPlayer2.firefox.instance_1_42'), 'firefox');
    assertEqual(playerKey('org.mpris.MediaPlayer2.chromium.instance12345'), 'chromium');
    assertEqual(playerKey('org.mpris.MediaPlayer2.Spotify'), 'spotify');
    assertEqual(playerKey('org.mpris.MediaPlayer2.io.github.Foo'), 'io.github.foo');
});

test('formatTime', () => {
    assertEqual(formatTime(0), '0:00');
    assertEqual(formatTime(61_000_000), '1:01');
    assertEqual(formatTime(3_725_000_000), '1:02:05');
    assertEqual(formatTime(-5), '0:00');
    assertEqual(formatTime(NaN), '0:00');
});

test('cssUrl escapes quotes and backslashes', () => {
    assertEqual(cssUrl('file:///a b/c.png'), 'url("file:///a b/c.png")');
    assertEqual(cssUrl('file:///x"y'), 'url("file:///x\\22 y")');
});

test('joinNonEmpty', () => {
    assertEqual(joinNonEmpty(['a', '', ' ', 'b']), 'a · b');
});

done();
