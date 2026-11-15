import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {findLineIndex} from '../lyrics/lrc.js';

// Show a line slightly early: the eye needs time to find it.
const LEAD_MS = 250;
// After the user scrolls by hand, wait this long before following the song again.
const MANUAL_SCROLL_PAUSE_US = 3_000_000;
const SCROLL_MS = 450;

function wrappingLabel(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/**
 * Lyrics in the style of Spotify: big bold lines, the current one bright,
 * the ones already sung dimmed and the upcoming ones faint. The view keeps
 * the current line in place as the song advances, pauses following for a
 * moment when the user scrolls by hand, and jumps to a line when clicked.
 * Plain (unsynced) lyrics are shown as text.
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
        this._manualUntil = 0;

        this.connect('scroll-event', () => {
            this._manualUntil = GLib.get_monotonic_time() + MANUAL_SCROLL_PAUSE_US;
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('notify::mapped', () => {
            if (this.mapped)
                this._scrollToCurrent(false);
        });
    }

    /** Bigger text in the large card layout. */
    setLarge(large) {
        if (large)
            this.add_style_class_name('large');
        else
            this.remove_style_class_name('large');
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
                button.connect('clicked', () => {
                    this._manualUntil = 0; // follow again right away
                    this.emit('seek-requested', line.time);
                });
                this._box.add_child(button);
                this._rows.push(button);
            }
            this._paint();
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
        this._current = index;
        this._paint();
        this._scrollToCurrent(true);
    }

    // Past lines dimmed, the current one bright, upcoming ones faint.
    _paint() {
        this._rows.forEach((row, i) => {
            const set = (cls, on) => (on ? row.add_style_pseudo_class(cls) : row.remove_style_pseudo_class(cls));
            set('past', i < this._current);
            set('current', i === this._current);
        });
    }

    _scrollToCurrent(animate) {
        const row = this._rows[Math.max(this._current, 0)];
        if (!row || !this.mapped || GLib.get_monotonic_time() < this._manualUntil)
            return;

        // Keep the current line a little above the middle, like Spotify.
        const adjustment = this.vadjustment;
        const [, y] = row.get_position();
        const target = Math.max(0, Math.min(y - adjustment.page_size * 0.35,
            adjustment.upper - adjustment.page_size));
        if (animate)
            adjustment.ease(target, {duration: SCROLL_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            adjustment.value = target;
    }

    _reset() {
        this._box.destroy_all_children();
        this._lines = [];
        this._rows = [];
        this._current = -2;
    }
});
