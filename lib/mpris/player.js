import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {getProxies} from './ifaces.js';
import {isCancelled, playerKey} from '../util.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
const CALL_TIMEOUT_MS = 1000;

const LOOP_CYCLE = {None: 'Playlist', Playlist: 'Track', Track: 'None'};

function logCallError(what, e) {
    if (!isCancelled(e))
        console.warn(`[Encore] ${what} failed: ${e.message}`);
}

function asString(v) {
    return typeof v === 'string' ? v : '';
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// xesam:contentCreated is an ISO 8601 date: "2008-11-25" or just "2008".
function releaseYear(v) {
    const m = /^(\d{4})/.exec(asString(v));
    return m ? m[1] : '';
}

function asStringList(v) {
    if (Array.isArray(v))
        return v.filter(s => typeof s === 'string' && s !== '');
    if (typeof v === 'string' && v !== '')
        return [v];
    return [];
}

/**
 * One MPRIS player on the session bus.
 *
 * Signals:
 *  - changed: any property changed (also emitted once each proxy is ready)
 *  - seeked(position): the player jumped to a new position (microseconds)
 *  - started-playing: PlaybackStatus switched to Playing
 */
export const MprisPlayer = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': {param_types: [GObject.TYPE_DOUBLE]},
        'started-playing': {},
    },
}, class MprisPlayer extends GObject.Object {
    constructor(busName) {
        super();

        this.busName = busName;
        this.key = playerKey(busName);
        this.lastPlayingTime = 0;

        this._cancellable = new Gio.Cancellable();
        this._mprisProxy = null;
        this._playerProxy = null;
        this._metadata = null;
        this._app = undefined;
        this._status = 'Stopped';
        this._seekedId = 0;

        const {MprisProxy, PlayerProxy} = getProxies();

        new MprisProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                logCallError(`MPRIS proxy for ${busName}`, error);
                return;
            }
            this._mprisProxy = proxy;
            proxy.connectObject('g-properties-changed', () => {
                this._app = undefined;
                this._onChanged();
            }, this);
            this._onChanged();
        }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START);

        new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error) {
                logCallError(`player proxy for ${busName}`, error);
                return;
            }
            this._playerProxy = proxy;
            proxy.connectObject('g-properties-changed', () => {
                this._metadata = null;
                this._onChanged();
            }, this);
            this._seekedId = proxy.connectSignal('Seeked',
                (_p, _sender, [position]) => this.emit('seeked', asNumber(position)));
            this._onChanged();
        }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
    }

    _onChanged() {
        const status = this.status;
        if (status === 'Playing')
            this.lastPlayingTime = GLib.get_monotonic_time();
        const startedPlaying = status === 'Playing' && this._status !== 'Playing';
        this._status = status;

        this.emit('changed');
        if (startedPlaying)
            this.emit('started-playing');
    }

    get ready() {
        return this._mprisProxy !== null && this._playerProxy !== null;
    }

    // Worth showing: controllable and has something loaded.
    get usable() {
        if (!this.ready)
            return false;
        if (!this.canPlay && !this.canPause && this.status !== 'Playing')
            return false;
        return this.status !== 'Stopped' || this.title !== '';
    }

    get identity() {
        return this._mprisProxy?.Identity || this.key;
    }

    get desktopEntry() {
        return this._mprisProxy?.DesktopEntry ?? '';
    }

    get app() {
        if (this._app === undefined) {
            const appSystem = Shell.AppSystem.get_default();
            const entry = this.desktopEntry;
            this._app = (entry && appSystem.lookup_app(`${entry}.desktop`)) ||
                appSystem.lookup_desktop_wmclass(this.key) ||
                null;
        }
        return this._app;
    }

    get gicon() {
        return this.app?.get_icon() ?? null;
    }

    get status() {
        return this._playerProxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    get metadata() {
        if (this._metadata)
            return this._metadata;

        const raw = {};
        const packed = this._playerProxy?.Metadata ?? {};
        for (const [k, v] of Object.entries(packed)) {
            try {
                raw[k] = v instanceof GLib.Variant ? v.recursiveUnpack() : v;
            } catch {
                // Ignore malformed entries.
            }
        }

        this._metadata = {
            trackId: asString(raw['mpris:trackid']),
            title: asString(raw['xesam:title']),
            artists: asStringList(raw['xesam:artist']),
            album: asString(raw['xesam:album']),
            artUrl: asString(raw['mpris:artUrl']),
            length: asNumber(raw['mpris:length']),
            url: asString(raw['xesam:url']),
            lyrics: asString(raw['xesam:asText']),
            year: releaseYear(raw['xesam:contentCreated']),
        };
        return this._metadata;
    }

    get title() {
        return this.metadata.title;
    }

    get artist() {
        return this.metadata.artists.join(', ');
    }

    get trackKey() {
        const m = this.metadata;
        return `${m.trackId}|${m.title}|${m.artists.join(',')}|${m.length}`;
    }

    get canGoNext() {
        return !!this._playerProxy?.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._playerProxy?.CanGoPrevious;
    }

    get canPlay() {
        return !!this._playerProxy?.CanPlay;
    }

    get canPause() {
        return !!this._playerProxy?.CanPause;
    }

    get canSeek() {
        return !!this._playerProxy?.CanSeek && this.metadata.length > 0;
    }

    get canControl() {
        return !!this._playerProxy?.CanControl;
    }

    get canRaise() {
        return !!this._mprisProxy?.CanRaise;
    }

    // The next three are null when the player does not support them.
    get shuffle() {
        const v = this._playerProxy?.Shuffle;
        return typeof v === 'boolean' ? v : null;
    }

    get loopStatus() {
        const v = this._playerProxy?.LoopStatus;
        return v in LOOP_CYCLE ? v : null;
    }

    get volume() {
        const v = this._playerProxy?.Volume;
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    _invoke(method, ...args) {
        if (!this._playerProxy)
            return;
        this._playerProxy[`${method}Async`](...args, this._cancellable)
            .catch(e => logCallError(`${this.key}.${method}`, e));
    }

    playPause() {
        this._invoke('PlayPause');
    }

    pause() {
        this._invoke('Pause');
    }

    next() {
        this._invoke('Next');
    }

    previous() {
        this._invoke('Previous');
    }

    // Positions in microseconds. `current` is only used for players without
    // a track id, where SetPosition() cannot be used and Seek() is relative.
    seekTo(target, current) {
        const length = this.metadata.length;
        target = Math.round(Math.max(0, length > 0 ? Math.min(target, length) : target));
        const trackId = this.metadata.trackId;
        if (trackId && trackId !== NO_TRACK && GLib.Variant.is_object_path(trackId))
            this._invoke('SetPosition', trackId, target);
        else
            this._invoke('Seek', Math.round(target - current));
    }

    _setProperty(name, variant) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, variant]),
            null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, this._cancellable)
            .catch(e => logCallError(`${this.key}.Set(${name})`, e));
    }

    setVolume(value) {
        this._setProperty('Volume', new GLib.Variant('d', Math.max(0, Math.min(value, 1))));
    }

    toggleShuffle() {
        if (this.shuffle !== null)
            this._setProperty('Shuffle', new GLib.Variant('b', !this.shuffle));
    }

    cycleLoop() {
        const loop = this.loopStatus;
        if (loop !== null)
            this._setProperty('LoopStatus', new GLib.Variant('s', LOOP_CYCLE[loop]));
    }

    raise() {
        if (this._mprisProxy && this.canRaise) {
            this._mprisProxy.RaiseAsync(this._cancellable)
                .catch(e => logCallError(`${this.key}.Raise`, e));
            return true;
        }
        return false;
    }

    // Microseconds, or null when the player does not tell.
    async getPosition() {
        try {
            const reply = await Gio.DBus.session.call(this.busName, MPRIS_PATH,
                PROPS_IFACE, 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE,
                CALL_TIMEOUT_MS, this._cancellable);
            const [value] = reply.deepUnpack();
            return asNumber(value.recursiveUnpack());
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`[Encore] ${this.key}: no position (${e.message})`);
            return null;
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._playerProxy) {
            if (this._seekedId)
                this._playerProxy.disconnectSignal(this._seekedId);
            this._playerProxy.disconnectObject(this);
        }
        this._mprisProxy?.disconnectObject(this);
        this._playerProxy = null;
        this._mprisProxy = null;
        this._metadata = null;
        this._app = null;
    }
});
