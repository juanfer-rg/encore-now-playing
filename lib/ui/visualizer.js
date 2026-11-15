import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {parseHex} from '../art/palette.js';
import {Drift, WaveAnimator, drawRibbon} from './wave.js';

// The visualizers are animations, not an analysis of the audio: GNOME Shell
// has no access to the sound itself without spawning a capture process.
// They move while something plays and settle when playback stops.

const TAU = Math.PI * 2;

// Lissajous figures for the orbit style: [x frequency, y frequency, phase].
// An ellipse, a figure eight, a pretzel, a three-lobed knot and more.
const FIGURES = [
    [1, 1, Math.PI / 2],
    [1, 2, 0],
    [2, 1, Math.PI / 2],
    [2, 3, Math.PI / 4],
    [3, 2, Math.PI / 2],
    [1, 3, Math.PI / 2],
    [3, 4, Math.PI / 3],
];

/**
 * The top bar visualizer, always shown, in one of three styles:
 *
 *  - wave: Encore's ribbon, two strands twisting around each other
 *  - bars: rounded bars, mirrored around the middle, that rise and fall
 *  - orbit: two dots with trails tracing figures that morph into each other
 *  - disc: a little record that spins, pulses with the beat and now and
 *    then gets "scratched" backwards
 *
 * None of them loops the same way: speed, height, the bars' peak and beats,
 * the orbit's figure and the disc's spin all wander at random, with smooth
 * transitions.
 *
 * Every style is drawn in the panel's text color (white), or, with album art
 * colors on, in a horizontal blend of up to three colors of the artwork.
 */
