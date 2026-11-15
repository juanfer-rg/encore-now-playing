import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * One player in the sidebar: its app icon, highlighted when it is the one
 * shown in the card, with a small dot under it while it is playing.
 */
const PlayerTab = GObject.registerClass(
class EncorePlayerTab extends St.Button {
    constructor(player, manager) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        super({
            style_class: 'encore-tab',
            child: box,
            can_focus: true,
            accessible_name: player.app?.get_name() ?? player.identity,
        });
        this.player = player;

        this._icon = new St.Icon({
            style_class: 'encore-tab-icon',
            icon_size: 24,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._dot = new St.Widget({
            style_class: 'encore-tab-dot',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._dot);

        this.connect('clicked', () => manager.setActive(player));
        player.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    setAccent(color) {
        this._accent = color;
        this._sync();
    }

    setChecked(checked) {
        if (checked)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }

    _sync() {
        const gicon = this.player.gicon;
        this._icon.gicon = gicon;
        if (!gicon)
            this._icon.icon_name = 'audio-x-generic-symbolic';
        // Keep the dot's space so icons do not jump when playback changes.
        this._dot.opacity = this.player.isPlaying ? 255 : 0;
        this._dot.style = this._accent ? `background-color: ${this._accent};` : null;
    }
});

/**
 * Vertical strip on the left of the card with one icon per running player.
 * Only shown when there is more than one; clicking an icon shows that
 * player in the card.
 */
export const PlayerSidebar = GObject.registerClass(
class EncorePlayerSidebar extends St.BoxLayout {
    constructor(manager) {
        super({
            style_class: 'encore-sidebar',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
        });
        this._manager = manager;
        this._accent = null;
    }

    /** Rebuild the icons; returns how many players are listed. */
    rebuild() {
        this.destroy_all_children();
        const players = this._manager.players;
        for (const player of players) {
            const tab = new PlayerTab(player, this._manager);
            tab.setAccent(this._accent);
            this.add_child(tab);
        }
        this.syncActive();
        return players.length;
    }

    syncActive() {
        const active = this._manager.active;
        for (const tab of this.get_children())
            tab.setChecked(tab.player === active);
    }

    setAccent(color) {
        this._accent = color;
        for (const tab of this.get_children())
            tab.setAccent(color);
    }
});
