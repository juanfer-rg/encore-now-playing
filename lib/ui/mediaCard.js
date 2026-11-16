import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {trackPalette} from '../art/accent.js';
import {cardColors, luminance, waveColors} from '../art/palette.js';
import {cssUrl, joinNonEmpty} from '../util.js';
import {verticalProps} from './compat.js';
import {focusPlayer} from '../windowFocus.js';
import {LyricsView} from './lyricsView.js';
import {PlayerSidebar} from './playerSidebar.js';
import {ProgressBar} from './progressBar.js';
import {ScrollingLabel} from './scrollingLabel.js';

const VOLUME_SEND_INTERVAL_MS = 100;
const LYRICS_UNFOLD_MS = 320;
const LYRICS_FOLD_MS = 220;
const SIDE_GAP = 16; // keep in sync with .encore-card-top spacing
const HEADER_BUTTONS = 64; // room for the lyrics and layout buttons next to the title
const PLAYER_ICON = 20; // the player's icon before the artist line, with its spacing
// Room around the artwork for the glow. It must be clearly larger than the
// blur radius, or the blur reaches the edge of its area and shows a hard
// rectangle.
const AMBIENT_SPREAD = 48;
const AMBIENT_BLUR = 26;
// The artwork has a fixed size in each layout, whatever the player or the
// shape of its image (wide video thumbnails are cropped to a square).
const ART_SIZE_COMPACT = 150;
const ART_SIZE_LARGE = 300;

