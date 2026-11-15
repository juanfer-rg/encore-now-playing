import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Squiggly line in the style of Android's media controls: a sine wave that
// flows while music plays and flattens into a straight line when paused.

const TAU = Math.PI * 2;
const PHASE_SPEED = TAU / 1600; // radians per millisecond (one wavelength in 1.6 s)
const AMPLITUDE_MS = 350; // time to grow or flatten

/**
 * Drives the animation of one actor: advances the phase on every frame and
 * eases the amplitude towards 1 (playing) or 0 (paused). Frames only run
 * while the actor is mapped and something is moving.
 *
 * Optional hooks: `onTick(dt)` runs on every frame (dt in ms) before the
 * repaint, and `keepAlive()` can keep frames running after the amplitude
 * reached 0 (e.g. while spectrum peaks are still falling).
 */
export class WaveAnimator {
    constructor(actor, {onTick = null, keepAlive = null} = {}) {
        this._actor = actor;
        this._onTick = onTick;
        this._keepAlive = keepAlive ?? (() => false);
        this._playing = false;
        this.phase = 0;
        this.amplitude = 0;
        this._last = 0;

        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._onFrame());

        actor.connectObject('notify::mapped', () => this._sync(), this);
        St.Settings.get().connectObject('notify::enable-animations', () => this._sync(), this);
    }

    get _animate() {
        return St.Settings.get().enable_animations;
    }

    get playing() {
        return this._playing;
    }

    setPlaying(playing) {
        if (this._playing === playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        const target = this._playing ? 1 : 0;
        const moving = this._actor.mapped && this._animate &&
            (this._playing || this.amplitude > 0 || this._keepAlive());

        if (!this._animate)
            this.amplitude = target;

        if (moving && !this._timeline.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._timeline.start();
        } else if (!moving && this._timeline.is_playing()) {
            this._timeline.stop();
        }
        this._actor.queue_repaint();
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._last) / 1000, 100); // ms, capped after stalls
        this._last = now;

        this.phase = (this.phase + dt * PHASE_SPEED) % TAU;
        const target = this._playing ? 1 : 0;
        const step = dt / AMPLITUDE_MS;
        this.amplitude = target > this.amplitude
            ? Math.min(target, this.amplitude + step)
            : Math.max(target, this.amplitude - step);

        this._onTick?.(dt);
        this._actor.queue_repaint();
        if (!this._playing && this.amplitude === 0 && !this._keepAlive())
            this._timeline.stop();
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
        this._actor.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        this._actor = null;
    }
}

/**
 * @param {string|null} color - CSS color such as '#3584e4'
 * @returns {Cogl.Color|null}
 */
export function parseColor(color) {
    if (!color)
        return null;
    const [ok, parsed] = Cogl.Color.from_string(color);
    return ok ? parsed : null;
}

/**
 * Add a sine-wave path from x0 to x1 to a cairo context.
 *
 * @param {object} cr - cairo context
 * @param {number} x0
 * @param {number} x1
 * @param {number} cy - vertical center
 * @param {number} amplitude - peak height in pixels (0 draws a straight line)
 * @param {number} wavelength - pixels per full wave
 * @param {number} phase - radians; increasing it moves the wave to the right
 * @param {boolean} taper - flatten the wave towards both ends
 */
export function traceWave(cr, x0, x1, cy, amplitude, wavelength, phase, taper = false) {
    const width = x1 - x0;
    if (width <= 0)
        return;
    if (amplitude <= 0.01) {
        cr.moveTo(x0, cy);
        cr.lineTo(x1, cy);
        return;
    }
    const step = Math.max(0.5, wavelength / 24);
    let first = true;
    for (let x = x0; x <= x1 + 0.01; x += step) {
        const px = Math.min(x, x1);
        const t = (px - x0) / width;
        const envelope = taper ? Math.sin(Math.PI * t) : 1;
        const y = cy + amplitude * envelope * Math.sin(TAU * (px - x0) / wavelength - phase);
        if (first)
            cr.moveTo(px, y);
        else
            cr.lineTo(px, y);
        first = false;
    }
}
