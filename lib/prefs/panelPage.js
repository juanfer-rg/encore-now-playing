import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {comboRow, group, page, sensitiveWhen, spinRow, switchRow} from './common.js';

export function buildPanelPage(settings) {
    const p = page(_('Top Bar'), 'video-display-symbolic');

    const position = group(_('Position'));
    position.add(comboRow(settings, 'panel-box', _('Section'), [
        ['left', _('Left')],
        ['center', _('Center')],
        ['right', _('Right')],
    ]));
    position.add(spinRow(settings, 'panel-index', _('Order'), {
        min: 0, max: 20, subtitle: _('Counted among the visible items; 0 is the first'),
    }));
    position.add(switchRow(settings, 'hide-when-inactive', _('Hide when nothing is playing')));
    p.add(position);

    const content = group(_('Content'));
    content.add(comboRow(settings, 'panel-visualizer', _('Visualizer style'), [
        ['wave', _('Wave')],
        ['bars', _('Bars')],
        ['orbit', _('Orbit')],
    ], _('Moves while something is playing. White, or the artwork’s colors when album art colors are on.')));
    content.add(comboRow(settings, 'panel-icon', _('Icon'), [
        ['none', _('None')],
        ['app-icon', _('Player icon')],
        ['album-art', _('Album art')],
    ]));
    content.add(comboRow(settings, 'panel-text', _('Text'), [
        ['none', _('None')],
        ['title', _('Title')],
        ['title-artist', _('Title · Artist')],
        ['artist-title', _('Artist – Title')],
        ['lyrics', _('Lyrics')],
    ], _('Lyrics shows the current line and follows the song')));
    content.add(switchRow(settings, 'show-panel-controls', _('Playback buttons'),
        _('Previous, play/pause and next next to the text')));
    p.add(content);

    const text = group(_('Text'));
    text.add(spinRow(settings, 'max-text-width', _('Maximum width'), {
        min: 50, max: 800, step: 10, subtitle: _('In pixels'),
    }));
    text.add(switchRow(settings, 'scroll-text', _('Scroll long text')));
    const speed = spinRow(settings, 'scroll-speed', _('Scrolling speed'), {
        min: 10, max: 120, step: 5, subtitle: _('Pixels per second'),
    });
    sensitiveWhen(settings, 'scroll-text', speed);
    text.add(speed);
    p.add(text);

    const mouse = group(_('Mouse'), _('Middle-click the indicator to play or pause.'));
    mouse.add(comboRow(settings, 'panel-scroll-action', _('Scroll wheel'), [
        ['none', _('Nothing')],
        ['volume', _('Change volume')],
        ['track', _('Change track')],
    ]));
    p.add(mouse);

    return p;
}
