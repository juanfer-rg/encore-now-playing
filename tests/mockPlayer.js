#!/usr/bin/env -S gjs -m
// A fake MPRIS player for manual testing without a real music app.
//
//   gjs -m tests/mockPlayer.js [name] [--art=PATH|URL] [--lyrics] [--plain-lyrics]
//       [--desktop=APP_ID] [--file=file:///path/to/song.flac]
//
// It owns org.mpris.MediaPlayer2.<name> (default "EncoreTest"), cycles
// through three fake tracks, honours Play/Pause/Next/Previous/Seek/
// SetPosition/Volume/Shuffle/LoopStatus, and prints every call it gets.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

const args = ARGV.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(ARGV.filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('=')).map(([k, v]) => [k, v ?? true]));
const name = args[0] ?? 'EncoreTest';

const IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek"><arg type="x" direction="in" name="Offset"/></method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <method name="OpenUri"><arg type="s" direction="in" name="Uri"/></method>
    <signal name="Seeked"><arg type="x" name="Position"/></signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

// Twenty synced lines, one every four seconds.
const LYRICS = Array.from({length: 20}, (_, i) => {
    const t = i * 4 + 0.5;
    const stamp = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
    const words = ['First line of the fake song', 'A longer second line that may need to wrap in the card',
        'Third line', 'Chorus! ♪', 'Another verse begins'];
    return `[${stamp}]${words[i % words.length]} (${i + 1})`;
}).join('\n');

function makeArt(path, rgb) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 256, 256);
    pixbuf.fill(((rgb[0] << 24) | (rgb[1] << 16) | (rgb[2] << 8) | 0xff) >>> 0);
    pixbuf.savev(path, 'png', [], []);
    return GLib.filename_to_uri(path, null);
}

const tmp = GLib.get_tmp_dir();
const TRACKS = [
    {title: 'Encore (Test Track One)', artist: 'The Mock Players', album: 'Fake Album', year: '2008-11-25', length: 185e6, color: [220, 60, 90]},
    {title: 'A Rather Long Title That Will Definitely Need To Scroll In The Top Bar', artist: 'Someone Else', album: 'Second Album', length: 245e6, color: [40, 140, 210]},
    {title: 'No Art Here', artist: 'Nobody', album: '', length: 95e6, color: null},
].map((t, i) => ({
    ...t,
    id: `/org/mpris/MediaPlayer2/Track/${i + 1}`,
    art: flags.art && i === 0 ? flags.art
        : t.color ? makeArt(`${tmp}/encore-mock-${name}-${i}.png`, t.color) : '',
}));

const state = {
    index: 0,
    status: 'Playing',
    loop: 'None',
    shuffle: false,
    volume: 0.7,
    position: 0, // microseconds
    since: GLib.get_monotonic_time(),
};

function position() {
    if (state.status !== 'Playing')
        return state.position;
    return Math.min(state.position + GLib.get_monotonic_time() - state.since, TRACKS[state.index].length);
}

function setPosition(us) {
    state.position = Math.max(0, Math.min(us, TRACKS[state.index].length));
    state.since = GLib.get_monotonic_time();
}

function metadata() {
    const t = TRACKS[state.index];
    const m = {
        'mpris:trackid': new GLib.Variant('o', t.id),
        'mpris:length': new GLib.Variant('x', t.length),
        'xesam:title': new GLib.Variant('s', t.title),
        'xesam:artist': new GLib.Variant('as', [t.artist]),
        'xesam:album': new GLib.Variant('s', t.album),
    };
    if (t.art)
        m['mpris:artUrl'] = new GLib.Variant('s', t.art);
    if (t.year)
        m['xesam:contentCreated'] = new GLib.Variant('s', t.year);
    if (flags.file)
        m['xesam:url'] = new GLib.Variant('s', flags.file);
    if (flags.lyrics)
        m['xesam:asText'] = new GLib.Variant('s', LYRICS);
    else if (flags['plain-lyrics'])
        m['xesam:asText'] = new GLib.Variant('s', Array.from({length: 40}, (_, i) => `Plain line ${i + 1}`).join('\n'));
    return m;
}

function changed(props) {
    const v = {};
    for (const p of props) {
        const value = getProperty(p);
        if (value)
            v[p] = value;
    }
    Gio.DBus.session.emit_signal(null, '/org/mpris/MediaPlayer2',
        'org.freedesktop.DBus.Properties', 'PropertiesChanged',
        new GLib.Variant('(sa{sv}as)', ['org.mpris.MediaPlayer2.Player', v, []]));
}

