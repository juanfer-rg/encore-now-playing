import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

/**
 * Hides GNOME's own media player from the notification list.
 *
 * This relies on private Shell internals (MessageView._addPlayer and
 * friends), so every step checks that what it needs exists and gives up
 * quietly otherwise: on an unexpected Shell version the native player simply
 * stays visible.
 */
export class NativePlayerHider {
    constructor() {
        this._injections = null;
    }

    get active() {
        return this._injections !== null;
    }

    enable() {
        if (this._injections)
            return;

        const proto = MessageList.MessageView?.prototype;
        if (typeof proto?._addPlayer !== 'function' || typeof proto?._removePlayer !== 'function') {
            console.warn('[Encore] cannot hide the built-in media player on this GNOME version');
            return;
        }

        try {
            this._injections = new InjectionManager();
            this._injections.overrideMethod(proto, '_addPlayer', () => function () {
                // Swallow: the built-in player stays hidden.
            });
            // Players that were never added must not be "removed".
            this._injections.overrideMethod(proto, '_removePlayer', original => function (player) {
                if (this._playerToMessage?.has(player))
                    original.call(this, player);
            });

            const view = this._view();
            if (view?._playerToMessage) {
                for (const player of [...view._playerToMessage.keys()])
                    view._removePlayer(player);
            }
        } catch (e) {
            console.warn(`[Encore] hiding the built-in media player failed: ${e.message}`);
            this.disable();
        }
    }

    disable() {
        if (!this._injections)
            return;

        this._injections.clear();
        this._injections = null;

        // Put the built-in players back.
        try {
            const view = this._view();
            const players = view?._mediaSource?.players ?? [];
            for (const player of players) {
                if (!view._playerToMessage?.has(player))
                    view._addPlayer(player);
            }
        } catch (e) {
            console.warn(`[Encore] restoring the built-in media player failed: ${e.message}`);
        }
    }

    _view() {
        return Main.panel?.statusArea?.dateMenu?._messageList?._messageView ?? null;
    }
}
