import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {hslToRgb, parseHex, rgbToHsl} from '../art/palette.js';
import {WaveAnimator, parseColor, traceWave} from './wave.js';

// The visualizers are animations, not an analysis of the audio: GNOME Shell
// has no access to the sound itself without spawning a capture process.
// They move while something plays and settle when playback stops.

const RETARGET_MS = 90; // how often the spectrum bars pick new heights
const BAR_RISE_MS = 60;
const PEAK_FALL_PER_MS = 0.0011; // fraction of the height per millisecond

// Winamp's classic visualization colors, bottom (quiet) to top (loud).
const CLASSIC = [[0.0, 0.80, 0.0], [0.95, 0.85, 0.10], [0.95, 0.22, 0.10]];
const CLASSIC_PEAK = [0.85, 0.85, 0.85];

/**
 * The top bar visualizer, in one of three styles:
 *
 *  - wave: the Android-style squiggly line
 *  - spectrum: Winamp's classic spectrum analyzer (bars with falling peaks)
 *  - scope: Winamp's classic oscilloscope
 *
 * With an accent color (album art colors on) every style uses it; without
 * one, the wave uses the panel's text color and the Winamp styles their
 * classic green-yellow-red palette.
 */
export const PanelVisualizer = GObject.registerClass(
class EncorePanelVisualizer extends St.DrawingArea {
    constructor() {
        super({
            style_class: 'encore-wave',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._style = 'wave';
        this._accent = null;
        this._levels = [];
        this._targets = [];
        this._peaks = [];
        this._sinceRetarget = 0;
        this._scopePhases = [0, 0, 0];
        this._loudness = 0.7;

        this._animator = new WaveAnimator(this, {
            onTick: dt => this._tick(dt),
            keepAlive: () => this._style === 'spectrum' && this._peaks.some(p => p > 0.01),
        });
        this.connect('destroy', () => {
            this._animator.destroy();
            this._animator = null;
        });
    }

    /** @param {'wave'|'spectrum'|'scope'} style */
    setStyle(style) {
        if (style === this._style)
            return;
        this.remove_style_class_name(this._style);
        this._style = style;
        this.add_style_class_name(style);
        this._levels = [];
        this._peaks = [];
        this.queue_repaint();
    }

    setPlaying(playing) {
        this._animator?.setPlaying(playing);
    }

    /** @param {string|null} color - CSS hex color, or null for the defaults */
    setColor(color) {
        this._accent = color && parseHex(color) ? color : null;
        this.queue_repaint();
    }

    // ---- Animation state -----------------------------------------------------

    _tick(dt) {
        if (this._style === 'spectrum')
            this._tickSpectrum(dt);
        else if (this._style === 'scope')
            this._tickScope(dt);
    }

    _ensureBars(n) {
        if (this._levels.length !== n) {
            this._levels = new Array(n).fill(0);
            this._targets = new Array(n).fill(0);
            this._peaks = new Array(n).fill(0);
        }
    }

    _tickSpectrum(dt) {
        const n = this._levels.length;
        if (n === 0)
            return;
        const playing = this._animator.playing;

        this._sinceRetarget += dt;
        if (this._sinceRetarget >= RETARGET_MS) {
            this._sinceRetarget = 0;
            for (let i = 0; i < n; i++) {
                // Lower bands (left) tend to be louder, like real music.
                const base = 0.9 - 0.5 * (i / Math.max(n - 1, 1));
                this._targets[i] = playing ? base * (0.3 + 0.7 * Math.random()) : 0;
            }
        }

        const k = Math.min(1, dt / BAR_RISE_MS);
        for (let i = 0; i < n; i++) {
            this._levels[i] += (this._targets[i] - this._levels[i]) * k;
            const shown = this._levels[i] * this._animator.amplitude;
            this._peaks[i] = Math.max(this._peaks[i] - dt * PEAK_FALL_PER_MS, shown, 0);
        }
    }

    _tickScope(dt) {
        const speeds = [0.0062, 0.0105, 0.0177];
        this._scopePhases = this._scopePhases.map((p, i) => (p + dt * speeds[i]) % (Math.PI * 2));
        // A slow random walk so the trace breathes like music does.
        this._loudness += (Math.random() - 0.5) * dt * 0.004;
        this._loudness = Math.min(1, Math.max(0.35, this._loudness));
    }

    // ---- Drawing -------------------------------------------------------------

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();

        if (this._style === 'spectrum')
            this._drawSpectrum(cr, node, width, height);
        else if (this._style === 'scope')
            this._drawScope(cr, node, width, height);
        else
            this._drawWave(cr, node, width, height);
        cr.$dispose();
    }

    _drawWave(cr, node, width, height) {
        const thickness = node.get_length('-encore-wave-thickness') || 2;
        const wavelength = node.get_length('-encore-wave-wavelength') || 10;
        const maxAmplitude = Math.min(node.get_length('-encore-wave-amplitude') || 3,
            (height - thickness) / 2);

        cr.setSourceColor(parseColor(this._accent) ?? node.get_foreground_color());
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        const pad = thickness / 2;
        traceWave(cr, pad, width - pad, height / 2,
            maxAmplitude * this._animator.amplitude, wavelength, this._animator.phase, true);
        cr.stroke();
    }

    /** Three colors (quiet → loud) for the Winamp styles. */
    _palette() {
        if (!this._accent)
            return CLASSIC;
        const [h, s, l] = rgbToHsl(...parseHex(this._accent));
        return [
            hslToRgb(h, s, Math.max(0.25, l - 0.25)),
            hslToRgb(h, s, l),
            hslToRgb(h, Math.max(0.2, s - 0.3), Math.min(0.92, l + 0.25)),
        ].map(c => c.map(v => v / 255));
    }

    _gradient(x0, y0, x1, y1, stops) {
        const g = new Cairo.LinearGradient(x0, y0, x1, y1);
        for (const [offset, [r, gr, b]] of stops)
            g.addColorStopRGBA(offset, r, gr, b, 1);
        return g;
    }

    _drawSpectrum(cr, node, width, height) {
        const barWidth = node.get_length('-encore-bar-width') || 2;
        const gap = node.get_length('-encore-bar-gap') || 1;
        const n = Math.max(1, Math.floor((width + gap) / (barWidth + gap)));
        this._ensureBars(n);

        const [low, mid, high] = this._palette();
        cr.setSource(this._gradient(0, height, 0, 0, [[0, low], [0.6, mid], [1, high]]));
        const offset = (width - (n * (barWidth + gap) - gap)) / 2;
        for (let i = 0; i < n; i++) {
            const h = Math.max(1, Math.round(this._levels[i] * this._animator.amplitude * height));
            cr.rectangle(offset + i * (barWidth + gap), height - h, barWidth, h);
        }
        cr.fill();

        // Peak caps, one pixel high, that fall slowly.
        const peakColor = this._accent ? high : CLASSIC_PEAK;
        cr.setSourceRGBA(...peakColor, 1);
        for (let i = 0; i < n; i++) {
            if (this._peaks[i] <= 0.01)
                continue;
            const y = Math.min(height - 1, Math.round(height - this._peaks[i] * height) - 1);
            cr.rectangle(offset + i * (barWidth + gap), Math.max(0, y), barWidth, 1);
        }
        cr.fill();
    }

    _drawScope(cr, node, width, height) {
        const thickness = node.get_length('-encore-wave-thickness') || 1.5;
        const cy = height / 2;
        const maxAmp = (height - thickness) / 2;
        const amp = maxAmp * this._animator.amplitude * this._loudness;
        const [p1, p2, p3] = this._scopePhases;

        // Green near the center line, red at the extremes, like Winamp.
        const [low, mid, high] = this._palette();
        cr.setSource(this._gradient(0, 0, 0, height,
            [[0, high], [0.3, mid], [0.5, low], [0.7, mid], [1, high]]));
        cr.setLineWidth(thickness);
        cr.setLineJoin(Cairo.LineJoin.BEVEL);

        for (let x = 0; x <= width; x++) {
            const t = x / width;
            const v = 0.55 * Math.sin(t * 9.0 + p1) +
                0.30 * Math.sin(t * 23.0 - p2) +
                0.15 * Math.sin(t * 47.0 + p3);
            const y = cy + amp * v;
            if (x === 0)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.stroke();
    }
});
