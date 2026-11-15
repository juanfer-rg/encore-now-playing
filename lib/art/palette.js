// Color extraction from album art. Pure functions with no GNOME imports, so
// they can be unit tested with plain gjs.

const BINS = 12; // 30° of hue each
const MIN_SATURATION = 0.15;
const MIN_VALUE = 0.15;

export function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h *= 60;
        if (h < 0)
            h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

export function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    const [h] = rgbToHsv(r * 255, g * 255, b * 255);
    return [h, s, l];
}

export function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let rgb;
    if (hp < 1)
        rgb = [c, x, 0];
    else if (hp < 2)
        rgb = [x, c, 0];
    else if (hp < 3)
        rgb = [0, c, x];
    else if (hp < 4)
        rgb = [0, x, c];
    else if (hp < 5)
        rgb = [x, 0, c];
    else
        rgb = [c, 0, x];
    const m = l - c / 2;
    return rgb.map(v => Math.round((v + m) * 255));
}

export function toHex([r, g, b]) {
    return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0..1. */
export function luminance([r, g, b]) {
    const lin = v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Find the dominant and a contrasting secondary color in an RGB(A) buffer.
 * Pixels are weighted by saturation × value and grouped into hue bins, so
 * the result is the most vivid prominent color rather than a muddy average.
 *
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} rowstride - bytes per row
 * @param {number} channels - 3 (RGB) or 4 (RGBA)
 * `colors` lists up to three distinct colors, strongest first: the dominant
 * one, then the strongest bins at least 60° of hue away from the ones
 * already picked.
 *
 * @returns {{primary: number[], secondary: number[], colors: number[][], colorful: boolean}|null}
 */
export function extractPalette(pixels, width, height, rowstride, channels) {
    const bins = Array.from({length: BINS}, () => ({w: 0, r: 0, g: 0, b: 0}));
    let avgR = 0, avgG = 0, avgB = 0, count = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            avgR += r;
            avgG += g;
            avgB += b;
            count++;

            const [h, s, v] = rgbToHsv(r, g, b);
            if (s < MIN_SATURATION || v < MIN_VALUE)
                continue;
            const w = s * v;
            const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
            bin.w += w;
            bin.r += r * w;
            bin.g += g * w;
            bin.b += b * w;
        }
    }

    if (count === 0)
        return null;

    const average = [avgR / count, avgG / count, avgB / count].map(Math.round);
    const totalWeight = bins.reduce((sum, b) => sum + b.w, 0);
    if (totalWeight < count * 0.02)
        return {primary: average, secondary: average, colors: [average], colorful: false};

    const colorOf = bin => [bin.r / bin.w, bin.g / bin.w, bin.b / bin.w].map(Math.round);
    let best = 0;
    for (let i = 1; i < BINS; i++) {
        if (bins[i].w > bins[best].w)
            best = i;
    }

    // Then the strongest bins at least 60° of hue away from those picked.
    const picked = [best];
    while (picked.length < 3) {
        let next = -1;
        for (let i = 0; i < BINS; i++) {
            const farEnough = picked.every(p => Math.min(Math.abs(i - p), BINS - Math.abs(i - p)) >= 2);
            if (farEnough && bins[i].w > totalWeight * 0.05 && (next < 0 || bins[i].w > bins[next].w))
                next = i;
        }
        if (next < 0)
            break;
        picked.push(next);
    }

    const colors = picked.map(i => colorOf(bins[i]));
    return {
        primary: colors[0],
        secondary: colors[1] ?? colors[0],
        colors,
        colorful: true,
    };
}

/**
 * A stable palette derived from text (artist/album) for tracks without art.
 *
 * @param {string} text
 * @returns {{primary: number[], secondary: number[], colorful: boolean}}
 */
export function paletteFromString(text) {
    // FNV-1a
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const hue = hash % 360;
    const colors = [hslToRgb(hue, 0.55, 0.5), hslToRgb(hue + 40, 0.6, 0.6), hslToRgb(hue - 50, 0.5, 0.55)];
    return {
        primary: colors[0],
        secondary: colors[1],
        colors,
        colorful: true,
    };
}

/**
 * Turn a palette into the colors the card uses. The background stays dark
 * enough for light text, and the accent stays bright enough to stand out.
 *
 * @param {{primary: number[], secondary: number[], colorful: boolean}} palette
 * @returns {{background: string, accent: string, onAccent: string}}
 */
export function cardColors(palette) {
    const [bh, bs] = rgbToHsl(...palette.primary);
    const background = hslToRgb(bh, Math.min(bs, 0.5), 0.16);

    const source = palette.colorful ? palette.secondary : palette.primary;
    let [ah, as, al] = rgbToHsl(...source);
    if (palette.colorful)
        as = Math.max(as, 0.45);
    al = Math.min(Math.max(al, 0.58), 0.75);
    let accent = hslToRgb(ah, as, al);
    // Blues and purples look dark at the same lightness; brighten until the
    // accent clearly stands out from the dark background.
    while (luminance(accent) < 0.2 && al < 0.86) {
        al += 0.03;
        accent = hslToRgb(ah, as, al);
    }

    return {
        background: toHex(background),
        accent: toHex(accent),
        onAccent: luminance(accent) > 0.4 ? '#000000' : '#ffffff',
    };
}

/** Make a color bright enough to stand out on a dark or light surface. */
function brighten(rgb, colorful) {
    let [h, s, l] = rgbToHsl(...rgb);
    if (colorful)
        s = Math.max(s, 0.45);
    l = Math.min(Math.max(l, 0.55), 0.75);
    let out = hslToRgb(h, s, l);
    while (luminance(out) < 0.2 && l < 0.86) {
        l += 0.03;
        out = hslToRgb(h, s, l);
    }
    return out;
}

/**
 * The colors the waves blend: up to three distinct colors of the artwork,
 * brightened so they read well, as CSS hex strings.
 *
 * @param {{colors?: number[][], primary: number[], colorful: boolean}} palette
 * @returns {string[]}
 */
export function waveColors(palette) {
    const source = palette.colors?.length ? palette.colors : [palette.primary];
    const unique = [];
    for (const hex of source.slice(0, 3).map(c => toHex(brighten(c, palette.colorful)))) {
        if (!unique.includes(hex))
            unique.push(hex);
    }
    return unique;
}
