import {paletteFromString, waveColors} from './palette.js';
import {joinNonEmpty} from '../util.js';

/**
 * Colors for a player's current track, from its artwork or, without one,
 * derived from the artist and album.
 *
 * @returns {Promise<{waves: string[]}|null>} up to three CSS hex colors
 */
export async function colorsForPlayer(artCache, player) {
    const artUrl = player.metadata.artUrl;
    const file = artUrl ? await artCache.resolve(artUrl) : null;
    const palette = (file ? await artCache.palette(file) : null) ?? trackPalette(player);
    if (!palette)
        return null;
    return {waves: waveColors(palette)};
}

// Stand-in colors for a track without artwork, stable for the same album.
export function trackPalette(player) {
    const seed = joinNonEmpty([player.artist, player.metadata.album, player.title], '|');
    return seed ? paletteFromString(seed) : null;
}
