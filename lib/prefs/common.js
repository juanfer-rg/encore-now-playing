import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

// Helpers shared by the preference pages. GTK/Adw only: never import Shell
// modules here, prefs run in a separate process.

export function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function spinRow(settings, key, title, {min, max, step = 1, subtitle = ''}) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
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
    return row;
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

export function page(title, iconName) {
    return new Adw.PreferencesPage({title, icon_name: iconName});
}
