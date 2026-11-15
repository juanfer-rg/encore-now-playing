import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {findLineIndex} from '../lyrics/lrc.js';

// Show a line slightly early: the eye needs time to find it.
const LEAD_MS = 250;

function wrappingLabel(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/**
 * Scrollable lyrics. Synced lyrics follow the playback position and each
 * line can be clicked to jump there; plain lyrics are shown as text.
 *
 * Signals:
 *  - seek-requested(ms)
 */
export const LyricsView = GObject.registerClass({
    Signals: {
        'seek-requested': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class EncoreLyricsView extends St.ScrollView {
    constructor() {
        super({
            style_class: 'encore-lyrics',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        this._box = new St.BoxLayout({
            style_class: 'encore-lyrics-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.set_child(this._box);

        this._lines = [];
        this._rows = [];
        this._current = -2;
    }

    /** Show a short status text instead of lyrics. */
    showMessage(text) {
        this._reset();
        this._box.add_child(wrappingLabel(text, 'encore-lyrics-message'));
    }

    /**
     * @param {{synced: object[], plain: string, instrumental: boolean}} lyrics
     * @param {string} instrumentalText
     */
    setLyrics(lyrics, instrumentalText) {
        this._reset();
        if (lyrics.instrumental && !lyrics.synced.length && !lyrics.plain) {
            this._box.add_child(wrappingLabel(instrumentalText, 'encore-lyrics-message'));
            return;
        }

        if (lyrics.synced.length) {
            this._lines = lyrics.synced;
            for (const line of this._lines) {
                const button = new St.Button({
                    style_class: 'encore-lyric-line',
                    child: wrappingLabel(line.text || '♪', 'encore-lyric-text'),
                    x_expand: true,
                    can_focus: true,
                });
                button.connect('clicked', () => this.emit('seek-requested', line.time));
                this._box.add_child(button);
                this._rows.push(button);
            }
        } else {
            this._box.add_child(wrappingLabel(lyrics.plain, 'encore-lyrics-plain'));
        }
        this.vadjustment.value = 0;
    }

    /** @param {number} us - playback position in microseconds */
    setPosition(us) {
        if (!this._lines.length)
            return;
        const index = findLineIndex(this._lines, us / 1000 + LEAD_MS);
        if (index === this._current)
            return;

        this._rows[this._current]?.remove_style_pseudo_class('current');
        this._current = index;
        const row = this._rows[index];
        if (!row)
            return;
        row.add_style_pseudo_class('current');

        if (this.mapped) {
            // Keep the current line around the upper third of the view.
            const adjustment = this.vadjustment;
            const [, y] = row.get_position();
            const target = Math.max(0, Math.min(y - adjustment.page_size / 3,
                adjustment.upper - adjustment.page_size));
            adjustment.ease(target, {duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _reset() {
        this._box.destroy_all_children();
        this._lines = [];
        this._rows = [];
        this._current = -2;
    }
});