function getProperty(p) {
    switch (p) {
    case 'PlaybackStatus': return new GLib.Variant('s', state.status);
    case 'LoopStatus': return new GLib.Variant('s', state.loop);
    case 'Shuffle': return new GLib.Variant('b', state.shuffle);
    case 'Volume': return new GLib.Variant('d', state.volume);
    case 'Metadata': return new GLib.Variant('a{sv}', metadata());
    case 'Position': return new GLib.Variant('x', Math.round(position()));
    case 'Rate': case 'MinimumRate': case 'MaximumRate': return new GLib.Variant('d', 1);
    case 'CanGoNext': case 'CanGoPrevious': case 'CanPlay': case 'CanPause':
    case 'CanSeek': case 'CanControl': return new GLib.Variant('b', true);
    case 'CanQuit': case 'CanRaise': case 'HasTrackList': return new GLib.Variant('b', p === 'CanQuit');
    case 'Identity': return new GLib.Variant('s', `Encore Mock (${name})`);
    case 'DesktopEntry': return new GLib.Variant('s', flags.desktop ?? '');
    case 'SupportedUriSchemes': case 'SupportedMimeTypes': return new GLib.Variant('as', []);
    }
    return null;
}

function changeTrack(delta) {
    state.index = (state.index + delta + TRACKS.length) % TRACKS.length;
    setPosition(0);
    changed(['Metadata', 'PlaybackStatus']);
}

const loop = new GLib.MainLoop(null, false);
const nodeInfo = Gio.DBusNodeInfo.new_for_xml(IFACE);

const methods = {
    Raise: () => {},
    Quit: () => loop.quit(),
    Next: () => changeTrack(1),
    Previous: () => changeTrack(-1),
    Play: () => {
        setPosition(position());
        state.status = 'Playing';
        changed(['PlaybackStatus']);
    },
    Pause: () => {
        setPosition(position());
        state.status = 'Paused';
        changed(['PlaybackStatus']);
    },
    PlayPause: () => (state.status === 'Playing' ? methods.Pause() : methods.Play()),
    Stop: () => {
        setPosition(0);
        state.status = 'Stopped';
        changed(['PlaybackStatus']);
    },
    Seek: ([offset]) => {
        setPosition(position() + offset);
        Gio.DBus.session.emit_signal(null, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player', 'Seeked', new GLib.Variant('(x)', [Math.round(position())]));
    },
    SetPosition: ([trackId, pos]) => {
        if (trackId !== TRACKS[state.index].id)
            return;
        setPosition(pos);
        Gio.DBus.session.emit_signal(null, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player', 'Seeked', new GLib.Variant('(x)', [Math.round(position())]));
    },
    OpenUri: () => {},
};

for (const iface of nodeInfo.interfaces) {
    Gio.DBus.session.register_object('/org/mpris/MediaPlayer2', iface,
        (conn, sender, path, ifaceName, method, params, invocation) => {
            print(`call ${method} ${JSON.stringify(params.deepUnpack())}`);
            methods[method]?.(params.deepUnpack());
            invocation.return_value(null);
        },
        (conn, sender, path, ifaceName, prop) => getProperty(prop),
        (conn, sender, path, ifaceName, prop, value) => {
            print(`set ${prop} = ${JSON.stringify(value.deepUnpack())}`);
            if (prop === 'Volume')
                state.volume = Math.max(0, Math.min(value.deepUnpack(), 1));
            else if (prop === 'Shuffle')
                state.shuffle = value.deepUnpack();
            else if (prop === 'LoopStatus')
                state.loop = value.deepUnpack();
            changed([prop]);
            return true;
        });
}

// Advance to the next track at the end of the current one.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
    if (state.status === 'Playing' && position() >= TRACKS[state.index].length)
        changeTrack(1);
    return GLib.SOURCE_CONTINUE;
});

Gio.bus_own_name(Gio.BusType.SESSION, `org.mpris.MediaPlayer2.${name}`,
    Gio.BusNameOwnerFlags.NONE, null,
    () => print(`owning org.mpris.MediaPlayer2.${name}`),
    () => {
        printerr('could not own the bus name');
        loop.quit();
    });

loop.run();
