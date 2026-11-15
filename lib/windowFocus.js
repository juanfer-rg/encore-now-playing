import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Bring a player's window to the front.
 *
 * Prefers a window of the player's app whose title mentions the track (useful
 * for browsers with several windows), then any window of the app, then the
 * MPRIS Raise() method, and finally launching/activating the app.
 *
 * @param {import('./mpris/player.js').MprisPlayer} player
 * @returns {boolean} whether something was done
 */
export function focusPlayer(player) {
    const app = player.app;
    if (app) {
        const windows = app.get_windows();
        if (windows.length > 0) {
            const title = player.title.toLowerCase();
            const match = title
                ? windows.find(w => (w.get_title() ?? '').toLowerCase().includes(title))
                : null;
            Main.activateWindow(match ?? windows[0]);
            return true;
        }
    }

    // Raise() can trip focus-stealing prevention, but it is the only option
    // for players whose app we cannot find.
    if (player.raise())
        return true;

    if (app) {
        app.activate();
        return true;
    }
    return false;
}
