import GLib from 'gi://GLib';

// Indicators sit in an St.Bin container. The Shell hides some indicators by
// hiding the indicator itself and leaving its container visible, so both
// have to be checked.
function isShown(actor) {
    return actor.visible && (actor.get_first_child()?.visible ?? true);
}

// Keeps a panel indicator at the N-th *visible* position of its top bar
// section. addToStatusArea() takes a raw child index, which also counts the
// Shell's hidden indicators (the right section starts with several), and
// indicators added later by other extensions shift ours, so the position is
// re-applied whenever the section's children or their visibility change.
export class PanelPlacement {
    constructor(container, index) {
        this._container = container;
        this._index = index;
        this._siblings = new Set();
        this._idleId = 0;

        this._box = container.get_parent();
        this._box.connectObject(
            'child-added', () => this._queue(),
            'child-removed', () => this._queue(),
            this);
        this._apply();
    }

    setIndex(index) {
        this._index = index;
        this._queue();
    }

    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _apply() {
        const box = this._container.get_parent();
        if (!box)
            return;

        const others = box.get_children().filter(c => c !== this._container);

        // Watch the siblings' visibility: an indicator appearing or hiding
        // changes which slot is the N-th visible one.
        const watched = new Set();
        for (const sibling of others) {
            watched.add(sibling);
            const child = sibling.get_first_child();
            if (child)
                watched.add(child);
        }
        for (const actor of this._siblings) {
            if (!watched.has(actor))
                actor.disconnectObject(this);
        }
        for (const actor of watched) {
            if (!this._siblings.has(actor))
                actor.connectObject('notify::visible', () => this._queue(), this);
        }
        this._siblings = watched;

        // Go right before the (index)-th visible sibling, or to the end.
        let target = others.length;
        let seen = 0;
        for (let i = 0; i < others.length; i++) {
            if (!isShown(others[i]))
                continue;
            if (seen === this._index) {
                target = i;
                break;
            }
            seen++;
        }

        if (box.get_children().indexOf(this._container) !== target)
            box.set_child_at_index(this._container, target);
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const sibling of this._siblings)
            sibling.disconnectObject(this);
        this._siblings.clear();
        this._box.disconnectObject(this);
        this._box = null;
        this._container = null;
    }
}
