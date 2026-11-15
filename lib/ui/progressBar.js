import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatTime} from '../util.js';
import {WaveAnimator, parseColor, traceWave} from './wave.js';

const TICK_MS = 250;
const RESYNC_US = 5_000_000;
const KEYBOARD_SEEK_DELAY_MS = 300;

/**
 * The Shell's Slider (keeping its dragging, keyboard and accessibility
 * support) drawn Android-style: the played part is a flowing wave while the
 * track plays, the rest a straight line, and the handle a vertical pill.
 */
const WavySlider = GObject.registerClass(
class EncoreWavySlider extends Slider {
    constructor() {
        super(0);
        this.add_style_class_name('encore-wavy-slider');
        this._accent = null;
        this._animator = new WaveAnimator(this);
        this.connect('destroy', () => {
            this._animator.destroy();
            this._animator = null;
        });
    }

    setPlaying(playing) {
        this._animator?.setPlaying(playing);
    }

    setAccent(color) {
        this._accent = parseColor(color);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const cy = height / 2;

        const thickness = node.get_length('-barlevel-height') || 4;
        const radius = node.get_length('-slider-handle-radius') || 8;
        const wavelength = node.get_length('-encore-wave-wavelength') || 20;
        const amplitude = Math.min(node.get_length('-encore-wave-amplitude') || 3,
            (height - thickness) / 2) * (this._animator?.amplitude ?? 0);
        const phase = this._animator?.phase ?? 0;

        if (this.get_text_direction() === Clutter.TextDirection.RTL) {
            cr.translate(width, 0);
            cr.scale(-1, 1);
        }

        // Same geometry as Slider so clicks land where the handle is drawn.
        const fraction = this.maximumValue > 0 ? this.value / this.maximumValue : 0;
        const handleX = radius + (width - 2 * radius) * fraction;
        const focused = this.has_key_focus() || this.hover;
        const handleWidth = Math.max(thickness, 4) + (focused ? 2 : 0);
        const gap = handleWidth / 2 + thickness;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineWidth(thickness);

        const start = thickness / 2;
        const end = width - thickness / 2;
        const active = this._accent ?? node.get_color('-barlevel-active-background-color');

        if (handleX - gap > start) {
            cr.setSourceColor(active);
            traceWave(cr, start, handleX - gap, cy, amplitude, wavelength, phase);
            cr.stroke();
        }
        if (handleX + gap < end) {
            cr.setSourceColor(node.get_color('-barlevel-background-color'));
            cr.moveTo(handleX + gap, cy);
            cr.lineTo(end, cy);
            cr.stroke();
        }

        // Handle: a vertical pill.
        const handleHeight = Math.min(height, 2 * radius);
        cr.setSourceColor(active);
        cr.setLineWidth(handleWidth);
        cr.moveTo(handleX, cy - handleHeight / 2 + handleWidth / 2);
        cr.lineTo(handleX, cy + handleHeight / 2 - handleWidth / 2);
        cr.stroke();
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
            },
            'drag-end', () => {
                this._dragging = false;
                this._seekToSlider();
            },
            'notify::value', () => this._onSliderValue(),
            this);
        this.add_child(this._slider);

        const times = new St.BoxLayout({style_class: 'encore-progress-times', x_expand: true});
        this._elapsedLabel = new St.Label({style_class: 'encore-time', text: '0:00'});
        this._lengthLabel = new St.Label({
            style_class: 'encore-time',
            text: '0:00',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        times.add_child(this._elapsedLabel);
        times.add_child(this._lengthLabel);
        this.add_child(times);

        this.connect('destroy', () => this._onDestroy());
    }

    get position() {
        return this._position;
    }

    /** Accent color for the filled part and the handle. */
    setAccent(color) {
        this._slider.setAccent(color);
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
            this._updatingSlider = true;
            this._slider.value = this._length > 0 ? Math.min(this._position / this._length, 1) : 0;
            this._updatingSlider = false;
        }
        const shown = this._dragging ? this._slider.value * this._length : this._position;
        this._setTimes(shown);
        this.emit('position', shown);
    }

    // Elapsed on the left, time remaining on the right (as on Android).
    _setTimes(elapsed) {
        this._elapsedLabel.text = formatTime(elapsed);
        this._lengthLabel.text = `-${formatTime(Math.max(0, this._length - elapsed))}`;
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
