import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatTime} from '../util.js';
import {WaveAnimator, drawRibbon} from './wave.js';
import {parseHex} from '../art/palette.js';

const TICK_MS = 250;
const RESYNC_US = 5_000_000;
const KEYBOARD_SEEK_DELAY_MS = 300;

/**
 * The Shell's Slider (keeping its dragging, keyboard and accessibility
 * support) drawn in Encore's style: the played part is the ribbon (two
 * strands twisting while the track plays), the rest a thin straight line,
 * and the handle a round dot with a soft halo.
 */
const WavySlider = GObject.registerClass(
class EncoreWavySlider extends Slider {
    constructor() {
        super(0);
        this.add_style_class_name('encore-wavy-slider');
        this._colors = null;
        this._live = null; // {fraction, rate, t0}: drawn position between updates
        this._animator = new WaveAnimator(this);
        this.connect('destroy', () => {
            this._animator.destroy();
            this._animator = null;
        });
    }

    setPlaying(playing) {
        this._animator?.setPlaying(playing);
    }

    /**
     * Where the handle is drawn. The position only updates a few times per
     * second; in between, while playing, the handle keeps gliding at the
     * playback speed on every frame, so it never moves in steps.
     *
     * @param {number|null} fraction - 0..1, or null to draw `value` (dragging)
     * @param {number} ratePerUs - fraction gained per microsecond (0 when paused)
     */
    setLive(fraction, ratePerUs = 0) {
        this._live = fraction === null ? null
            : {fraction, rate: ratePerUs, t0: GLib.get_monotonic_time()};
        this.queue_repaint();
    }

    _drawnFraction() {
        if (!this._live)
            return this.maximumValue > 0 ? this.value / this.maximumValue : 0;
        const {fraction, rate, t0} = this._live;
        return Math.min(1, fraction + (GLib.get_monotonic_time() - t0) * rate);
    }

    /** @param {string[]} colors - one to three CSS hex colors, blended along the bar */
    setColors(colors) {
        const parsed = (colors ?? []).map(parseHex).filter(Boolean).slice(0, 3);
        this._colors = parsed.length ? parsed.map(c => c.map(v => v / 255)) : null;
        this.queue_repaint();
    }

    // The played part, blended across the whole bar so colors stay put
    // while it grows.
    _activeSource(node, width, alpha = 1) {
        let colors = this._colors;
        if (!colors) {
            const c = node.get_color('-barlevel-active-background-color');
            colors = [[c.red / 255, c.green / 255, c.blue / 255]];
        }
        if (colors.length === 1)
            return Cairo.SolidPattern.createRGBA(...colors[0], alpha);
        const gradient = new Cairo.LinearGradient(0, 0, width, 0);
        colors.forEach(([r, g, b], i) => gradient.addColorStopRGBA(i / (colors.length - 1), r, g, b, alpha));
        return gradient;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const cy = height / 2;

        const thickness = node.get_length('-barlevel-height') || 4;
        const radius = node.get_length('-slider-handle-radius') || 8;
        const wavelength = node.get_length('-encore-wave-wavelength') || 20;
        // The animator's energy and stretch wander, so the ribbon keeps
        // changing its height and the length of its twists.
        const amplitude = Math.min(node.get_length('-encore-wave-amplitude') || 3,
            (height - thickness) / 2) * (this._animator?.amplitude ?? 0) * (this._animator?.energy ?? 1);
        const phase = this._animator?.phase ?? 0;

        if (this.get_text_direction() === Clutter.TextDirection.RTL) {
            cr.translate(width, 0);
            cr.scale(-1, 1);
        }

        // Same geometry as Slider so clicks land where the handle is drawn.
        const fraction = this._drawnFraction();
        const handleX = radius + (width - 2 * radius) * fraction;
        const focused = this.has_key_focus() || this.hover;
        const dot = Math.max(thickness * 1.4, 5) + (focused ? 1 : 0);
        const gap = dot + thickness * 0.75;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(thickness);

        const start = thickness / 2;
        const end = width - thickness / 2;
        if (handleX - gap > start) {
            drawRibbon(cr, {
                x0: start,
                x1: handleX - gap,
                cy,
                amplitude,
                wavelength: wavelength * (this._animator?.stretch ?? 1),
                phase,
                thickness,
                source: alpha => this._activeSource(node, width, alpha),
            });
        }
        cr.setLineWidth(Math.max(1, thickness * 0.5));
        if (handleX + gap < end) {
            cr.setSourceColor(node.get_color('-barlevel-background-color'));
            cr.moveTo(handleX + gap, cy);
            cr.lineTo(end, cy);
            cr.stroke();
        }

        // Handle: a round dot with a soft halo.
        cr.setSource(this._activeSource(node, width, focused ? 0.35 : 0.2));
        cr.arc(handleX, cy, dot + 3, 0, Math.PI * 2);
        cr.fill();
        cr.setSource(this._activeSource(node, width));
        cr.arc(handleX, cy, dot, 0, Math.PI * 2);
        cr.fill();
        cr.$dispose();
    }
});

/**
 * Seek bar with elapsed/total time. Polls the player only while it is
 * running (the card is open and the player is playing): the position is
 * read from D-Bus every few seconds and advanced locally in between.
 *
 * Signals:
 *  - position(us): emitted on every tick and after seeks (used by lyrics)
 */
