import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatTime} from '../util.js';

const TICK_MS = 250;
const RESYNC_US = 5_000_000;
const KEYBOARD_SEEK_DELAY_MS = 300;

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

        this._slider = new Slider(0);
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
        this._slider.style = color
            ? `-barlevel-active-background-color: ${color}; -slider-handle-border-color: ${color};`
            : null;
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
        this._slider.reactive = !!player?.canSeek;
        this._slider.can_focus = this._slider.reactive;
        this._lengthLabel.text = formatTime(this._length);

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
        this._elapsedLabel.text = formatTime(shown);
        this.emit('position', shown);
    }

    _onSliderValue() {
        if (this._updatingSlider)
            return;
        if (this._dragging) {
            this._elapsedLabel.text = formatTime(this._slider.value * this._length);
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
