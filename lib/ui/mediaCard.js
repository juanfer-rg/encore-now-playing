import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cardColors, paletteFromString} from '../art/palette.js';
import {cssUrl, joinNonEmpty} from '../util.js';
import {focusPlayer} from '../windowFocus.js';
import {LyricsView} from './lyricsView.js';
import {PlayerSidebar} from './playerSidebar.js';
import {ProgressBar} from './progressBar.js';
import {ScrollingLabel} from './scrollingLabel.js';
import {WaveLine} from './wave.js';

const VOLUME_SEND_INTERVAL_MS = 100;
const SIDE_GAP = 16; // keep in sync with .encore-card-top spacing

function iconButton(iconName, styleClass, accessibleName) {
    return new St.Button({
        style_class: `encore-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName, style_class: 'encore-button-icon'}),
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function ellipsizedLabel(styleClass) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

/**
 * The compact player card shown in the popup: artwork on the left; title,
 * artist, transport controls, seek bar and volume on the right. Lyrics
 * unfold below it, and the other running players are listed at the bottom.
 *
 * Signals:
 *  - close-requested: the card wants the menu closed (e.g. after focusing
 *    the player window)
 *  - accent-changed: the accent color changed (see the `accent` getter)
 */
export const MediaCard = GObject.registerClass({
    Signals: {
        'close-requested': {},
        'accent-changed': {},
    },
}, class EncoreMediaCard extends St.BoxLayout {
    /**
     * @param {object} params
     * @param {St.Widget} [params.backgroundActor] - actor that receives the
     *   tint (the popup's content box), defaults to the card itself
     */
    constructor({manager, settings, artCache, lyrics, backgroundActor = null}) {
        super({
            style_class: 'encore-card',
            x_expand: true,
        });

        this._manager = manager;
        this._settings = settings;
        this._artCache = artCache;
        this._lyrics = lyrics;
        this._backgroundActor = backgroundActor ?? this;

        this._player = null;
        this._artUrl = null;
        this._artSerial = 0;
        this._colors = null;
        this._lyricsTrack = null;
        this._lyricsSerial = 0;
        this._showLyrics = false;
        this._running = false;
        this._volumeUpdating = false;
        this._volumePending = null;
        this._volumeTimerId = 0;

        this._build();

        manager.connectObject(
            'players-changed', () => this._onPlayersChanged(),
            'active-changed', () => this._onActiveChanged(),
            'active-updated', () => this._update(),
            'active-seeked', (_m, position) => this._progress.onSeeked(position),
            this);
        settings.connectObject('changed', () => this._onSettingsChanged(), this);
        this.connect('destroy', () => this._onDestroy());

        this._onSettingsChanged();
        this._onPlayersChanged();
        this._onActiveChanged();
    }

    // ---- Construction ------------------------------------------------------

    _build() {
        // Player icons on the left (only with several players), and the
        // card content next to them.
        this._sidebar = new PlayerSidebar(this._manager);
        this.add_child(this._sidebar);
        this._content = new St.BoxLayout({
            style_class: 'encore-card-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(this._content);

        const top = new St.BoxLayout({style_class: 'encore-card-top', x_expand: true});
        this._content.add_child(top);

        // Artwork with the player's icon as a badge.
        this._media = new St.Widget({
            style_class: 'encore-media',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.START,
        });
        this._art = new St.Bin({
            style_class: 'encore-art',
            x_expand: true,
            y_expand: true,
            child: new St.Icon({
                icon_name: 'audio-x-generic-symbolic',
                style_class: 'encore-art-placeholder',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        this._artButton = new St.Button({
            style_class: 'encore-art-button',
            child: this._art,
            x_expand: true,
            y_expand: true,
            can_focus: true,
            accessible_name: _('Show player window'),
        });
        this._artButton.connect('clicked', () => this._onArtClicked());
        this._media.add_child(this._artButton);
        this._badge = new St.Icon({
            style_class: 'encore-art-badge',
            icon_size: 16,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        this._media.add_child(this._badge);
        top.add_child(this._media);

        const side = new St.BoxLayout({
            style_class: 'encore-card-side',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(side);

        // Title + a small wave that flows while playing.
        const header = new St.BoxLayout({style_class: 'encore-card-header', x_expand: true});
        this._title = ellipsizedLabel('encore-title');
        this._wave = new WaveLine();
        this._wave.add_style_class_name('encore-card-wave');
        header.add_child(this._title);
        header.add_child(this._wave);
        side.add_child(header);

        this._subtitle = new ScrollingLabel({styleClass: 'encore-subtitle'});
        side.add_child(this._subtitle);

        // Transport controls, evenly spread.
        const controls = new St.BoxLayout({style_class: 'encore-controls', x_expand: true});
        controls.layout_manager.homogeneous = true;
        this._shuffleButton = iconButton('media-playlist-shuffle-symbolic', 'encore-toggle', _('Shuffle'));
        this._shuffleButton.connect('clicked', () => this._player?.toggleShuffle());
        this._prevButton = iconButton('media-skip-backward-symbolic', '', _('Previous'));
        this._prevButton.connect('clicked', () => this._player?.previous());
        this._playButton = iconButton('media-playback-start-symbolic', 'encore-play', _('Play'));
        this._playButton.connect('clicked', () => this._player?.playPause());
        this._nextButton = iconButton('media-skip-forward-symbolic', '', _('Next'));
        this._nextButton.connect('clicked', () => this._player?.next());
        this._repeatButton = iconButton('media-playlist-repeat-symbolic', 'encore-toggle', _('Repeat'));
        this._repeatButton.connect('clicked', () => this._player?.cycleLoop());
        for (const b of [this._shuffleButton, this._prevButton, this._playButton,
            this._nextButton, this._repeatButton]) {
            b.x_expand = true;
            b.x_align = Clutter.ActorAlign.CENTER;
            controls.add_child(b);
        }
        side.add_child(controls);

        this._progress = new ProgressBar();
        this._progress.connect('position', (_p, us) => {
            if (this._showLyrics)
                this._lyricsView.setPosition(us);
        });
        side.add_child(this._progress);

        // Volume + lyrics toggle
        const bottom = new St.BoxLayout({style_class: 'encore-bottom', x_expand: true});
        this._volumeBox = new St.BoxLayout({style_class: 'encore-volume', x_expand: true});
        this._volumeIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            style_class: 'encore-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volumeSlider = new Slider(0);
        this._volumeSlider.accessible_name = _('Volume');
        this._volumeSlider.connect('notify::value', () => this._onVolumeSlider());
        this._volumeBox.add_child(this._volumeIcon);
        this._volumeBox.add_child(this._volumeSlider);
        bottom.add_child(this._volumeBox);

        this._lyricsButton = iconButton('format-justify-left-symbolic', 'encore-toggle encore-small', _('Lyrics'));
        this._lyricsButton.connect('clicked', () => this._setShowLyrics(!this._showLyrics));
        bottom.add_child(this._lyricsButton);
        side.add_child(bottom);

        // Lyrics unfold below the card.
        this._lyricsView = new LyricsView();
        this._lyricsView.visible = false;
        this._lyricsView.connect('seek-requested', (_v, ms) => {
            this._player?.seekTo(ms * 1000, this._progress.position);
        });
        this._content.add_child(this._lyricsView);

    }

    // ---- Lifecycle ---------------------------------------------------------

    /** The popup was opened or closed. */
    setRunning(running) {
        this._running = running;
        this._progress.setRunning(running);
        if (running)
            this._update();
    }

    _onDestroy() {
        if (this._volumeTimerId) {
            GLib.source_remove(this._volumeTimerId);
            this._volumeTimerId = 0;
        }
        this._manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        // The tinted popup box is destroyed together with the card; touching
        // its style here would relayout a half-destroyed menu.
        this._backgroundActor = null;
        this._artSerial++;
        this._lyricsSerial++;
        this._player = null;
    }

    // ---- Reacting to changes -----------------------------------------------

    _onSettingsChanged() {
        const s = this._settings;
        this._cardWidth = s.get_int('card-width');
        this._dynamicColors = s.get_boolean('dynamic-colors');
        this._manualAccent = s.get_string('accent-color');
        this._showVolume = s.get_boolean('show-volume');
        this._showShuffleRepeat = s.get_boolean('show-shuffle-repeat');
        this._showSwitcher = s.get_boolean('show-player-switcher');
        this._showLyricsButton = s.get_boolean('show-lyrics-button');

        // Artwork on the left, about a third of the card; the rest is the
        // column with the controls.
        this._artSize = Math.round(Math.min(Math.max(this._cardWidth * 0.36, 112), 200));
        this._media.set_size(this._artSize, this._artSize);
        this._subtitle.configure({maxWidth: this._cardWidth - this._artSize - SIDE_GAP});
        this._lyricsTrack = null; // online lookup may have been toggled
        if (!this._showLyricsButton)
            this._setShowLyrics(false);

        this._applyColors();
        this._onPlayersChanged();
        this._update();
    }

    _onPlayersChanged() {
        const count = this._sidebar.rebuild();
        this._sidebar.visible = this._showSwitcher && count > 1;
    }

    _onActiveChanged() {
        this._player = this._manager.active;
        this._sidebar.syncActive();
        this._progress.setPlayer(this._player);
        this._artUrl = null;
        this._lyricsTrack = null;
        this._update();
    }

    _update() {
        const player = this._player;
        if (!player) {
            this._title.text = _('Nothing playing');
            this._subtitle.text = '';
            this._badge.visible = false;
            this._wave.setPlaying(false);
            this._setArt('');
            return;
        }

        const m = player.metadata;
        this._title.text = m.title || player.identity;
        this._subtitle.text = joinNonEmpty([player.artist, m.album], ' - ');
        this._badge.gicon = player.gicon;
        this._badge.visible = !!player.gicon;
        this._wave.setPlaying(player.isPlaying);

        const playing = player.isPlaying;
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? _('Pause') : _('Play');
        this._playButton.reactive = playing ? player.canPause : player.canPlay;
        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        const shuffle = player.shuffle;
        this._shuffleButton.visible = this._showShuffleRepeat && shuffle !== null;
        this._setChecked(this._shuffleButton, shuffle === true);

        const loop = player.loopStatus;
        this._repeatButton.visible = this._showShuffleRepeat && loop !== null;
        this._repeatButton.child.icon_name = loop === 'Track'
            ? 'media-playlist-repeat-song-symbolic'
            : 'media-playlist-repeat-symbolic';
        this._setChecked(this._repeatButton, loop === 'Track' || loop === 'Playlist');
        this._syncToggleColors();

        this._updateVolume();
        this._lyricsButton.visible = this._showLyricsButton;
        this._artButton.reactive = this._settings.get_boolean('click-art-focuses-window');

        this._progress.update();
        this._setArt(m.artUrl);
        if (this._showLyrics)
            this._loadLyrics();
    }

    _setChecked(button, checked) {
        if (checked)
            button.add_style_pseudo_class('checked');
        else
            button.remove_style_pseudo_class('checked');
    }

    // ---- Artwork & colors --------------------------------------------------

    async _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        const serial = ++this._artSerial;

        const file = url ? await this._artCache.resolve(url) : null;
        if (serial !== this._artSerial)
            return;

        if (file) {
            this._art.style = `background-image: ${cssUrl(file.get_uri())};`;
            this._art.add_style_class_name('has-art');
            this._art.child.visible = false;
        } else {
            this._art.style = null;
            this._art.remove_style_class_name('has-art');
            this._art.child.visible = true;
        }

        let palette = null;
        if (this._dynamicColors) {
            palette = file ? await this._artCache.palette(file) : null;
            if (serial !== this._artSerial)
                return;
            if (!palette && this._player) {
                const seed = joinNonEmpty([this._player.artist, this._player.metadata.album, this._player.title], '|');
                palette = seed ? paletteFromString(seed) : null;
            }
        }
        this._colors = palette ? cardColors(palette) : null;
        this._applyColors();
    }

    _applyColors() {
        if (!this._media)
            return;
        const colors = this._dynamicColors ? this._colors : null;
        const accent = colors?.accent ?? this._manualAccent;

        // The width is the content's; the sidebar adds to it.
        this._content.style = `width: ${this._cardWidth}px;`;
        this.style = null;
        const background = colors
            ? `background-color: ${colors.background}; border-color: rgba(255, 255, 255, 0.08);`
            : null;
        if (this._backgroundActor === this)
            this.style = background;
        else
            this._backgroundActor.style = background;

        if (colors)
            this.add_style_class_name('tinted');
        else
            this.remove_style_class_name('tinted');

        this._wave.setColor(accent);
        this._sidebar.setAccent(accent);
        this._progress.setAccent(accent);
        this._volumeSlider.style = accent
            ? `-barlevel-active-background-color: ${accent}; -slider-handle-border-color: ${accent};`
            : null;
        const changed = accent !== this._accent;
        this._accent = accent;
        this._syncToggleColors();
        if (changed)
            this.emit('accent-changed');
    }

    /** Current accent color (CSS hex), from the artwork or the settings. */
    get accent() {
        return this._accent ?? null;
    }

    // St has no CSS variables; color the checked toggles explicitly.
    _syncToggleColors() {
        for (const b of [this._shuffleButton, this._repeatButton, this._lyricsButton]) {
            const checked = b.has_style_pseudo_class('checked');
            b.style = checked && this._accent ? `color: ${this._accent};` : null;
        }
    }

    _onArtClicked() {
        if (this._player && focusPlayer(this._player))
            this.emit('close-requested');
    }

    // ---- Volume ------------------------------------------------------------

    _updateVolume() {
        const volume = this._player?.volume ?? null;
        this._volumeBox.visible = this._showVolume && volume !== null && this._player.canControl;
        if (volume === null || this._volumePending !== null || this._volumeTimerId)
            return;
        this._volumeUpdating = true;
        this._volumeSlider.value = Math.min(volume, 1);
        this._volumeUpdating = false;
        this._syncVolumeIcon(volume);
    }

    _syncVolumeIcon(volume) {
        let name = 'audio-volume-high-symbolic';
        if (volume <= 0)
            name = 'audio-volume-muted-symbolic';
        else if (volume < 0.34)
            name = 'audio-volume-low-symbolic';
        else if (volume < 0.67)
            name = 'audio-volume-medium-symbolic';
        this._volumeIcon.icon_name = name;
    }

    _onVolumeSlider() {
        if (this._volumeUpdating || !this._player)
            return;
        const value = this._volumeSlider.value;
        this._syncVolumeIcon(value);

        // Send at most every VOLUME_SEND_INTERVAL_MS while dragging.
        if (this._volumeTimerId) {
            this._volumePending = value;
            return;
        }
        this._player.setVolume(value);
        this._volumeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOLUME_SEND_INTERVAL_MS, () => {
            if (this._volumePending !== null) {
                this._player?.setVolume(this._volumePending);
                this._volumePending = null;
                return GLib.SOURCE_CONTINUE;
            }
            this._volumeTimerId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Lyrics ------------------------------------------------------------

    _setShowLyrics(show) {
        this._showLyrics = show;
        this._lyricsView.visible = show;
        this._setChecked(this._lyricsButton, show);
        this._syncToggleColors();
        if (show)
            this._loadLyrics();
    }

    async _loadLyrics() {
        const player = this._player;
        if (!player) {
            this._lyricsView.showMessage(_('Nothing playing'));
            return;
        }
        const track = player.trackKey;
        if (track === this._lyricsTrack)
            return;
        this._lyricsTrack = track;
        const serial = ++this._lyricsSerial;

        this._lyricsView.showMessage(_('Looking for lyrics…'));
        const lyrics = await this._lyrics.lookup(player.metadata);
        if (serial !== this._lyricsSerial)
            return;

        if (lyrics) {
            this._lyricsView.setLyrics(lyrics, _('Instrumental'));
            this._lyricsView.setPosition(this._progress.position);
        } else if (!this._lyrics.onlineEnabled) {
            this._lyricsView.showMessage(
                _('This player does not provide lyrics. You can enable online lookup (lrclib.net) in the preferences.'));
        } else {
            this._lyricsView.showMessage(_('No lyrics found'));
        }
    }
});
