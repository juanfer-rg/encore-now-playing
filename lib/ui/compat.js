import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

// St.BoxLayout gained an "orientation" property in GNOME 48, which deprecates
// "vertical". GNOME 46 and 47 only know "vertical".
const HAS_ORIENTATION =
    !!GObject.Object.find_property.call(St.BoxLayout, 'orientation');

/**
 * Construct properties for a vertical St.BoxLayout on any supported GNOME.
 *
 * @returns {object}
 */
export function verticalProps() {
    return HAS_ORIENTATION
        ? {orientation: Clutter.Orientation.VERTICAL}
        : {vertical: true};
}