export const PanelVisualizer = GObject.registerClass(
class EncorePanelVisualizer extends St.DrawingArea {
    constructor() {
        super({
            style_class: 'encore-wave',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._style = 'wave';
        this._colors = null; // [[r, g, b] 0..1], or null for the text color
        this._time = 0; // ms of animation, drives the bars

        // Bars: where the peak sits, how loud it is, and random beats.
        this._focus = new Drift(0.2, 0.8, 1500, 4000);
        this._loudness = new Drift(0.6, 1.0, 1200, 3500);
        this._beat = 0;
        this._nextBeat = 400;

        // Orbit: the figure (morphing between Lissajous curves), its size
        // and an angle that advances at a wandering speed.
        this._figure = 0;
        this._nextFigure = 0;
        this._morph = 1;
        this._figureHold = 5000;
        this._orbitAngle = 0;
        this._orbitSpeed = new Drift(0.7, 1.5);
        this._orbitSize = new Drift(0.72, 1.0, 2000, 5000);

        // Disc: spin angle at a wandering speed, and an occasional scratch.
        this._discAngle = 0;
        this._discSpeed = new Drift(0.55, 1.6, 2500, 6000);
        this._scratch = 0; // 0..1 envelope of a backwards scratch
        this._scratchAge = -1;
        this._nextScratch = 6000 + Math.random() * 6000;

        this._animator = new WaveAnimator(this, {onTick: dt => this._tick(dt)});
        this.connect('destroy', () => {
            this._animator.destroy();
            this._animator = null;
        });
    }

    /** @param {'wave'|'bars'|'orbit'|'disc'} style */
    setStyle(style) {
        if (!['wave', 'bars', 'orbit', 'disc'].includes(style))
            style = 'wave';
        if (style === this._style)
            return;
        this.remove_style_class_name(this._style);
        this._style = style;
        this.add_style_class_name(style);
        this.queue_repaint();
    }

    setPlaying(playing) {
        this._animator?.setPlaying(playing);
    }

    /** @param {string[]|null} colors - up to three CSS hex colors, or null for white */
    setColors(colors) {
        const parsed = (colors ?? []).map(parseHex).filter(Boolean).slice(0, 3);
        this._colors = parsed.length ? parsed.map(c => c.map(v => v / 255)) : null;
        this.queue_repaint();
    }

    // ---- Variation -------------------------------------------------------------

    _tick(dt) {
        this._time += dt;
        if (this._style === 'bars' || this._style === 'disc') {
            // A beat now and then, decaying quickly, like a kick drum.
            this._nextBeat -= dt;
            if (this._nextBeat <= 0 && this._animator.playing) {
                this._beat = 0.6 + 0.4 * Math.random();
                this._nextBeat = 350 + Math.random() * 650;
            }
            this._beat *= Math.exp(-dt / 170);
        }
        if (this._style === 'bars') {
            this._focus.tick(dt);
            this._loudness.tick(dt);
        } else if (this._style === 'disc') {
            this._tickDisc(dt);
        } else if (this._style === 'orbit') {
            this._orbitAngle += dt / 1000 * 2.6 * this._orbitSpeed.tick(dt);
            this._orbitSize.tick(dt);
            if (this._morph < 1) {
                this._morph = Math.min(1, this._morph + dt / 1600);
                if (this._morph === 1)
                    this._figure = this._nextFigure;
            } else if ((this._figureHold -= dt) <= 0) {
                // Morph to a different figure.
                this._nextFigure = (this._figure + 1 + Math.floor(Math.random() * (FIGURES.length - 1))) % FIGURES.length;
                this._morph = 0;
                this._figureHold = 5000 + Math.random() * 5000;
            }
        }
    }

    _tickDisc(dt) {
        // Now and then, a quick backwards scratch (~0.5 s) and back.
        if (this._scratchAge >= 0) {
            this._scratchAge += dt;
            this._scratch = Math.sin(Math.PI * Math.min(1, this._scratchAge / 520));
            if (this._scratchAge >= 520) {
                this._scratchAge = -1;
                this._scratch = 0;
            }
        } else if ((this._nextScratch -= dt) <= 0 && this._animator.playing) {
            this._scratchAge = 0;
            this._nextScratch = 7000 + Math.random() * 8000;
        }
        // Spins at about 33 rpm × a wandering factor; slows to a stop when paused.
        const speed = 3.5 * this._discSpeed.tick(dt) * (1 - 2.4 * this._scratch);
        this._discAngle += dt / 1000 * speed * this._animator.amplitude;
    }

    // ---- Drawing -------------------------------------------------------------

    /** A horizontal blend of the colors (or the text color) at `alpha`. */
    _source(node, width, alpha = 1) {
        let colors = this._colors;
        if (!colors) {
            const fg = node.get_foreground_color();
            colors = [[fg.red / 255, fg.green / 255, fg.blue / 255]];
        }
        if (colors.length === 1) {
            const [r, g, b] = colors[0];
            return Cairo.SolidPattern.createRGBA(r, g, b, alpha);
        }
        const gradient = new Cairo.LinearGradient(0, 0, width, 0);
        colors.forEach(([r, g, b], i) =>
            gradient.addColorStopRGBA(i / (colors.length - 1), r, g, b, alpha));
        return gradient;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        if (this._style === 'bars')
            this._drawBars(cr, node, width, height);
        else if (this._style === 'orbit')
            this._drawOrbit(cr, node, width, height);
        else if (this._style === 'disc')
            this._drawDisc(cr, node, width, height);
        else
            this._drawWave(cr, node, width, height);
        cr.$dispose();
    }

    _drawWave(cr, node, width, height) {
        const thickness = node.get_length('-encore-wave-thickness') || 2;
        const wavelength = node.get_length('-encore-wave-wavelength') || 10;
        const maxAmplitude = Math.min(node.get_length('-encore-wave-amplitude') || 3,
            (height - thickness) / 2);

        const pad = thickness / 2;
        drawRibbon(cr, {
            x0: pad,
            x1: width - pad,
            cy: height / 2,
            amplitude: maxAmplitude * this._animator.amplitude * this._animator.energy,
            wavelength: wavelength * this._animator.stretch,
            phase: this._animator.phase,
            thickness,
            taper: true,
            source: alpha => this._source(node, width, alpha),
        });
    }

    _drawBars(cr, node, width, height) {
        const barWidth = node.get_length('-encore-bar-width') || 3;
        const gap = node.get_length('-encore-bar-gap') || 2;
        const n = Math.max(1, Math.floor((width + gap) / (barWidth + gap)));
        const offset = (width - (n * (barWidth + gap) - gap)) / 2 + barWidth / 2;
        const cy = height / 2;
        const maxHalf = (height - barWidth) / 2;
        const t = this._time / 1000;
        const amp = this._animator.amplitude;
        const focus = this._focus.value;
        const loud = this._loudness.value;

        cr.setSource(this._source(node, width));
        cr.setLineWidth(barWidth);
        for (let i = 0; i < n; i++) {
            const u = n > 1 ? i / (n - 1) : 0.5;
            // The peak wanders from side to side.
            const envelope = 0.5 + 0.5 * Math.exp(-((u - focus) ** 2) / 0.09);
            // Three sines per bar with their own speeds, plus the beat.
            const motion = 0.45 +
                0.3 * Math.sin(t * (4.2 + i * 0.43) + i * 1.7) +
                0.2 * Math.sin(t * (6.9 + i * 0.29) + i * 0.9) +
                0.1 * Math.sin(t * 11.3 + i * 2.3) +
                0.35 * this._beat * envelope;
            const half = maxHalf * envelope * loud * Math.min(1, Math.max(0, motion)) * amp;
            const x = offset + i * (barWidth + gap);
            // A round cap on a zero-length line draws a dot when idle.
            cr.moveTo(x, cy - half);
            cr.lineTo(x, cy + half);
        }
        cr.stroke();
    }

    /** Position of one dot at `angle`, blending the current and next figure. */
    _orbitPoint(angle, offset, rx, ry, cx, cy) {
        const point = ([a, b, delta]) => [
            Math.sin(a * angle + offset),
            Math.sin(b * angle + offset + delta),
        ];
        const [x0, y0] = point(FIGURES[this._figure]);
        const [x1, y1] = point(FIGURES[this._nextFigure]);
        const m = this._morph * this._morph * (3 - 2 * this._morph);
        return [cx + rx * (x0 + (x1 - x0) * m), cy + ry * (y0 + (y1 - y0) * m)];
    }

    _drawOrbit(cr, node, width, height) {
        const dot = node.get_length('-encore-dot-radius') || 1.8;
        const cx = width / 2, cy = height / 2;
        const scale = this._animator.amplitude * this._orbitSize.value;
        const rx = (width / 2 - dot - 1) * scale;
        const ry = (height / 2 - dot - 1) * scale;
        const trail = 16;

        // Two dots half a turn apart, each with a fading trail behind it.
        for (const offset of [0, Math.PI]) {
            for (let k = trail; k >= 0; k--) {
                const [x, y] = this._orbitPoint(this._orbitAngle - k * 0.05, offset, rx, ry, cx, cy);
                const fade = 1 - k / (trail + 1);
                cr.setSource(this._source(node, width, k === 0 ? 1 : 0.85 * fade));
                cr.arc(x, y, k === 0 ? dot : dot * (0.35 + 0.45 * fade), 0, TAU);
                cr.fill();
            }
        }
    }

    _drawDisc(cr, node, width, height) {
        const line = node.get_length('-encore-wave-thickness') || 1.4;
        const cx = width / 2, cy = height / 2;
        const amp = this._animator.amplitude;
        // Pulses a little with the beat.
        const r = (Math.min(width, height) / 2 - line) * (0.94 + 0.06 * this._beat * amp);
        const a = this._discAngle;

        cr.setLineWidth(line);
        cr.setSource(this._source(node, width));
        cr.arc(cx, cy, r, 0, TAU);
        cr.stroke();

        // Grooves, brighter on the beat.
        cr.setLineWidth(line * 0.6);
        cr.setSource(this._source(node, width, 0.28 + 0.3 * this._beat * amp));
        for (const f of [0.74, 0.56]) {
            cr.newSubPath();
            cr.arc(cx, cy, r * f, 0, TAU);
        }
        cr.stroke();

        // Light glinting off the record: two arcs that turn with it, and a
        // faint one turning the other way.
        cr.setLineWidth(line * 1.15);
        cr.setSource(this._source(node, width, 0.45 + 0.55 * amp));
        for (const start of [a, a + Math.PI]) {
            cr.newSubPath();
            cr.arc(cx, cy, r * 0.86, start, start + 0.85);
        }
        cr.stroke();
        cr.setLineWidth(line * 0.7);
        cr.setSource(this._source(node, width, 0.35 * amp));
        cr.newSubPath();
        cr.arc(cx, cy, r * 0.64, -a * 0.6, -a * 0.6 + 1.1);
        cr.stroke();

        // Label in the middle.
        cr.setSource(this._source(node, width));
        cr.arc(cx, cy, Math.max(1.3, r * 0.2), 0, TAU);
        cr.fill();
    }
});
