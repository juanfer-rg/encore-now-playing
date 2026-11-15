import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/**
 * A row of chips, one per running player. Clicking a chip makes that player
 * active. Hidden when there is only one player.
 */
export const PlayerSwitcher = GObject.registerClass(
class EncorePlayerSwitcher extends St.ScrollView {
    constructor(manager) {
        super({
            style_class: 'encore-switcher',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._manager = manager;
        this._box = new St.BoxLayout({style_class: 'encore-switcher-box'});
        this.set_child(this._box);
        this._chips = new Map(); // player -> button
    }

    /** Rebuild the chips from the manager's player list. */
    rebuild() {
        this._box.destroy_all_children();
        this._chips.clear();

        for (const player of this._manager.players) {
            const content = new St.BoxLayout({style_class: 'encore-chip-content'});
            content.add_child(new St.Icon({
                gicon: player.gicon,
                fallback_icon_name: 'audio-x-generic-symbolic',
                icon_name: player.gicon ? null : 'audio-x-generic-symbolic',
                icon_size: 16,
                style_class: 'encore-chip-icon',
            }));
            content.add_child(new St.Label({
                text: player.app?.get_name() ?? player.identity,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const chip = new St.Button({
                style_class: 'encore-chip',
                child: content,
                can_focus: true,
                toggle_mode: false,
                accessible_name: player.identity,
            });
            chip.connect('clicked', () => this._manager.setActive(player));
            this._box.add_child(chip);
            this._chips.set(player, chip);
        }
        this.syncActive();
    }

    /** Highlight the active player's chip. */
    syncActive() {
        const active = this._manager.active;
        for (const [player, chip] of this._chips) {
            if (player === active)
                chip.add_style_pseudo_class('checked');
            else
                chip.remove_style_pseudo_class('checked');
        }
    }

    get count() {
        return this._chips.size;
    }
});