export const ProgressBar = GObject.registerClass({
    Signals: {
        'position': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class EncoreProgressBar extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'encore-progress',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._player = null;
        this._trackKey = '';
        this._status = '';
        this._position = 0;
        this._length = 0;
        this._running = false;
        this._dragging = false;
        this._updatingSlider = false;
        this._tickId = 0;
        this._seekId = 0;
        this._lastTick = 0;
        this._lastSync = 0;
        this._syncSerial = 0;

        this._slider = new WavySlider();
        this._slider.accessible_name = _('Track position');
        this._slider.connectObject(
            'drag-begin', () => {
                this._dragging = true;
                this._slider.setLive(null);
            },
            'drag-end', () => {
                this._dragging = false;
                this._seekToSlider();
            },
            'notify::value', () => this._onSliderValue(),
            this);
        this.add_child(this._slider);

        const times = new St.BoxLayout({style_class: 'encore-progress-times', x_expand: true});
        this._lengthLabel = new St.Label({
            style_class: 'encore-time',
            text: '0:00',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        // Elapsed time on the left, "remaining / total" on the right.
        this._elapsedLabel = new St.Label({style_class: 'encore-time', text: '0:00'});
        times.add_child(this._elapsedLabel);
        times.add_child(this._lengthLabel);
        this.add_child(times);

        this.connect('destroy', () => this._onDestroy());
    }

    get position() {
        return this._position;
    }

    /** Colors for the played part and the handle (one to three, blended). */
    setColors(colors) {
        this._slider.setColors(colors);
    }

    setPlayer(player) {
        this._player = player;
        this._trackKey = '';
        this._status = '';
        this.update();
    }

    /** Start or stop polling (the card is visible or not). */
    setRunning(running) {
        if (this._running === running)
            return;
        this._running = running;
        if (running)
            this._sync();
        this._updateTimer();
    }

    /** Called whenever the player's state changed. */
    update() {
        const player = this._player;
        this._length = player?.metadata.length ?? 0;
        this.visible = this._length > 0;
        this._slider.setPlaying(!!player?.isPlaying && this._length > 0);
        this._slider.reactive = !!player?.canSeek;
        this._slider.can_focus = this._slider.reactive;

        const trackKey = player?.trackKey ?? '';
        const status = player?.status ?? '';
        if (trackKey !== this._trackKey || status !== this._status) {
            if (trackKey !== this._trackKey)
                this._position = 0;
            this._trackKey = trackKey;
            this._status = status;
            this._sync();
        }
        this._updateTimer();
        this._render();
    }

    /** The player reported a jump (Seeked signal). */
    onSeeked(position) {
        this._position = position;
        this._lastSync = GLib.get_monotonic_time();
        this._render();
    }

    _updateTimer() {
        const want = this._running && this._player?.isPlaying && this._length > 0;
        if (want && !this._tickId) {
            this._lastTick = GLib.get_monotonic_time();
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!want && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        if (!this._dragging)
            this._position = Math.min(this._position + (now - this._lastTick), this._length);
        this._lastTick = now;
        if (now - this._lastSync > RESYNC_US)
            this._sync();
        this._render();
    }

    async _sync() {
        const player = this._player;
        if (!player || !this._running)
            return;
        const serial = ++this._syncSerial;
        this._lastSync = GLib.get_monotonic_time();
        const position = await player.getPosition();
        // Ignore answers that arrive after the player or track changed.
        if (serial !== this._syncSerial || player !== this._player || position === null)
            return;
        this._position = position;
        this._lastTick = GLib.get_monotonic_time();
        this._render();
    }

    _render() {
        if (!this._dragging) {
            const fraction = this._length > 0 ? Math.min(this._position / this._length, 1) : 0;
            this._updatingSlider = true;
            this._slider.value = fraction;
            this._updatingSlider = false;
            const playing = this._running && this._player?.isPlaying && this._length > 0;
            this._slider.setLive(fraction, playing ? 1 / this._length : 0);
        }
        const shown = this._dragging ? this._slider.value * this._length : this._position;
        this._setTimes(shown);
        this.emit('position', shown);
    }

    // "0:10" on the left; "-2:55 / 3:05" (remaining / total) on the right.
    _setTimes(elapsed) {
        this._elapsedLabel.text = formatTime(elapsed);
        const remaining = formatTime(Math.max(0, this._length - elapsed));
        this._lengthLabel.text = `-${remaining} / ${formatTime(this._length)}`;
    }

    _onSliderValue() {
        if (this._updatingSlider)
            return;
        if (this._dragging) {
            this._setTimes(this._slider.value * this._length);
            return;
        }
        // Keyboard or scroll wheel: wait until the user stops pressing.
        if (this._seekId)
            GLib.source_remove(this._seekId);
        this._seekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEYBOARD_SEEK_DELAY_MS, () => {
            this._seekId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToSlider() {
        if (!this._player?.canSeek || this._length <= 0)
            return;
        const target = this._slider.value * this._length;
        this._player.seekTo(target, this._position);
        this._position = target;
        this._lastSync = GLib.get_monotonic_time();
        this._syncSerial++; // a pending read would now be stale
        this._render();
    }

    _onDestroy() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._seekId)
            GLib.source_remove(this._seekId);
        this._tickId = 0;
        this._seekId = 0;
        this._player = null;
    }
});
