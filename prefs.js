import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildBehaviorPage} from './lib/prefs/behaviorPage.js';
import {buildCardPage} from './lib/prefs/cardPage.js';
import {buildPanelPage} from './lib/prefs/panelPage.js';
import {buildPlayersPage} from './lib/prefs/playersPage.js';

export default class EncorePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.search_enabled = true;

        window.add(buildPanelPage(settings));
        window.add(buildCardPage(settings));
        window.add(buildPlayersPage(settings));
        window.add(buildBehaviorPage(settings, window, this.metadata));

        // Keep the settings object alive as long as the window.
        window._settings = settings;
    }
}
