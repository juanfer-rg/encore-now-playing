import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buttonRow, finishPage, group, page, spinRow, switchRow} from './common.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

async function clearArtCache() {
    // Same directory as in lib/art/artCache.js, which is not imported here
    // to keep libsoup out of the preferences process.
    const dir = Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'encore-now-playing', 'art']));
    let enumerator;
    try {
        enumerator = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return 0;
        throw e;
    }
    let count = 0;
    try {
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (infos.length === 0)
                break;
            for (const info of infos) {
                await dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_DEFAULT, null);
                count++;
            }
        }
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return count;
}

export function buildBehaviorPage(settings, window, metadata) {
    const p = page(_('Behavior'), 'preferences-system-symbolic');

    const playback = group(_('Playback'));
    playback.add(switchRow(settings, 'pause-others-on-play', _('Pause other players'),
        _('When a player starts playing, pause the rest')));
    playback.add(switchRow(settings, 'click-art-focuses-window', _('Click the artwork to show the player'),
        _('Brings the player’s window to the front')));
    p.add(playback);

    const integration = group(_('GNOME integration'));
    integration.add(switchRow(settings, 'hide-native-player', _('Hide the built-in media player'),
        _('Removes GNOME’s own player from the notification list. Relies on GNOME internals and may stop working after a GNOME update.')));
    p.add(integration);

    const lyrics = group(_('Lyrics'));
    lyrics.add(switchRow(settings, 'lyrics-online-lookup', _('Look up lyrics online'),
        _('Sends the artist, title, album and duration of the current track to lrclib.net and lyrics.ovh. Lyrics provided by the player are always used first.')));
    p.add(lyrics);

    const cache = group(_('Album art cache'), _('Artwork downloaded from the internet is kept in ~/.cache/encore-now-playing.'));
    cache.add(spinRow(settings, 'art-cache-size-mb', _('Maximum size'), {
        min: 5, max: 500, step: 5, subtitle: _('In MB'),
    }));
    const clear = buttonRow(_('Clear cache'));
    clear.connect('activated', async () => {
        clear.sensitive = false;
        try {
            const n = await clearArtCache();
            window.add_toast(new Adw.Toast({
                title: ngettext('Removed %d file', 'Removed %d files', n).replace('%d', String(n)),
            }));
        } catch (e) {
            window.add_toast(new Adw.Toast({title: e.message}));
        } finally {
            clear.sensitive = true;
        }
    });
    cache.add(clear);
    p.add(cache);

    finishPage(p, window);

    const about = group(_('About'));
    about.add(new Adw.ActionRow({
        title: metadata.name,
        subtitle: _('Version %s').replace('%s', metadata['version-name'] ?? '?'),
    }));
    const website = new Adw.ActionRow({title: _('Website'), subtitle: metadata.url, activatable: true});
    website.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    website.connect('activated', () => {
        new Gtk.UriLauncher({uri: metadata.url}).launch(window, null, null);
    });
    about.add(website);
    p.add(about);

    return p;
}
