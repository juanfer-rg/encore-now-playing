import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {getProxies} from './ifaces.js';
import {MprisPlayer} from './player.js';
import {MPRIS_PREFIX, isCancelled, playerKey} from '../util.js';

// playerctld re-exports whichever player is active; listing it would show
// every player twice.
const IGNORED_KEYS = new Set(['playerctld']);

/**
 * Tracks the MPRIS players on the session bus and picks the active one.
 *
 * Signals:
 *  - players-changed: the list of usable players changed
 *  - active-changed: a different player became active (or none)
 *  - active-updated: the active player's state changed
 *  - active-seeked(position): the active player jumped to a new position
 *  - playback-changed: the set of playing players, or what they play, changed
 */
export const MprisManager = GObject.registerClass({
    Signals: {
        'players-changed': {},
        'active-changed': {},
        'active-updated': {},
        'active-seeked': {param_types: [GObject.TYPE_DOUBLE]},
        'playback-changed': {},
    },
}, class MprisManager extends GObject.Object {
    constructor(settings) {
        super();

        this._settings = settings;
        this._players = new Map(); // busName -> MprisPlayer
        this._active = null;
        this._pinned = null; // chosen by hand in the switcher
        this._rosterSignature = '';
        this._playingSignature = '';
        this._cancellable = new Gio.Cancellable();
        this._dbusProxy = null;
        this._nameOwnerId = 0;
        this._blocked = new Set(settings.get_strv('blocked-players'));

        settings.connectObject('changed::blocked-players', () => {
            this._blocked = new Set(settings.get_strv('blocked-players'));
            this._applyBlocklist();
        }, this);

        const {DBusProxy} = getProxies();
        new DBusProxy(Gio.DBus.session, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            (proxy, error) => {
                if (error) {
                    if (!isCancelled(error))
                        console.error(`[Encore] cannot watch the session bus: ${error.message}`);
                    return;
                }
                this._dbusProxy = proxy;
                // Subscribe before listing, or a player appearing in
                // between would be missed.
                this._nameOwnerId = proxy.connectSignal('NameOwnerChanged',
                    (_p, _sender, [name, oldOwner, newOwner]) =>
                        this._onNameOwnerChanged(name, oldOwner, newOwner));
                this._scanNames();
            }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
    }

    get active() {
        return this._active;
    }

    // Most recently played first.
    get players() {
        return [...this._players.values()]
            .filter(p => p.usable)
            .sort((a, b) => b.lastPlayingTime - a.lastPlayingTime ||
                a.identity.localeCompare(b.identity));
    }

    // The active player first.
    get playing() {
        const playing = this.players.filter(p => p.isPlaying);
        return playing.sort((a, b) => (b === this._active) - (a === this._active));
    }

    setActive(player) {
        if (!this._players.has(player?.busName))
            return;
        this._pinned = player;
        this._selectActive();
    }

    destroy() {
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        if (this._dbusProxy && this._nameOwnerId)
            this._dbusProxy.disconnectSignal(this._nameOwnerId);
        this._dbusProxy = null;
        for (const player of this._players.values()) {
            player.disconnectObject(this);
            player.destroy();
        }
        this._players.clear();
        this._active = null;
        this._pinned = null;
        this._settings = null;
    }

    async _scanNames() {
        if (!this._dbusProxy)
            return;
        try {
            const [names] = await this._dbusProxy.ListNamesAsync(this._cancellable);
            for (const name of names) {
                if (this._isCandidate(name))
                    this._addPlayer(name);
            }
        } catch (e) {
            if (!isCancelled(e))
                console.error(`[Encore] ListNames failed: ${e.message}`);
        }
    }

    _isCandidate(name) {
        if (!name.startsWith(MPRIS_PREFIX))
            return false;
        const key = playerKey(name);
        return !IGNORED_KEYS.has(key) && !this._blocked.has(key);
    }

    _onNameOwnerChanged(name, oldOwner, newOwner) {
        if (!name.startsWith(MPRIS_PREFIX))
            return;
        if (oldOwner)
            this._removePlayer(name);
        if (newOwner && this._isCandidate(name))
            this._addPlayer(name);
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        this._players.set(busName, player);
        player.connectObject(
            'changed', () => this._onPlayerChanged(player),
            'seeked', (_p, position) => {
                if (player === this._active)
                    this.emit('active-seeked', position);
            },
            'started-playing', () => this._onStartedPlaying(player),
            this);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.disconnectObject(this);
        player.destroy();
        if (this._pinned === player)
            this._pinned = null;
        this._update();
        this._syncPlayback();
    }

    _applyBlocklist() {
        for (const busName of [...this._players.keys()]) {
            if (!this._isCandidate(busName))
                this._removePlayer(busName);
        }
        // Players removed from the blocklist come back.
        this._scanNames();
    }

    _onPlayerChanged(player) {
        this._update();
        if (player === this._active)
            this.emit('active-updated');
        this._syncPlayback();
    }

    _syncPlayback() {
        const playing = this.players.filter(p => p.isPlaying)
            .map(p => `${p.busName} ${p.trackKey}`).sort().join('\n');
        if (playing !== this._playingSignature) {
            this._playingSignature = playing;
            this.emit('playback-changed');
        }
    }

    _onStartedPlaying(player) {
        // A player that starts playing takes over from a hand-picked one.
        if (this._pinned && this._pinned !== player)
            this._pinned = null;

        if (this._settings.get_boolean('pause-others-on-play')) {
            for (const other of this._players.values()) {
                if (other !== player && other.isPlaying && other.canPause)
                    other.pause();
            }
        }
        this._update();
    }

    _update() {
        const signature = this.players.map(p => p.busName).sort().join('\n');
        if (signature !== this._rosterSignature) {
            this._rosterSignature = signature;
            this.emit('players-changed');
        }
        this._selectActive();
    }

    _selectActive() {
        const players = this.players;
        let next;
        if (this._pinned && players.includes(this._pinned))
            next = this._pinned;
        else
            next = players.find(p => p.isPlaying) ??
                players.find(p => p.status === 'Paused') ??
                players[0] ?? null;

        if (next !== this._active) {
            this._active = next;
            this.emit('active-changed');
        }
    }
});
