import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Helpers shared by the preference pages. GTK/Adw only: never import Shell
// modules here, prefs run in a separate process.
//
// Changed options are marked with a dot before their title (the dot always
// takes its space, so nothing moves when it appears), and each page ends
// with a "Restore defaults" button that lists what it will change and asks
// for confirmation. There are no per-row reset buttons: they appeared next
// to the controls and were easy to click by accident.

let currentPage = null;

/** Start a preferences page; the rows created after this belong to it. */
export function page(title, iconName) {
    const p = new Adw.PreferencesPage({title, icon_name: iconName});
    p._encoreOptions = [];
    currentPage = p;
    return p;
}

function isChanged(settings, key) {
    return !settings.get_value(key).equal(settings.get_default_value(key));
}

/**
 * Track an option of the current page: mark its row while it differs from
 * the default, and remember it for the page's "Restore defaults" button.
 *
 * @param {Adw.PreferencesRow} row
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title - name shown in the confirmation
 * @param {function(GLib.Variant): string} describe - value as shown to the user
 * @returns {Adw.PreferencesRow} the same row
 */
export function track(row, settings, key, title, describe) {
    const dot = new Gtk.Label({
        label: '●',
        valign: Gtk.Align.CENTER,
        css_classes: ['accent', 'caption'],
        tooltip_text: _('Changed from the default'),
    });
    const sync = () => {
        // Opacity, not visibility: the dot keeps its space either way.
        dot.opacity = isChanged(settings, key) ? 1 : 0;
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    row.add_prefix(dot);
    currentPage?._encoreOptions.push({settings, key, title, describe});
    return row;
}

/** Track an option that has no row of its own (e.g. a list of switches). */
export function trackKey(settings, key, title, describe) {
    currentPage?._encoreOptions.push({settings, key, title, describe});
}

const onOff = v => (v.get_boolean() ? _('On') : _('Off'));

export function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return track(row, settings, key, title, onOff);
}

export function spinRow(settings, key, title, {min, max, step = 1, subtitle = ''}) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return track(row, settings, key, title, v => String(v.unpack()));
}

/**
 * A ComboRow bound to a string/enum key.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title
 * @param {[string, string][]} choices - [value, label] pairs
 * @param {string} subtitle
 * @returns {Adw.ComboRow}
 */
export function comboRow(settings, key, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(index, 0);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    const label = v => choices.find(([value]) => value === v.unpack())?.[1] ?? v.unpack();
    return track(row, settings, key, title, label);
}

/**
 * End the current page: add a "Restore defaults" button that resets every
 * option of this page after showing what will change.
 *
 * @param {Adw.PreferencesPage} p
 * @param {Adw.PreferencesWindow} window
 */
export function finishPage(p, window) {
    const options = p._encoreOptions;
    const restoreGroup = new Adw.PreferencesGroup();
    const button = new Adw.ButtonRow({title: _('Restore defaults for this page')});
    button.add_css_class('destructive-action');
    restoreGroup.add(button);
    p.add(restoreGroup);

    const changed = () => options.filter(o => isChanged(o.settings, o.key));
    const syncButton = () => {
        button.sensitive = changed().length > 0;
    };
    syncButton();
    for (const o of options) {
        const id = o.settings.connect(`changed::${o.key}`, syncButton);
        button.connect('destroy', () => o.settings.disconnect(id));
    }

    button.connect('activated', () => {
        const list = changed();
        if (list.length === 0)
            return;
        const lines = list.map(o =>
            `• ${o.title}: ${o.describe(o.settings.get_value(o.key))} → ${o.describe(o.settings.get_default_value(o.key))}`);
        const dialog = new Adw.AlertDialog({
            heading: _('Restore defaults?'),
            body: `${_('These options on this page will go back to their defaults:')}\n\n${lines.join('\n')}`,
            default_response: 'cancel',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Restore defaults'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'reset')
                list.forEach(o => o.settings.reset(o.key));
        });
        dialog.present(window);
    });
    if (currentPage === p)
        currentPage = null;
}

/** Make `row` sensitive only while the boolean `key` is true. */
export function sensitiveWhen(settings, key, row, invert = false) {
    settings.bind(key, row, 'sensitive',
        invert ? Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN
            : Gio.SettingsBindFlags.GET);
}

export function group(title, description = '') {
    return new Adw.PreferencesGroup({title, description});
}
