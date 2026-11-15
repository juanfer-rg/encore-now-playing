// LRC (synced lyrics) parsing. Pure functions, unit tested with plain gjs.

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

/**
 * Parse LRC text into timed lines sorted by time.
 *
 * Supports several time tags on one line ("[00:12.00][01:30.50]Chorus") and
 * the [offset:±ms] tag. Metadata tags such as [ar:...] are skipped.
 *
 * @param {string} text
 * @returns {{time: number, text: string}[]} time in milliseconds
 */
export function parseLrc(text) {
    if (typeof text !== 'string' || text === '')
        return [];

    let offset = 0;
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const off = OFFSET_TAG.exec(line);
        if (off) {
            offset = parseInt(off[1], 10);
            continue;
        }

        TIME_TAG.lastIndex = 0;
        const times = [];
        let match;
        let end = 0;
        while ((match = TIME_TAG.exec(line)) !== null && match.index === end) {
            const [, min, sec, frac = '0'] = match;
            const ms = frac.length === 1 ? +frac * 100 : frac.length === 2 ? +frac * 10 : +frac;
            times.push(+min * 60_000 + +sec * 1000 + ms);
            end = TIME_TAG.lastIndex;
        }
        if (times.length === 0)
            continue;

        const content = line.slice(end).trim();
        for (const t of times)
            lines.push({time: Math.max(0, t - offset), text: content});
    }

    return lines.sort((a, b) => a.time - b.time);
}

/**
 * Index of the line to highlight at `ms`, or -1 before the first line.
 *
 * @param {{time: number}[]} lines - sorted by time
 * @param {number} ms
 * @returns {number}
 */
export function findLineIndex(lines, ms) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= ms) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

/**
 * Spread unsynced lyrics evenly over the track so they scroll line by line.
 * Section tags such as "[Chorus]" and blank lines are dropped.
 *
 * @param {string} text
 * @param {number} lengthMs - track length; 4 minutes when unknown
 * @returns {{time: number, text: string}[]}
 */
export function distributePlainLyrics(text, lengthMs) {
    const lines = text.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l !== '' && !/^\[[^\]]*\]$/.test(l));
    if (lines.length === 0)
        return [];
    const total = lengthMs > 10_000 ? lengthMs : 240_000;
    const step = total / (lines.length + 1);
    return lines.map((line, i) => ({time: Math.round(step * (i + 1)), text: line}));
}
