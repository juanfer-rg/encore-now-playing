import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

/**
 * Hides GNOME's own media player from the notification list.
 *
 * This relies on private Shell internals: MessageView._addPlayer and friends
 * on GNOME 48+, the calendar's MediaSection on GNOME 46-47. When they are
 * missing the built-in player simply stays visible.
 */
export class NativePlayerHider {
    constructor() {
        this._injections = null;
        this._section = null;
    }

    enable() {
        if (this._injections || this._section)
            return;

        const proto = MessageList.MessageView?.prototype;
        if (typeof proto?._addPlayer === 'function' && typeof proto?._removePlayer === 'function')
            this._enableMessageView(proto);
        else if (this._legacySection())
            this._enableLegacySection();
        else
            console.warn('[Encore] cannot hide the built-in media player on this GNOME version');
    }

    disable() {
        if (this._section)
            this._disableLegacySection();
        if (this._injections)
            this._disableMessageView();
    }

    // ---- GNOME 48+ ---------------------------------------------------------

    _enableMessageView(proto) {
        try {
            this._injections = new InjectionManager();
            this._injections.overrideMethod(proto, '_addPlayer', () => function () {});
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
            this._disableMessageView();
        }
    }

    _disableMessageView() {
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

    // ---- GNOME 46-47 -------------------------------------------------------

    // The media section is a MessageListSection whose visibility follows its
    // "allowed" getter; shadowing it on the instance hides the whole section
    // while it keeps tracking players, so restoring it is just a resync.
    _enableLegacySection() {
        const section = this._legacySection();
        try {
            Object.defineProperty(section, 'allowed', {
                configurable: true,
                get: () => false,
            });
            this._section = section;
            this._resyncLegacy();
        } catch (e) {
            console.warn(`[Encore] hiding the built-in media player failed: ${e.message}`);
            this._disableLegacySection();
        }
    }

    _disableLegacySection() {
        const section = this._section ?? this._legacySection();
        this._section = null;
        if (!section)
            return;
        try {
            delete section.allowed;
            this._resyncLegacy(section);
        } catch (e) {
            console.warn(`[Encore] restoring the built-in media player failed: ${e.message}`);
        }
    }

    _resyncLegacy(section = this._section) {
        section?._sync?.();
        Main.panel?.statusArea?.dateMenu?._messageList?._sync?.();
    }

    _legacySection() {
        const section = Main.panel?.statusArea?.dateMenu?._messageList?._mediaSection;
        return section && typeof section._sync === 'function' ? section : null;
    }
}
