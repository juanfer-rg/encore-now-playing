import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Encore's "ribbon": two thin strands in counter-phase that twist around each
// other while music plays, with a slow swell travelling along them, and
// settle into one straight line when playback stops.

const TAU = Math.PI * 2;
const PHASE_SPEED = TAU / 1150; // radians per millisecond (one twist every 1.15 s)
const AMPLITUDE_MS = 350; // time to grow or flatten

/**
 * A value that wanders: every few seconds it picks a new random target and
 * glides there with an ease-in-out curve, so the animations keep changing
 * without ever jumping.
 */
export class Drift {
    /**
     * @param {number} min
     * @param {number} max
     * @param {number} minHoldMs - shortest time between targets
     * @param {number} maxHoldMs - longest time between targets
     */
    constructor(min, max, minHoldMs = 2500, maxHoldMs = 6000) {
        this._min = min;
        this._max = max;
        this._minHold = minHoldMs;
        this._maxHold = maxHoldMs;
        this.value = this._random();
        this._from = this.value;
        this._to = this.value;
        this._elapsed = 0;
        this._hold = 0;
    }

    _random() {
        return this._min + Math.random() * (this._max - this._min);
    }

    tick(dt) {
        this._elapsed += dt;
        if (this._elapsed >= this._hold) {
            this._from = this.value;
            this._to = this._random();
            this._elapsed = 0;
            this._hold = this._minHold + Math.random() * (this._maxHold - this._minHold);
        }
        const t = this._elapsed / this._hold;
        const eased = t * t * (3 - 2 * t); // smoothstep
        this.value = this._from + (this._to - this._from) * eased;
        return this.value;
    }
}

/**
 * Drives the animation of one actor: advances the phase on every frame and
 * eases the amplitude towards 1 (playing) or 0 (paused). Frames only run
 * while the actor is mapped and something is moving.
 *
 * It also varies the motion over time, so it never loops the same way:
 * `speed` (how fast it flows), `energy` (how tall it gets) and `stretch`
 * (how long each twist is) each drift between random values.
 *
 * Optional hooks: `onTick(dt)` runs on every frame (dt in ms) before the
 * repaint, and `keepAlive()` can keep frames running after the amplitude
 * reached 0 (e.g. while something is still settling).
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
        this._speed = new Drift(0.7, 1.45);
        this._energy = new Drift(0.68, 1.0, 1800, 4500);
        this._stretch = new Drift(0.82, 1.3, 3000, 7000);

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

    /** Height multiplier that wanders between 0.68 and 1. */
    get energy() {
        return this._energy.value;
    }

    /** Wavelength multiplier that wanders between 0.82 and 1.3. */
    get stretch() {
        return this._stretch.value;
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

        // Never wrapped: the travelling swell moves at a different speed than
        // the strands, so wrapping the phase would make it jump. A float keeps
        // full precision for days of playback.
        this.phase += dt * PHASE_SPEED * this._speed.tick(dt);
        this._energy.tick(dt);
        this._stretch.tick(dt);
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
 * Add one strand of the ribbon to a cairo path.
 *
 * Strand 0 is the main one; strand 1 runs in counter-phase and a little
 * lower, so the two cross at regular points and look twisted. Both are
 * scaled by a swell that travels along the line and a slow "breath" over
 * time, so the ribbon keeps changing shape instead of just sliding.
 *
 * @param {object} cr - cairo context
 * @param {number} x0
 * @param {number} x1
 * @param {number} cy - vertical center
 * @param {number} amplitude - peak height in pixels (0 draws a straight line)
 * @param {number} wavelength - pixels per full twist
 * @param {number} phase - radians; increasing it moves the ribbon to the right
 * @param {number} strand - 0 or 1
 * @param {boolean} taper - flatten towards both ends
 */
export function traceStrand(cr, x0, x1, cy, amplitude, wavelength, phase, strand = 0, taper = false) {
    const width = x1 - x0;
    if (width <= 0)
        return;
    if (amplitude <= 0.01) {
        cr.moveTo(x0, cy);
        cr.lineTo(x1, cy);
        return;
    }
    const k = TAU / wavelength;
    const scale = strand ? 0.78 : 1;
    const breath = 0.82 + 0.18 * Math.sin(phase * 0.29);
    const offset = strand ? Math.PI : 0;
    const step = Math.max(0.5, wavelength / 24);
    let first = true;
    for (let x = x0; x <= x1 + 0.01; x += step) {
        const px = Math.min(x, x1);
        const d = px - x0;
        // Taper only near the ends, so most of the ribbon moves fully.
        const envelope = taper ? Math.min(1, 1.7 * Math.sin(Math.PI * d / width)) : 1;
        // Never below 60 %: the ribbon always moves clearly.
        const swell = 0.8 + 0.2 * Math.sin(k * 0.37 * d - phase * 0.55);
        const y = cy + amplitude * scale * envelope * swell * breath * Math.sin(k * d - phase + offset);
        if (first)
            cr.moveTo(px, y);
        else
            cr.lineTo(px, y);
        first = false;
    }
}

/**
 * Draw the ribbon: the faint partner strand first, then the main one.
 *
 * @param {object} cr - cairo context (round caps and joins already set)
 * @param {object} p
 * @param {number} p.x0
 * @param {number} p.x1
 * @param {number} p.cy
 * @param {number} p.amplitude
 * @param {number} p.wavelength
 * @param {number} p.phase
 * @param {number} p.thickness - width of the main strand
 * @param {boolean} [p.taper]
 * @param {function(number): object} p.source - cairo pattern for an alpha
 */
export function drawRibbon(cr, {x0, x1, cy, amplitude, wavelength, phase, thickness, taper = false, source}) {
    cr.setSource(source(0.45));
    cr.setLineWidth(thickness * 0.65);
    traceStrand(cr, x0, x1, cy, amplitude, wavelength, phase, 1, taper);
    cr.stroke();
    cr.setSource(source(1));
    cr.setLineWidth(thickness);
    traceStrand(cr, x0, x1, cy, amplitude, wavelength, phase, 0, taper);
    cr.stroke();
}
