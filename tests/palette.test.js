import {
    cardColors, extractPalette, hslToRgb, luminance, paletteFromString,
    parseHex, rgbToHsl, rgbToHsv, toHex,
} from '../lib/art/palette.js';
import {assert, assertEqual, done, test} from './harness.js';

function image(width, height, fill) {
    const px = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = fill(x, y);
            const i = (y * width + x) * 3;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
        }
    }
    return px;
}

test('rgb <-> hsl round trip', () => {
    for (const c of [[255, 0, 0], [12, 200, 99], [128, 128, 128], [250, 240, 10]]) {
        const back = hslToRgb(...rgbToHsl(...c));
        c.forEach((v, i) => assert(Math.abs(v - back[i]) <= 1, `${c} -> ${back}`));
    }
});

test('hsv of pure colors', () => {
    assertEqual(rgbToHsv(255, 0, 0), [0, 1, 1]);
    assertEqual(rgbToHsv(0, 255, 0)[0], 120);
    assertEqual(rgbToHsv(0, 0, 255)[0], 240);
});

test('hex helpers', () => {
    assertEqual(toHex([255, 128, 0]), '#ff8000');
    assertEqual(parseHex('#3584e4'), [53, 132, 228]);
    assertEqual(parseHex('nope'), null);
});

test('dominant color of a mostly red image is red', () => {
    const px = image(32, 32, x => (x < 24 ? [220, 30, 40] : [30, 60, 220]));
    const p = extractPalette(px, 32, 32, 32 * 3, 3);
    assert(p.colorful, 'should be colorful');
    assertEqual(p.primary, [220, 30, 40]);
    assertEqual(p.secondary, [30, 60, 220], 'secondary should be the blue');
});

test('grayscale image is not colorful and uses the average', () => {
    const px = image(8, 8, x => (x < 4 ? [20, 20, 20] : [220, 220, 220]));
    const p = extractPalette(px, 8, 8, 8 * 3, 3);
    assert(!p.colorful);
    assertEqual(p.primary, [120, 120, 120]);
});

test('transparent pixels are skipped (RGBA)', () => {
    const px = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++)
        px.set(i < 8 ? [0, 200, 0, 255] : [255, 0, 0, 0], i * 4);
    const p = extractPalette(px, 4, 4, 16, 4);
    assertEqual(p.primary, [0, 200, 0]);
});

test('empty image gives null', () => {
    assertEqual(extractPalette(new Uint8Array(0), 0, 0, 0, 3), null);
});

test('string palette is stable', () => {
    assertEqual(paletteFromString('Radiohead|OK Computer'), paletteFromString('Radiohead|OK Computer'));
    assert(JSON.stringify(paletteFromString('a')) !== JSON.stringify(paletteFromString('b')));
});

test('card colors: dark background, readable accent', () => {
    for (const primary of [[250, 250, 30], [10, 10, 80], [200, 20, 20]]) {
        const c = cardColors({primary, secondary: primary, colorful: true});
        assert(luminance(parseHex(c.background)) < 0.05, `background ${c.background} too light`);
        assert(luminance(parseHex(c.accent)) > 0.15, `accent ${c.accent} too dark`);
        assert(c.onAccent === '#000000' || c.onAccent === '#ffffff');
    }
});

done();
