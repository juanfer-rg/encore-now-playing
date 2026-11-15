import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {finishPage, page, trackKey} from './common.js';
import {MPRIS_PREFIX, playerKey} from '../util.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

async function dbusCall(dest, path, iface, method, params, replyType) {
    const reply = await Gio.DBus.session.call(dest, path, iface, method, params,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NO_AUTO_START, 1000, null);
    return reply.deepUnpack();
}

/** @returns {Promise<Map<string, string>>} player key -> display name */
async function runningPlayers() {
    const [names] = await dbusCall('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', null, '(as)');
    const players = new Map();
    await Promise.all(names.filter(n => n.startsWith(MPRIS_PREFIX)).map(async name => {
        const key = playerKey(name);
        if (key === 'playerctld')
            return;
        let identity = key;
        try {
            const [value] = await dbusCall(name, '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity']), '(v)');
            identity = value.deepUnpack() || key;
        } catch {
            // Keep the key as the name.
        }
        players.set(key, identity);
    }));
    return players;
}

export function buildPlayersPage(settings, window) {
    const p = page(_('Players'), 'applications-multimedia-symbolic');
    trackKey(settings, 'blocked-players', _('Hidden players'),
        v => (v.unpack().length ? v.deepUnpack().join(', ') : _('None')));
    const list = new Adw.PreferencesGroup({
        title: _('Media players'),
        description: _('Turn off a player to ignore it. Players appear here while they are running.'),
    });
    const refresh = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: _('Refresh'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    list.set_header_suffix(refresh);
    p.add(list);

    let rows = [];
    const rebuild = async () => {
        for (const row of rows)
            list.remove(row);
        rows = [];

        let players = new Map();
        try {
            players = await runningPlayers();
        } catch (e) {
            console.warn(`Encore prefs: cannot list players: ${e.message}`);
        }
        const blocked = settings.get_strv('blocked-players');
        for (const key of blocked) {
            if (!players.has(key))
                players.set(key, key);
        }

        if (players.size === 0) {
            const empty = new Adw.ActionRow({
                title: _('No players running'),
                subtitle: _('Start a music player and press refresh'),
            });
            list.add(empty);
            rows.push(empty);
            return;
        }

        const sorted = [...players].sort((a, b) => a[1].localeCompare(b[1]));
        for (const [key, identity] of sorted) {
            const row = new Adw.SwitchRow({
                title: identity,
                subtitle: key,
                active: !blocked.includes(key),
            });
            row._encoreKey = key;
            row.connect('notify::active', () => {
                if (syncing)
                    return;
                const current = new Set(settings.get_strv('blocked-players'));
                if (row.active)
                    current.delete(key);
                else
                    current.add(key);
                settings.set_strv('blocked-players', [...current]);
            });
            list.add(row);
            rows.push(row);
        }
    };

    // Keep the switches in step when the list changes elsewhere (e.g. after
    // "Restore defaults for this page").
    let syncing = false;
    const syncRows = () => {
        const blocked = settings.get_strv('blocked-players');
        syncing = true;
        for (const row of rows) {
            if (row._encoreKey !== undefined)
                row.active = !blocked.includes(row._encoreKey);
        }
        syncing = false;
    };
    const syncId = settings.connect('changed::blocked-players', syncRows);
    p.connect('destroy', () => settings.disconnect(syncId));

    refresh.connect('clicked', () => rebuild());
    rebuild();
    finishPage(p, window);
    return p;
}
