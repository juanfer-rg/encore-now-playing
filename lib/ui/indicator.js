import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cssUrl, joinNonEmpty} from '../util.js';
import {MediaCard} from './mediaCard.js';
import {ScrollingLabel} from './scrollingLabel.js';
import {PanelVisualizer} from './visualizer.js';
import {accentForPlayer} from '../art/accent.js';

const VOLUME_STEP = 0.05;

/**
 * The top bar button: icon (album art or app icon), scrolling track text and
 * optional transport buttons. Opens the media card.
 *
 * Primary click toggles the card, middle click toggles play/pause, and the
 * scroll wheel changes volume or track (configurable).
 */
export const EncoreIndicator = GObject.registerClass(
class EncoreIndicator extends PanelMenu.Button {
    constructor({manager, settings, artCache, lyrics}) {
        super(0.5, _('Now Playing'));

        this._manager = manager;
        this._settings = settings;
        this._artCache = artCache;
        this._artUrl = null;
        this._artSerial = 0;

        this.add_style_class_name('encore-indicator');

        // PanelMenu.Button opens its menu from a ClickGesture that would also
        // swallow clicks meant for the inline buttons; we toggle the menu
        // from vfunc_event instead, where we can tell where the press landed.
        for (const action of this.get_actions()) {
            if (action instanceof Clutter.ClickGesture)
                action.set_enabled(false);
        }

        this._box = new St.BoxLayout({style_class: 'encore-panel-box'});
        this.add_child(this._box);

        this._artIcon = new St.Bin({style_class: 'encore-panel-art', y_align: Clutter.ActorAlign.CENTER});
        this._appIcon = new St.Icon({style_class: 'system-status-icon encore-panel-icon'});
        this._wave = new PanelVisualizer();
        this._waveColorKey = null;
        this._waveColorSerial = 0;
        this._label = new ScrollingLabel({styleClass: 'encore-panel-label'});

        this._controls = new St.BoxLayout({style_class: 'encore-panel-controls'});
        this._prevButton = this._panelButton('media-skip-backward-symbolic', _('Previous'), p => p.previous());
        this._playButton = this._panelButton('media-playback-start-symbolic', _('Play'), p => p.playPause());
        this._nextButton = this._panelButton('media-skip-forward-symbolic', _('Next'), p => p.next());

        this._box.add_child(this._artIcon);
        this._box.add_child(this._appIcon);
        this._box.add_child(this._wave);
        this._box.add_child(this._label);
        this._box.add_child(this._controls);

        // The card
        this._card = new MediaCard({
            manager, settings, artCache, lyrics,
        });
        this._card.connect('close-requested', () => this.menu.close());
        // Added straight to the menu box: a non-reactive PopupBaseMenuItem
        // would be styled :insensitive, which greys out all the text.
        this.menu.box.add_child(this._card);
        this.menu.actor.add_style_class_name('encore-menu');

        // The popup follows the Shell's light or dark style by itself; the
        // few colors we pin (lyrics backdrop, dots) switch through a class,
        // because an extension only gets one stylesheet and St does not rank
        // @imported rules above the Shell theme.
        St.Settings.get().connectObject('notify::color-scheme', () => this._syncStyleVariant(), this);
        this._syncStyleVariant();
        this.menu.connectObject('open-state-changed', (_m, open) => this._card.setRunning(open), this);

        manager.connectObject(
            'active-changed', () => this._sync(),
            'active-updated', () => this._sync(),
            'players-changed', () => this._sync(),
            'playback-changed', () => this._syncWave(),
            this);
        settings.connectObject('changed', () => this._onSettingsChanged(), this);
        // Not named _onDestroy: PanelMenu.Button already has one (it destroys
        // the menu and the panel container) and overriding it would leak both.
        this.connect('destroy', () => this._onIndicatorDestroy());

        this._onSettingsChanged();
    }

    _syncStyleVariant() {
        if (Main.getStyleVariant() === 'light')
            this.menu.box.add_style_class_name('encore-light');
        else
            this.menu.box.remove_style_class_name('encore-light');
    }

    _panelButton(iconName, accessibleName, action) {
        const button = new St.Button({
            style_class: 'encore-panel-button',
            child: new St.Icon({icon_name: iconName, style_class: 'system-status-icon'}),
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => {
            const player = this._manager.active;
            if (player)
                action(player);
        });
        this._controls.add_child(button);
        return button;
    }

    // ---- Events ------------------------------------------------------------

    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            const button = type === Clutter.EventType.BUTTON_PRESS ? event.get_button() : 1;
            if (button === Clutter.BUTTON_MIDDLE) {
                this._manager.active?.playPause();
                return Clutter.EVENT_STOP;
            }
            if (!this._isOnControls(event))
                this.menu.toggle();
        } else if (type === Clutter.EventType.SCROLL) {
            return this._onScroll(event);
        } else if (type === Clutter.EventType.KEY_PRESS) {
            // The disabled ClickGesture also handled keyboard activation.
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
                symbol === Clutter.KEY_space) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _isOnControls(event) {
        if (!this._controls.visible)
            return false;
        const [x, y] = event.get_coords();
        const [cx, cy] = this._controls.get_transformed_position();
        const [w, h] = this._controls.get_transformed_size();
        return x >= cx && x < cx + w && y >= cy && y < cy + h;
    }

    _onScroll(event) {
        const player = this._manager.active;
        const action = this._settings.get_string('panel-scroll-action');
        if (!player || action === 'none')
            return Clutter.EVENT_PROPAGATE;

        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            // Ignore tiny touchpad movements.
            if (Math.abs(dy) >= 0.5)
                delta = dy < 0 ? 1 : -1;
            break;
        }
        }
        if (delta === 0)
            return Clutter.EVENT_STOP;

        if (action === 'volume') {
            const volume = player.volume;
            if (volume !== null)
                player.setVolume(volume + delta * VOLUME_STEP);
        } else if (action === 'track') {
            if (delta > 0)
                player.previous();
            else
                player.next();
        }
        return Clutter.EVENT_STOP;
    }

    // ---- State -------------------------------------------------------------

    _onSettingsChanged() {
        const s = this._settings;
        this._iconMode = s.get_string('panel-icon');
        this._textMode = s.get_string('panel-text');
        this._showWave = s.get_boolean('show-panel-wave');
        this._wave.setStyle(s.get_string('panel-visualizer'));
        this._dynamicColors = s.get_boolean('dynamic-colors');
        this._waveColorKey = null; // re-evaluate the color
        this._hideWhenInactive = s.get_boolean('hide-when-inactive');
        this._controls.visible = s.get_boolean('show-panel-controls');
        this._label.configure({
            maxWidth: s.get_int('max-text-width'),
            scroll: s.get_boolean('scroll-text'),
            speed: s.get_int('scroll-speed'),
        });
        this._artUrl = null; // re-evaluate the icon
        this._sync();
    }

    _sync() {
        const player = this._manager.active;
        this.visible = !!player || !this._hideWhenInactive;
        this.container.visible = this.visible;
        if (!this.visible)
            this.menu.close();

        // Text
        let text = '';
        if (player) {
            const title = player.title || player.identity;
            const artist = player.artist;
            switch (this._textMode) {
            case 'title':
                text = title;
                break;
            case 'title-artist':
                text = joinNonEmpty([title, artist]);
                break;
            case 'artist-title':
                text = joinNonEmpty([artist, title], ' – ');
                break;
            }
        } else if (this._textMode !== 'none') {
            text = _('Nothing playing');
        }
        this._label.text = text;
        this._label.visible = text !== '';
        // Screen readers always get the track, even when no text is shown.
        this.accessible_name = player
            ? joinNonEmpty([player.title || player.identity, player.artist])
            : _('Now Playing');

        // Inline controls
        const playing = player?.isPlaying ?? false;
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? _('Pause') : _('Play');
        this._prevButton.reactive = !!player?.canGoPrevious;
        this._nextButton.reactive = !!player?.canGoNext;
        this._playButton.reactive = !!player;

        this._syncIcon(player);

        // The wave flows while playing. It is also the fallback so the
        // indicator never ends up empty.
        this._wave.visible = this._showWave;
        this._syncWave();
    }

    /**
     * The visualizer moves while any player is playing, not only the one
     * shown in the card. With album art colors on it takes the color of the
     * artwork that is playing (the active player's if it plays, otherwise
     * another playing one); otherwise it keeps its default colors.
     */
    _syncWave() {
        const playing = this._manager.playing;
        this._wave.setPlaying(playing.length > 0);

        const source = playing[0] ?? this._manager.active;
        if (!this._dynamicColors || !source) {
            this._waveColorKey = null;
            this._waveColorSerial++;
            this._wave.setColor(null);
            return;
        }
        const key = `${source.busName}|${source.trackKey}|${source.metadata.artUrl}`;
        if (key === this._waveColorKey)
            return;
        this._waveColorKey = key;
        const serial = ++this._waveColorSerial;
        accentForPlayer(this._artCache, source).then(color => {
            if (serial === this._waveColorSerial)
                this._wave.setColor(color);
        }).catch(e => console.debug(`[Encore] wave color: ${e.message}`));
    }

    _syncIcon(player) {
        // With the wave off and nothing else to show, fall back to the
        // player icon so the indicator never ends up empty.
        const empty = !this._showWave && !this._label.visible && !this._controls.visible;
        const mode = this._iconMode === 'none' && empty ? 'app-icon' : this._iconMode;
        if (mode !== this._effectiveIconMode) {
            this._effectiveIconMode = mode;
            this._artUrl = null;
        }
        const showApp = () => {
            this._artIcon.visible = false;
            this._appIcon.visible = true;
            this._appIcon.gicon = player?.gicon ?? null;
            if (!this._appIcon.gicon)
                this._appIcon.icon_name = 'audio-x-generic-symbolic';
        };

        if (mode === 'none') {
            this._artIcon.visible = false;
            this._appIcon.visible = false;
            this._label.add_style_class_name('no-icon');
            return;
        }
        this._label.remove_style_class_name('no-icon');

        if (mode === 'app-icon' || !player) {
            showApp();
            return;
        }

        // Album art, falling back to the app icon.
        const url = player.metadata.artUrl;
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const serial = ++this._artSerial;
        showApp();
        if (!url)
            return;
        this._artCache.resolve(url).then(file => {
            if (serial !== this._artSerial || !file)
                return;
            this._artIcon.style = `background-image: ${cssUrl(file.get_uri())};`;
            this._artIcon.visible = true;
            this._appIcon.visible = false;
        });
    }

    destroy() {
        // Close without animation first: a closing animation would otherwise
        // run against an already destroyed button.
        this.menu?.close(BoxPointer.PopupAnimation.NONE);
        super.destroy();
    }

    _onIndicatorDestroy() {
        St.Settings.get().disconnectObject(this);
        this._artSerial++;
        this._manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this.menu?.disconnectObject(this);
    }
});
