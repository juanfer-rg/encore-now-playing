import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {group, page, sensitiveWhen, spinRow, switchRow} from './common.js';

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });

    const sync = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            button.rgba = rgba;
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));

    button.connect('notify::rgba', () => {
        const {red, green, blue} = button.rgba;
        const hex = `#${[red, green, blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });

    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: _('Reset'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));

    row.add_suffix(reset);
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

export function buildCardPage(settings) {
    const p = page(_('Card'), 'audio-x-generic-symbolic');

    const layout = group(_('Layout'));
    layout.add(spinRow(settings, 'card-width', _('Width'), {
        min: 280, max: 600, step: 10, subtitle: _('In pixels'),
    }));
    layout.add(switchRow(settings, 'show-player-switcher', _('Player switcher'),
        _('Shown when more than one player is running')));
    layout.add(switchRow(settings, 'show-volume', _('Volume slider')));
    layout.add(switchRow(settings, 'show-shuffle-repeat', _('Shuffle and repeat buttons')));
    layout.add(switchRow(settings, 'show-lyrics-button', _('Lyrics button')));
    p.add(layout);

    const colors = group(_('Colors'));
    colors.add(switchRow(settings, 'dynamic-colors', _('Colors from album art'),
        _('Tint the card with the artwork’s dominant colors')));
    const accent = colorRow(settings, 'accent-color', _('Accent color'));
    sensitiveWhen(settings, 'dynamic-colors', accent, true);
    colors.add(accent);
    p.add(colors);

    return p;
}
