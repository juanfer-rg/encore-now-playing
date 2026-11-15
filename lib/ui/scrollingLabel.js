import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const PAUSE_MS = 1800;
const MIN_DURATION_MS = 400;

// A label at most `maxWidth` wide. Text that does not fit scrolls back and
// forth, or is ellipsized when scrolling or animations are off.
export const ScrollingLabel = GObject.registerClass(
class EncoreScrollingLabel extends St.Widget {
    constructor({styleClass = '', maxWidth = 200, scroll = true, speed = 30} = {}) {
        super({
            style_class: `encore-scrolling-label ${styleClass}`,
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._maxWidth = maxWidth;
        this._scroll = scroll;
        this._speed = Math.max(speed, 1);
        this._overflow = 0;
        this._checkId = 0;

        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._label);

        this.connect('notify::mapped', () => this._queueCheck());
        this.connect('destroy', () => this._onDestroy());
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._queueCheck(), this);
    }

    get text() {
        return this._label.text;
    }

    set text(text) {
        text ??= '';
        if (this._label.text === text)
            return;
        this._label.text = text;
        this._restart();
    }

    configure({maxWidth, scroll, speed}) {
        if (maxWidth !== undefined)
            this._maxWidth = maxWidth;
        if (scroll !== undefined)
            this._scroll = scroll;
        if (speed !== undefined)
            this._speed = Math.max(speed, 1);
        this.queue_relayout();
        this._restart();
    }

    get _canScroll() {
        return this._scroll && St.Settings.get().enable_animations;
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, nat] = this._label.get_preferred_width(forHeight);
        return [Math.min(min, this._maxWidth), Math.min(nat, this._maxWidth)];
    }

    vfunc_get_preferred_height(_forWidth) {
        return this._label.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const [, natWidth] = this._label.get_preferred_width(-1);
        const [, natHeight] = this._label.get_preferred_height(-1);
        const width = this._canScroll ? Math.max(natWidth, content.get_width()) : content.get_width();

        const child = new Clutter.ActorBox();
        child.x1 = content.x1;
        child.y1 = content.y1 + Math.max(0, Math.floor((content.get_height() - natHeight) / 2));
        child.x2 = child.x1 + width;
        child.y2 = child.y1 + natHeight;
        this._label.allocate(child);

        const overflow = Math.max(0, Math.ceil(natWidth - content.get_width()));
        if (overflow !== this._overflow) {
            this._overflow = overflow;
            this._queueCheck();
        }
    }

    _restart() {
        this._stop();
        this._queueCheck();
    }

    // Start or stop scrolling outside of the allocation cycle.
    _queueCheck() {
        if (this._checkId)
            return;
        this._checkId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._checkId = 0;
            if (this.mapped && this._canScroll && this._overflow > 0) {
                if (!this._label.get_transition('translation-x'))
                    this._step(true);
            } else {
                this._stop();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _step(forward) {
        const target = forward ? -this._overflow : 0;
        const duration = Math.max(MIN_DURATION_MS, this._overflow / this._speed * 1000);
        this._label.ease({
            translation_x: target,
            duration,
            delay: PAUSE_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onStopped: finished => {
                if (finished && this.mapped && this._canScroll && this._overflow > 0)
                    this._step(!forward);
            },
        });
    }

    _stop() {
        this._label.remove_transition('translation-x');
        this._label.translation_x = 0;
    }

    _onDestroy() {
        if (this._checkId) {
            GLib.source_remove(this._checkId);
            this._checkId = 0;
        }
        St.Settings.get().disconnectObject(this);
        this._label.remove_all_transitions();
    }
});
