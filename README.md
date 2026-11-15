# Encore - Now Playing

A music player card for GNOME Shell 48–50. It works with any player that supports
[MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/): Spotify, Rhythmbox, Lollypop, mpv
(with mpv-mpris), VLC, Firefox, Chromium and others.

## Features

- **Top bar indicator**: by default, just an audio visualizer. It moves while *any* player is playing
  and settles when everything is paused. Three styles:
  - *wave*: the squiggly line of Android's media controls
  - *spectrum*: Winamp's classic spectrum analyzer, bars with falling peaks
  - *oscilloscope*: Winamp's classic scope

  With album art colors on, it takes the color of the artwork that is playing; otherwise the wave uses
  the panel's text color and the Winamp styles their classic green-yellow-red. The visualizers are
  animations, not an analysis of the actual sound. Album art or the player icon, the title and artist
  (scrolling when it does not fit) and previous/play/next buttons can be turned on in the preferences.
- **Player card in two styles**, switched with the button in its corner (or in the preferences):
  - *compact*: artwork on the left (with the player's icon as a badge); title, "artist - album
    [year]", transport controls with shuffle and repeat, a wavy seek bar with elapsed and remaining
    time, and a small volume slider on the right
  - *large*: big artwork on top, everything else below it

  The artwork has a fixed size in each style (150 px compact, 340 px large), whatever the player or
  the shape of its image; wide video thumbnails are cropped to a square.
- **Follows GNOME's light and dark style**, switching live when you change it.
- **Colors from the artwork**: the waves, the volume slider and the active buttons take the album
  art's color, and a soft ambient glow (like YouTube's ambient mode) appears behind the artwork. The
  card itself keeps the normal popup background. With the option off, a manual accent color is used
  and there is no glow.
- **Several players**: the most recent one is chosen automatically. A bar on the left of the card shows
  each running player's icon (with a dot under the ones playing); click one to show it in the card.
  Optionally, other players pause when one starts.
- **Synced lyrics, Spotify-style**: they unfold below the card and follow the song. The current line is
  bright, the ones already sung dimmed and the upcoming ones faint; scrolling by hand pauses the
  following for a moment, and clicking a line jumps there. Lyrics come from the player
  (`xesam:asText`) or, if you turn it on (off by default), from [lrclib.net](https://lrclib.net).
- **Extras**:
  - blocklist for players you never want to see
  - option to hide GNOME's built-in media player
  - click the artwork to bring the player window to the front
- **Mouse**: middle-click the indicator to play or pause. The scroll wheel changes volume or track.
- **Translations**: English and Spanish.

## Install from source

```bash
make install        # compiles schemas/translations and symlinks this folder
```

On Wayland, log out and back in, then:

```bash
make enable
```

## Development

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the code is organized.

| Command | What it does |
| --- | --- |
| `make test` | Unit tests for the pure logic (colors, LRC parser, helpers) with plain `gjs` |
| `make logs` | Follow GNOME Shell's log (`journalctl`) |
| `make pot` | Regenerate `po/encore-now-playing.pot` and merge it into every `.po` file |
| `make pack` | Build `dist/<uuid>.shell-extension.zip` for extensions.gnome.org |
| `make lint` | Run ESLint (run `npm install` first) |

### Test without a real player

```bash
gjs -m tests/mockPlayer.js --lyrics
```

This starts a fake MPRIS player (`org.mpris.MediaPlayer2.EncoreTest`) with three tracks. It has
artwork, synced lyrics, and supports seek, volume, shuffle and repeat. It prints every call it receives.
Run a second one with another name to test the player switcher:

```bash
gjs -m tests/mockPlayer.js Second
```

### Nested session

GNOME 49+ replaced `--nested` with the development kit (install `mutter-dev-bin` or your
distribution's equivalent):

```bash
dbus-run-session gnome-shell --devkit --wayland
```

## Privacy

Encore only talks to the network in two cases:

- **Artwork**: the player itself gives an `http(s)` URL for it.
- **Lyrics**: only after you turn on online lyrics lookup. The artist, title, album and duration of the
  current track are then sent to lrclib.net.

Downloaded artwork is cached in `~/.cache/encore-now-playing/art`. The cache is trimmed to the size
set in the preferences (50 MB by default).

## License

Not chosen yet. extensions.gnome.org requires a GPL-compatible license; GPL-2.0-or-later (the
license of GNOME Shell itself) is the usual choice.