function iconButton(iconName, styleClass, accessibleName) {
    return new St.Button({
        style_class: `encore-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName, style_class: 'encore-button-icon'}),
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function vbox(styleClass, params = {}) {
    return new St.BoxLayout({
        style_class: styleClass,
        ...verticalProps(),
        x_expand: true,
        ...params,
    });
}

// The player card in the popup, in the `compact` or `large` layout. The
// widgets are created once and moved into the containers of the current
// layout by _arrange().
export const MediaCard = GObject.registerClass({
    Signals: {
        'close-requested': {},
    },
}, class EncoreMediaCard extends St.BoxLayout {
    constructor({manager, settings, artCache, lyrics}) {
        super({style_class: 'encore-card'});

        this._manager = manager;
        this._settings = settings;
        this._artCache = artCache;
        this._lyrics = lyrics;

        this._player = null;
        this._artUrl = null;
        this._artFile = null;
        this._artSerial = 0;
        this._colors = null;
        this._waveColors = null;
        this._artLuminance = 0;
        this._accent = null;
        this._lyricsTrack = null;
        this._lyricsSerial = 0;
        this._showLyrics = false;
        this._volumeUpdating = false;
        this._volumePending = null;
        this._volumeTimerId = 0;
        this._volumeBeforeMute = null;
        this._layout = null;
        this._layoutRoot = null;

        this._buildWidgets();

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

    // ---- Widgets -------------------------------------------------------------

    _buildWidgets() {
        this._sidebar = new PlayerSidebar(this._manager);
        this.add_child(this._sidebar);
        this._content = vbox('encore-card-content');
        this.add_child(this._content);

        this._media = new St.Widget({
            style_class: 'encore-media',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.START,
            x_align: Clutter.ActorAlign.CENTER,
        });
        // The glow is a blurred copy of the artwork, bigger than it, in a
        // fixed-size holder so it can spill outside the artwork without
        // making the layout bigger. The transparent margin around the image
        // lets the blur fade out softly.
        this._ambientHolder = new St.Widget({visible: false});
        this._ambient = new St.Bin({
            style_class: 'encore-ambient',
            child: new St.Bin({style_class: 'encore-ambient-image', x_expand: true, y_expand: true}),
        });
        this._ambientHolder.add_child(this._ambient);
        this._ambient.add_effect(new Shell.BlurEffect({
            radius: AMBIENT_BLUR,
            brightness: 1.0,
            mode: Shell.BlurMode.ACTOR,
        }));
        this._media.add_child(this._ambientHolder);

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

        this._title = new ScrollingLabel({styleClass: 'encore-title'});
        this._title.x_expand = true;
        this._subtitle = new ScrollingLabel({styleClass: 'encore-subtitle'});
        this._badge = new St.Icon({
            style_class: 'encore-player-icon',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._subtitleRow = new St.BoxLayout({style_class: 'encore-subtitle-row', x_expand: true});
        this._subtitleRow.add_child(this._badge);
        this._subtitleRow.add_child(this._subtitle);
        this._layoutButton = iconButton('view-fullscreen-symbolic', 'encore-small', _('Change layout'));
        this._layoutButton.connect('clicked', () => {
            this._settings.set_string('card-layout', this._layout === 'large' ? 'compact' : 'large');
        });

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
        this._lyricsButton = iconButton('format-justify-left-symbolic', 'encore-toggle encore-small', _('Lyrics'));
        this._lyricsButton.connect('clicked', () => this._setShowLyrics(!this._showLyrics));

        this._progress = new ProgressBar();
        this._progress.connect('position', (_p, us) => {
            if (this._showLyrics) {
                this._lyricsView.setLength(this._player?.metadata.length ?? 0);
                this._lyricsView.setPosition(us);
            }
        });

        this._volumeBox = new St.BoxLayout({
            style_class: 'encore-volume',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volumeIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            style_class: 'encore-volume-icon',
        });
        this._muteButton = new St.Button({
            style_class: 'encore-button encore-mute',
            child: this._volumeIcon,
            can_focus: true,
            accessible_name: _('Mute'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._muteButton.connect('clicked', () => this._toggleMute());
        this._volumeSlider = new Slider(0);
        this._volumeSlider.add_style_class_name('encore-volume-slider');
        this._volumeSlider.x_expand = true;
        this._volumeSlider.accessible_name = _('Volume');
        this._volumeSlider.connect('notify::value', () => this._onVolumeSlider());
        this._volumeLabel = new St.Label({style_class: 'encore-volume-label', y_align: Clutter.ActorAlign.CENTER});
        this._volumeBox.add_child(this._muteButton);
        this._volumeBox.add_child(this._volumeSlider);
        this._volumeBox.add_child(this._volumeLabel);

        this._lyricsView = new LyricsView();
        this._lyricsView.visible = false;
        this._lyricsView.connect('seek-requested', (_v, ms) => {
            this._player?.seekTo(ms * 1000, this._progress.position);
        });
    }

    _arrange(layout) {
        if (layout === this._layout)
            return;
        this._layout = layout;

        for (const w of [this._media, this._title, this._subtitleRow, this._layoutButton,
            this._shuffleButton, this._prevButton, this._playButton, this._nextButton,
            this._repeatButton, this._lyricsButton, this._progress, this._volumeBox,
            this._lyricsView])
            w.get_parent()?.remove_child(w);
        this._layoutRoot?.destroy();

        const root = vbox(`encore-layout-${layout}`);
        const header = new St.BoxLayout({style_class: 'encore-card-header', x_expand: true});
        header.add_child(this._title);
        header.add_child(this._lyricsButton);
        header.add_child(this._layoutButton);

        if (layout === 'large') {
            root.add_child(this._media);
            const info = vbox('encore-info');
            info.add_child(header);
            info.add_child(this._subtitleRow);
            root.add_child(info);
            root.add_child(this._progress);

            root.add_child(this._transportRow());
            root.add_child(this._volumeRow());
            this._layoutButton.child.icon_name = 'view-restore-symbolic';
        } else {
            const top = new St.BoxLayout({style_class: 'encore-card-top', x_expand: true});
            top.add_child(this._media);
            const side = vbox('encore-card-side', {y_align: Clutter.ActorAlign.CENTER});
            side.add_child(header);
            side.add_child(this._subtitleRow);

            side.add_child(this._transportRow());
            side.add_child(this._progress);
            side.add_child(this._volumeRow());
            top.add_child(side);
            root.add_child(top);
            this._layoutButton.child.icon_name = 'view-fullscreen-symbolic';
        }

        root.add_child(this._lyricsView);
        this._content.add_child(root);
        this._layoutRoot = root;
        this._lyricsView.setLarge(layout === 'large');
    }

    _transportRow() {
        const row = new St.BoxLayout({style_class: 'encore-controls', x_expand: true});
        row.layout_manager.homogeneous = true;
        for (const b of [this._shuffleButton, this._prevButton, this._playButton,
            this._nextButton, this._repeatButton])
            row.add_child(b);
        return row;
    }

    _volumeRow() {
        const row = new St.BoxLayout({style_class: 'encore-bottom', x_expand: true});
        row.add_child(this._volumeBox);
        return row;
    }

    // ---- Lifecycle ---------------------------------------------------------

    /** The popup was opened or closed. */
    setRunning(running) {
        this._progress.setRunning(running);
        if (running)
            this._update();
    }

    _onDestroy() {
        this._stopVolumeTimer();
        this._manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._artSerial++;
        this._lyricsSerial++;
        this._player = null;
    }

    // ---- Reacting to changes -----------------------------------------------

    _onSettingsChanged() {
        const s = this._settings;
        this._dynamicColors = s.get_boolean('dynamic-colors');
        this._manualAccent = s.get_string('accent-color');
        this._showVolume = s.get_boolean('show-volume');
        this._showShuffleRepeat = s.get_boolean('show-shuffle-repeat');
        this._showLyricsButton = s.get_boolean('show-lyrics-button');

        this._arrange(s.get_string('card-layout') === 'large' ? 'large' : 'compact');

        let width, artSize;
        if (this._layout === 'large') {
            artSize = ART_SIZE_LARGE;
            width = artSize;
            this._subtitle.configure({maxWidth: width - PLAYER_ICON});
            this._title.configure({maxWidth: width - HEADER_BUTTONS});
        } else {
            // card-width only changes the column with the controls.
            artSize = ART_SIZE_COMPACT;
            width = s.get_int('card-width');
            this._subtitle.configure({maxWidth: width - artSize - SIDE_GAP - PLAYER_ICON});
            this._title.configure({maxWidth: width - artSize - SIDE_GAP - HEADER_BUTTONS});
        }
        this._content.style = `width: ${width}px;`;
        this._media.set_size(artSize, artSize);
        this._ambientHolder.set_size(artSize, artSize);
        this._ambient.set_position(-AMBIENT_SPREAD, -AMBIENT_SPREAD);
        this._ambient.set_size(artSize + 2 * AMBIENT_SPREAD, artSize + 2 * AMBIENT_SPREAD);

        this._lyricsTrack = null; // online lookup may have been toggled
        if (!this._showLyricsButton)
            this._setShowLyrics(false);

        this._recomputeColors();
        this._update();
    }

    _onPlayersChanged() {
        this._sidebar.visible = this._sidebar.rebuild() > 1;
    }

    _onActiveChanged() {
        this._player = this._manager.active;
        this._stopVolumeTimer();
        this._volumeBeforeMute = null;
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
            this._setArt('');
            return;
        }

        const m = player.metadata;
        this._title.text = m.title || player.identity;
        const album = m.album && m.year ? `${m.album} [${m.year}]` : m.album;
        this._subtitle.text = joinNonEmpty([player.artist, album], ' - ');
        this._badge.gicon = player.gicon;
        this._badge.visible = !!player.gicon;

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

        this._artFile = file;
        if (file) {
            const style = `background-image: ${cssUrl(file.get_uri())};`;
            this._art.style = style;
            this._ambient.child.style = style;
            this._art.add_style_class_name('has-art');
            this._art.child.visible = false;
        } else {
            this._art.style = null;
            this._ambient.child.style = null;
            this._art.remove_style_class_name('has-art');
            this._art.child.visible = true;
        }

        let palette = null;
        if (file) {
            palette = await this._artCache.palette(file);
            if (serial !== this._artSerial)
                return;
        }
        if (!palette && this._player)
            palette = trackPalette(this._player);
        this._colors = palette ? cardColors(palette) : null;
        this._artLuminance = palette ? luminance(palette.primary) : 0;
        this._waveColors = palette ? waveColors(palette) : null;
        this._recomputeColors();
    }

    // "Colors from album art" never tints the card itself, only the accents
    // and the glow behind the artwork.
    _recomputeColors() {
        const dynamic = this._dynamicColors && this._colors;
        const accent = dynamic ? this._colors.accent : this._manualAccent;

        this._ambientHolder.visible = !!(this._dynamicColors && this._artFile);
        // A discreet glow, and fainter still for light artwork, which would
        // otherwise wash over the popup.
        this._ambient.opacity = Math.round(150 - 80 * Math.min(1, this._artLuminance));
        this._lyricsView.setColors(dynamic && this._waveColors ? this._waveColors : null);
        this._progress.setColors(dynamic && this._waveColors ? this._waveColors : [accent]);
        this._volumeSlider.style = accent
            ? `-barlevel-active-background-color: ${accent}; -slider-handle-border-color: ${accent};`
            : null;
        this._sidebar.setAccent(accent);

        this._accent = accent;
        this._syncToggleColors();
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
        this._syncVolumeLabels(volume);
    }

    _syncVolumeLabels(volume) {
        let name = 'audio-volume-high-symbolic';
        if (volume <= 0)
            name = 'audio-volume-muted-symbolic';
        else if (volume < 0.34)
            name = 'audio-volume-low-symbolic';
        else if (volume < 0.67)
            name = 'audio-volume-medium-symbolic';
        this._volumeIcon.icon_name = name;
        this._volumeLabel.text = String(Math.round(Math.min(volume, 1) * 100));
        this._muteButton.accessible_name = volume <= 0 ? _('Unmute') : _('Mute');
    }

    _toggleMute() {
        if (!this._player)
            return;
        const current = this._volumeSlider.value;
        if (current > 0) {
            this._volumeBeforeMute = current;
            this._volumeSlider.value = 0;
        } else {
            this._volumeSlider.value = this._volumeBeforeMute ?? 0.5;
            this._volumeBeforeMute = null;
        }
        // _onVolumeSlider sends the new volume.
    }

    _onVolumeSlider() {
        if (this._volumeUpdating || !this._player)
            return;
        const value = this._volumeSlider.value;
        this._syncVolumeLabels(value);

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

    _stopVolumeTimer() {
        if (this._volumeTimerId) {
            GLib.source_remove(this._volumeTimerId);
            this._volumeTimerId = 0;
        }
        this._volumePending = null;
    }

    // ---- Lyrics ------------------------------------------------------------

    _setShowLyrics(show) {
        const changed = show !== this._showLyrics;
        this._showLyrics = show;
        if (changed)
            this._animateLyrics(show);
        this._setChecked(this._lyricsButton, show);
        this._syncToggleColors();
        if (show) {
            this._loadLyrics();
            this._lyricsView.setPosition(this._progress.position);
        }
    }

    _animateLyrics(show) {
        const view = this._lyricsView;
        view.remove_transition('height');
        view.remove_transition('opacity');
        if (!St.Settings.get().enable_animations) {
            view.set_height(-1);
            view.opacity = 255;
            view.visible = show;
            return;
        }
        if (show) {
            view.set_height(-1); // measure the natural (stylesheet) height
            const [, full] = view.get_preferred_height(-1);
            view.set_height(0);
            view.opacity = 0;
            view.visible = true;
            view.ease({
                height: full,
                opacity: 255,
                duration: LYRICS_UNFOLD_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => view.set_height(-1),
            });
        } else {
            view.ease({
                height: 0,
                opacity: 0,
                duration: LYRICS_FOLD_MS,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    view.visible = false;
                    view.set_height(-1);
                },
            });
        }
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

        this._lyricsView.setLength(player.metadata.length);
        this._lyricsView.showMessage(_('Looking for lyrics…'));
        const lyrics = await this._lyrics.lookup(player.metadata).catch(() => null);
        if (serial !== this._lyricsSerial)
            return;

        if (lyrics) {
            this._lyricsView.setLyrics(lyrics, _('Instrumental'));
            this._lyricsView.setPosition(this._progress.position);
        } else if (!this._lyrics.onlineEnabled) {
            this._lyricsView.showMessage(
                _('This player does not provide lyrics. You can enable online lookup (lrclib.net, lyrics.ovh) in the preferences.'));
        } else {
            this._lyricsView.showMessage(_('No lyrics found'));
        }
    }
});
