import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {cairoColors} from '../art/palette.js';
import {distributePlainLyrics, findLineIndex} from '../lyrics/lrc.js';

// Show a line slightly early: the eye needs time to find it.
const LEAD_MS = 250;
// After the user scrolls by hand, wait this long before following again.
const MANUAL_SCROLL_PAUSE_US = 3_000_000;
// Scroll easing: fraction of the remaining distance covered per 16 ms frame.
const SCROLL_SMOOTHING = 0.14;
const EDGE_FADE = 28; // px faded at the top and bottom
const RADIUS = 12;
const PADDING_X = 16;
const NEIGHBORS = 1; // lines on each side drawn a little larger

/**
 * Lyrics drawn with Pango on one canvas, so there is no scrollbar: the
 * current line is centered and bigger, and the view glides as the song
 * advances. Scrolling by hand pauses the following for a moment; clicking a
 * synced line seeks there.
 *
 * Signals:
 *  - seek-requested(ms)
 */
export const LyricsView = GObject.registerClass({
    Signals: {
        'seek-requested': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class EncoreLyricsView extends St.DrawingArea {
    constructor() {
        super({
            style_class: 'encore-lyrics',
            reactive: true,
            x_expand: true,
        });

        this._lines = [];
        this._seekable = false;
        this._pending = null; // lyrics waiting for the track length
        this._message = '';
        this._current = -1;
        this._length = 0;
        this._large = false;
        this._colors = null;

        this._geometry = [];
        this._geometryKey = '';
        this._scroll = 0;
        this._scrollTarget = 0;
        this._manualUntil = 0;
        this._time = 0;
        this._last = 0;

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._onFrame());
        this.connect('notify::mapped', () => this._syncTimeline());
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._syncTimeline(), this);
        this.connect('destroy', () => {
            St.Settings.get().disconnectObject(this);
            this._timeline.stop();
            this._timeline = null;
        });
    }

    // ---- Public API --------------------------------------------------------

    setLarge(large) {
        this._large = large;
        if (large)
            this.add_style_class_name('large');
        else
            this.remove_style_class_name('large');
        this._geometryKey = '';
        this.queue_repaint();
    }

    /** @param {string[]|null} colors - CSS hex colors for the backdrop */
    setColors(colors) {
        this._colors = cairoColors(colors);
        this.queue_repaint();
    }

    showMessage(text) {
        this._lines = [];
        this._pending = null;
        this._message = text;
        this._reset();
    }

    /**
     * @param {{synced: object[], plain: string, instrumental: boolean}} lyrics
     * @param {string} instrumentalText
     */
    setLyrics(lyrics, instrumentalText) {
        this._pending = null;
        this._message = '';
        if (lyrics.synced.length) {
            this._lines = lyrics.synced.map(l => ({time: l.time, text: l.text || '♪'}));
            this._seekable = true;
        } else if (lyrics.plain) {
            // Spread over the track; redone when the length is known.
            this._pending = lyrics.plain;
            this._lines = distributePlainLyrics(lyrics.plain, this._length / 1000);
            this._seekable = false;
        } else {
            this._lines = [];
            this._message = lyrics.instrumental ? instrumentalText : '';
        }
        this._reset();
    }

    setLength(us) {
        if (us === this._length)
            return;
        this._length = us;
        if (this._pending) {
            this._lines = distributePlainLyrics(this._pending, us / 1000);
            this._geometryKey = '';
        }
    }

    setPosition(us) {
        if (!this._lines.length)
            return;
        const index = findLineIndex(this._lines, us / 1000 + LEAD_MS);
        if (index === this._current)
            return;
        this._current = index;
        this._geometryKey = ''; // sizes depend on the current line
        this._syncTimeline();
        this.queue_repaint();
    }

    // ---- Input -------------------------------------------------------------

    vfunc_scroll_event(event) {
        if (!this._lines.length)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            delta = -40;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = 40;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = event.get_scroll_delta()[1] * 40;
        this._manualUntil = GLib.get_monotonic_time() + MANUAL_SCROLL_PAUSE_US;
        this._scrollTarget = this._clampScroll(this._scrollTarget + delta);
        this._syncTimeline();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._seekable || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [, y] = this.transform_stage_point(...event.get_coords());
        const top = y + this._scroll;
        const hit = this._geometry.findIndex(g => top >= g.y - 4 && top <= g.y + g.height + 4);
        if (hit >= 0) {
            this._manualUntil = 0;
            this.emit('seek-requested', this._lines[hit].time);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- Animation ---------------------------------------------------------

    // Frames run while the view is on screen: they ease the scroll and let
    // the colored backdrop drift.
    _syncTimeline() {
        if (!this._timeline)
            return;
        const want = this.mapped && St.Settings.get().enable_animations;
        if (want && !this._timeline.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._timeline.start();
        } else if (!want && this._timeline.is_playing()) {
            this._timeline.stop();
            this._scroll = this._scrollTarget;
            this.queue_repaint();
        }
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._last) / 1000, 100);
        this._last = now;
        this._time += dt;

        const k = 1 - Math.pow(1 - SCROLL_SMOOTHING, dt / 16);
        this._scroll += (this._scrollTarget - this._scroll) * k;
        if (Math.abs(this._scrollTarget - this._scroll) < 0.3)
            this._scroll = this._scrollTarget;
        this.queue_repaint();
    }

    _reset() {
        this._current = -1;
        this._geometry = [];
        this._geometryKey = '';
        this._scroll = 0;
        this._scrollTarget = 0;
        this.queue_repaint();
    }

    _clampScroll(value) {
        const last = this._geometry[this._geometry.length - 1];
        const [, height] = this.get_surface_size();
        const total = last ? last.y + last.height : 0;
        // Allow the first and last lines to reach the middle.
        return Math.min(Math.max(value, -height / 2 + (this._geometry[0]?.height ?? 0) / 2),
            Math.max(0, total - height / 2));
    }

    // ---- Drawing -----------------------------------------------------------

    _fonts(node) {
        const base = node.get_font();
        const pt = base.get_size() / Pango.SCALE || 11;
        const scale = this._large ? 1.12 : 1;
        const make = (factor, weight) => {
            const font = base.copy();
            font.set_size(Math.round(pt * factor * scale * Pango.SCALE));
            font.set_weight(weight);
            return font;
        };
        return {
            active: make(1.4, Pango.Weight.BOLD),
            neighbor: make(1.08, Pango.Weight.BOLD),
            other: make(0.98, Pango.Weight.SEMIBOLD),
        };
    }

    _measure(layout, fonts, width) {
        const key = `${width}|${this._current}|${this._large}|${this._lines.length}`;
        if (key === this._geometryKey)
            return;
        this._geometryKey = key;

        const spacing = this._large ? 12 : 9;
        let y = 0;
        this._geometry = this._lines.map((line, i) => {
            const distance = Math.abs(i - this._current);
            const kind = distance === 0 ? 'active' : distance <= NEIGHBORS ? 'neighbor' : 'other';
            layout.set_font_description(fonts[kind]);
            layout.set_text(line.text, -1);
            const [, logical] = layout.get_pixel_extents();
            const geo = {y, height: logical.height, kind};
            y += logical.height + spacing;
            return geo;
        });

        if (GLib.get_monotonic_time() >= this._manualUntil) {
            const [, height] = this.get_surface_size();
            const active = this._geometry[Math.max(this._current, 0)];
            if (active)
                this._scrollTarget = this._clampScroll(active.y + active.height / 2 - height / 2);
        }
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        if (!width || !height) {
            cr.$dispose();
            return;
        }

        const fg = node.get_foreground_color();
        const rgb = [fg.red / 255, fg.green / 255, fg.blue / 255];

        const r = RADIUS;
        cr.newSubPath();
        cr.arc(width - r, r, r, -Math.PI / 2, 0);
        cr.arc(width - r, height - r, r, 0, Math.PI / 2);
        cr.arc(r, height - r, r, Math.PI / 2, Math.PI);
        cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.clip();
        this._drawBackdrop(cr, width, height, rgb);

        const layout = PangoCairo.create_layout(cr);
        layout.set_width((width - 2 * PADDING_X) * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        layout.set_alignment(Pango.Alignment.CENTER);
        const fonts = this._fonts(node);

        if (!this._lines.length) {
            if (this._message) {
                layout.set_font_description(fonts.other);
                layout.set_text(this._message, -1);
                const [, logical] = layout.get_pixel_extents();
                cr.setSourceRGBA(...rgb, 0.6);
                cr.moveTo(PADDING_X, (height - logical.height) / 2);
                PangoCairo.show_layout(cr, layout);
            }
            cr.$dispose();
            return;
        }

        this._measure(layout, fonts, width);
        if (!this._timeline.is_playing())
            this._scroll = this._scrollTarget; // no animation: jump

        // Text into a group, then fade the top and bottom edges with a mask.
        cr.pushGroup();
        const alpha = {active: 1, neighbor: 0.62, other: 0.34};
        this._geometry.forEach((geo, i) => {
            const y = geo.y - this._scroll;
            if (y + geo.height < 0 || y > height)
                return;
            layout.set_font_description(fonts[geo.kind]);
            layout.set_text(this._lines[i].text, -1);
            cr.setSourceRGBA(...rgb, alpha[geo.kind]);
            cr.moveTo(PADDING_X, y);
            PangoCairo.show_layout(cr, layout);
        });
        cr.popGroupToSource();

        const edge = Math.min(EDGE_FADE, height / 3) / height;
        const mask = new Cairo.LinearGradient(0, 0, 0, height);
        mask.addColorStopRGBA(0, 0, 0, 0, 0);
        mask.addColorStopRGBA(edge, 0, 0, 0, 1);
        mask.addColorStopRGBA(1 - edge, 0, 0, 0, 1);
        mask.addColorStopRGBA(1, 0, 0, 0, 0);
        cr.mask(mask);
        cr.$dispose();
    }

    // A neutral tint, or soft glows in the artwork's colors drifting slowly.
    _drawBackdrop(cr, width, height, fg) {
        cr.setSourceRGBA(...fg, 0.05);
        cr.paint();
        if (!this._colors)
            return;

        const t = this._time / 1000;
        const radius = Math.max(width, height) * 0.75;
        this._colors.forEach(([r, g, b], i) => {
            const speed = 0.11 + i * 0.05;
            const cx = width * (0.5 + 0.42 * Math.sin(t * speed + i * 2.1));
            const cy = height * (0.5 + 0.38 * Math.cos(t * speed * 1.3 + i * 1.3));
            const glow = new Cairo.RadialGradient(cx, cy, 0, cx, cy, radius);
            // Fainter for light colors, which stand out more.
            const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            glow.addColorStopRGBA(0, r, g, b, 0.14 * (1 - 0.55 * light));
            glow.addColorStopRGBA(1, r, g, b, 0);
            cr.setSource(glow);
            cr.paint();
        });
    }
});
