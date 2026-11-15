import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Bring a player's window to the front: the app's window whose title
 * mentions the track (browsers often have several), any window of the app,
 * MPRIS Raise(), or launching the app, in that order.
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
