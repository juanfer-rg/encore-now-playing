import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {parseHex} from '../art/palette.js';
import {WaveAnimator, drawRibbon} from './wave.js';

// The visualizers are animations, not an analysis of the audio: GNOME Shell
// has no access to the sound itself without spawning a capture process.
// They move while something plays and settle when playback stops.

const TAU = Math.PI * 2;

/**
 * The top bar visualizer, always shown, in one of three styles:
 *
 *  - wave: Encore's ribbon, two strands twisting around each other
 *  - bars: rounded bars, mirrored around the middle, that rise and fall
 *    smoothly (taller in the center)
 *  - signal: a main line with two fainter echoes that drift and breathe
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
        this._time = 0; // ms of animation, drives bars and signal

        this._animator = new WaveAnimator(this, {onTick: dt => (this._time += dt)});
        this.connect('destroy', () => {
            this._animator.destroy();
            this._animator = null;
        });
    }

    /** @param {'wave'|'bars'|'signal'} style */
    setStyle(style) {
        if (!['wave', 'bars', 'signal'].includes(style))
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
        else if (this._style === 'signal')
            this._drawSignal(cr, node, width, height);
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
            amplitude: maxAmplitude * this._animator.amplitude,
            wavelength,
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

        cr.setSource(this._source(node, width));
        cr.setLineWidth(barWidth);
        for (let i = 0; i < n; i++) {
            const u = n > 1 ? i / (n - 1) : 0.5;
            // Taller in the middle, lower at the edges.
            const envelope = 0.45 + 0.55 * Math.sin(Math.PI * u);
            // Two slow sines per bar with their own speeds: smooth and organic.
            const motion = 0.5 +
                0.3 * Math.sin(t * (3.1 + i * 0.37) + i * 1.7) +
                0.2 * Math.sin(t * (5.3 + i * 0.23) + i * 0.9);
            const half = maxHalf * envelope * Math.max(0, motion) * amp;
            const x = offset + i * (barWidth + gap);
            // A round cap on a zero-length line draws a dot when idle.
            cr.moveTo(x, cy - half);
            cr.lineTo(x, cy + half);
        }
        cr.stroke();
    }

    _drawSignal(cr, node, width, height) {
        const thickness = node.get_length('-encore-wave-thickness') || 2;
        const cy = height / 2;
        const t = this._time / 1000;
        const amp = this._animator.amplitude;
        // Breathes slowly, like the loudness of music.
        const breath = 0.7 + 0.3 * Math.sin(t * 1.3);
        const maxAmp = (height - thickness) / 2 * amp * breath;

        const layers = [
            {alpha: 0.35, width: thickness * 0.6, speed: 1.7, shift: 2.1, scale: 0.75},
            {alpha: 0.55, width: thickness * 0.75, speed: 2.6, shift: 4.2, scale: 0.9},
            {alpha: 1.0, width: thickness, speed: 3.4, shift: 0, scale: 1},
        ];
        const pad = thickness / 2;
        for (const layer of layers) {
            cr.setSource(this._source(node, width, layer.alpha));
            cr.setLineWidth(layer.width);
            for (let x = pad; x <= width - pad + 0.01; x += 0.5) {
                const u = (x - pad) / (width - 2 * pad);
                const envelope = Math.sin(Math.PI * u); // flat at both ends
                const v = 0.6 * Math.sin(TAU * u * 1.5 + t * layer.speed + layer.shift) +
                    0.4 * Math.sin(TAU * u * 3.2 - t * layer.speed * 1.4 + layer.shift);
                const y = cy + maxAmp * layer.scale * envelope * v;
                if (x === pad)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.stroke();
        }
    }
});
