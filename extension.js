import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtCache} from './lib/art/artCache.js';
import {LyricsProvider} from './lib/lyrics/lrclib.js';
import {MprisManager} from './lib/mpris/manager.js';
import {NativePlayerHider} from './lib/nativePlayerHider.js';
import {EncoreIndicator} from './lib/ui/indicator.js';
import {PanelPlacement} from './lib/ui/panelPlacement.js';

export default class EncoreExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const userAgent = `Encore-Now-Playing/${this.metadata['version-name'] ?? 'dev'} (${this.metadata.url})`;

        this._artCache = new ArtCache(this._settings);
        this._artCache.setUserAgent(userAgent);
        this._lyrics = new LyricsProvider(this._settings, userAgent);
        this._manager = new MprisManager(this._settings);
        this._nativeHider = new NativePlayerHider();

        this._createIndicator();
        this._syncNativeHider();

        this._settings.connectObject(
            'changed::panel-box', () => this._createIndicator(),
            'changed::panel-index', () =>
                this._placement?.setIndex(this._settings.get_int('panel-index')),
            'changed::hide-native-player', () => this._syncNativeHider(),
            this);
    }

    disable() {
        this._settings.disconnectObject(this);

        this._nativeHider.disable();
        this._nativeHider = null;

        this._placement?.destroy();
        this._placement = null;
        this._indicator?.destroy();
        this._indicator = null;

        this._manager.destroy();
        this._manager = null;

        this._lyrics.destroy();
        this._lyrics = null;

        this._artCache.destroy();
        this._artCache = null;

        this._settings = null;
    }

    // The indicator is rebuilt when its section changes: moving it to
    // another section would need the panel's private boxes. The order inside
    // the section is kept by PanelPlacement.
    _createIndicator() {
        this._placement?.destroy();
        this._placement = null;
        this._indicator?.destroy();
        this._indicator = new EncoreIndicator({
            manager: this._manager,
            settings: this._settings,
            artCache: this._artCache,
            lyrics: this._lyrics,
        });
        const index = this._settings.get_int('panel-index');
        Main.panel.addToStatusArea(this.uuid, this._indicator, index,
            this._settings.get_string('panel-box'));
        this._placement = new PanelPlacement(this._indicator.container, index);
    }

    _syncNativeHider() {
        if (this._settings.get_boolean('hide-native-player'))
            this._nativeHider.enable();
        else
            this._nativeHider.disable();
    }
}
