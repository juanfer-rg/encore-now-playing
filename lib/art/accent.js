import {cardColors, paletteFromString, waveColors} from './palette.js';
import {joinNonEmpty} from '../util.js';

/**
 * Colors for a player's current track: from its artwork, or derived from the
 * artist/album when there is no artwork.
 *
 * @param {import('./artCache.js').ArtCache} artCache
 * @param {import('../mpris/player.js').MprisPlayer} player
 * @returns {Promise<{accent: string, waves: string[]}|null>} CSS hex colors:
 *   one accent, and up to three colors for the waves to blend
 */
export async function colorsForPlayer(artCache, player) {
    const m = player.metadata;
    const file = m.artUrl ? await artCache.resolve(m.artUrl) : null;
    let palette = file ? await artCache.palette(file) : null;
    if (!palette) {
        const seed = joinNonEmpty([player.artist, m.album, m.title], '|');
        palette = seed ? paletteFromString(seed) : null;
    }
    if (!palette)
        return null;
    return {accent: cardColors(palette).accent, waves: waveColors(palette)};
}
