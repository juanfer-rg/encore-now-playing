import {cardColors, paletteFromString} from './palette.js';
import {joinNonEmpty} from '../util.js';

/**
 * The accent color for a player's current track: from its artwork, or a
 * stable color derived from the artist/album when there is no artwork.
 *
 * @param {import('./artCache.js').ArtCache} artCache
 * @param {import('../mpris/player.js').MprisPlayer} player
 * @returns {Promise<string|null>} CSS hex color
 */
export async function accentForPlayer(artCache, player) {
    const m = player.metadata;
    const file = m.artUrl ? await artCache.resolve(m.artUrl) : null;
    let palette = file ? await artCache.palette(file) : null;
    if (!palette) {
        const seed = joinNonEmpty([player.artist, m.album, m.title], '|');
        palette = seed ? paletteFromString(seed) : null;
    }
    return palette ? cardColors(palette).accent : null;
}
