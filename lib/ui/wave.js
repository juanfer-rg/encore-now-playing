import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const TAU = Math.PI * 2;
const PHASE_SPEED = TAU / 1150; // radians per ms: one twist every 1.15 s
const AMPLITUDE_MS = 350; // time to grow or flatten

/**
 * A value that picks a new random target every few seconds and glides there
 * with smoothstep, so the animations keep changing without ever jumping.
 */
export class Drift {
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
        const eased = t * t * (3 - 2 * t);
        this.value = this._from + (this._to - this._from) * eased;
        return this.value;
    }
}

/**
 * Drives the animation of one actor: advances the phase on every frame and
 * eases the amplitude towards 1 (playing) or 0 (paused). Frames only run
 * while the actor is mapped and something is moving. `onTick(dt)` runs on
 * every frame, before the repaint.
 */
export class WaveAnimator {
    constructor(actor, {onTick = null} = {}) {
        this._actor = actor;
        this._onTick = onTick;
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

    get playing() {
        return this._playing;
    }

    // Height multiplier.
    get energy() {
        return this._energy.value;
    }

    // Wavelength multiplier.
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
        const animate = St.Settings.get().enable_animations;
        const moving = this._actor.mapped && animate &&
            (this._playing || this.amplitude > 0);

        if (!animate)
            this.amplitude = this._playing ? 1 : 0;

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

        // Never wrapped: the swell travels at a different speed than the
        // strands, so wrapping would make it jump.
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
        if (!this._playing && this.amplitude === 0)
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
 * A horizontal blend of `colors` ([r, g, b] in 0..1) across `width`.
 *
 * @returns {Cairo.Pattern}
 */
export function blendSource(colors, width, alpha = 1) {
    if (colors.length === 1)
        return Cairo.SolidPattern.createRGBA(...colors[0], alpha);
    const gradient = new Cairo.LinearGradient(0, 0, width, 0);
    colors.forEach(([r, g, b], i) =>
        gradient.addColorStopRGBA(i / (colors.length - 1), r, g, b, alpha));
    return gradient;
}

// One strand of the ribbon. Strand 1 runs in counter-phase and a little
// lower, so the two cross at regular points and look twisted.
function traceStrand(cr, x0, x1, cy, amplitude, wavelength, phase, strand, taper) {
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
        // Never below 60 %, so the ribbon always moves clearly.
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
 * @param {Cairo.Context} cr - round caps and joins already set
 * @param {object} p
 * @param {number} p.amplitude - peak height in px (0 draws a straight line)
 * @param {number} p.wavelength - px per full twist
 * @param {number} p.phase - radians; increasing it moves the ribbon right
 * @param {number} p.thickness - width of the main strand
 * @param {boolean} [p.taper] - flatten towards both ends
 * @param {function(number): Cairo.Pattern} p.source - pattern for an alpha
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
