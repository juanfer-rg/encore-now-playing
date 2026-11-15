# Encore - Now Playing

A music player card for GNOME Shell 48–50. It works with any player that supports
[MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/): Spotify, Rhythmbox, Lollypop, mpv
(with mpv-mpris), VLC, Firefox, Chromium and others.

## Features

- **Top bar indicator**: an audio visualizer, always shown. It moves while *any* player is playing
  and settles when everything is paused. Three styles:
  - *wave*: Encore's ribbon, two thin strands that twist around each other
  - *bars*: rounded bars that rise and fall smoothly
  - *signal*: a layered line that breathes

  It is white, or, with album art colors on, a blend of up to three colors of the artwork that is
  playing. The visualizers are animations, not an analysis of the actual sound. Album art or the
  player icon, the title and artist (scrolling when it does not fit) and previous/play/next buttons
  can be added in the preferences.
- **Player card in two styles**, switched with the button in its corner, next to the lyrics button
  (or in the preferences):
  - *compact*: artwork on the left; title and "artist - album [year]" with the player's icon in
    front (both scroll when they do not fit), transport controls with shuffle and repeat, a ribbon
    seek bar with a "remaining / total" counter, and the volume across the bottom
  - *large*: big artwork on top, everything else below it

  The artwork has a fixed size in each style (150 px compact, 340 px large), whatever the player or
  the shape of its image; wide video thumbnails are cropped to a square.
- **Follows GNOME's light and dark style**, switching live when you change it.
- **Colors from the artwork**: the waves blend up to three of the artwork's colors, the volume slider
  and the active buttons take its main color, and a soft ambient glow appears behind the artwork. The
  card itself keeps the normal popup background. With the option off, a manual accent color is used
  and there is no glow.
- **Several players**: the most recent one is chosen automatically. A bar on the left of the card shows
  each running player's icon (with a dot under the ones playing); click one to show it in the card.
  Optionally, other players pause when one starts.
- **Lyrics**: they unfold below the card and scroll by themselves with the song, with no scrollbar.
  The current line is centered, bigger and bright, its neighbors a little smaller and the rest faint,
  and the top and bottom edges fade out. Unsynced lyrics are spread over the track so they scroll
  line by line too. Behind them there is a very subtle backdrop; with album art colors on, it is soft
  glows in the artwork's colors that drift slowly. Scrolling by hand pauses the following for a
  moment, and clicking a synced line jumps there. Lyrics come from, in order:
  - the player itself (`xesam:asText`)
  - for local files, a `.lrc` file with the same name beside the track, or lyrics embedded in the
    file (MP3 ID3 USLT/SYLT, FLAC `LYRICS`/`UNSYNCEDLYRICS` tags), no internet needed
  - if you turn it on (off by default), [lrclib.net](https://lrclib.net) and
    [lyrics.ovh](https://lyrics.ovh), asked in parallel; synced lyrics win
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
  current track are then sent to lrclib.net and lyrics.ovh.

Downloaded artwork is cached in `~/.cache/encore-now-playing/art`. The cache is trimmed to the size
set in the preferences (50 MB by default).

## License

Not chosen yet. extensions.gnome.org requires a GPL-compatible license; GPL-2.0-or-later (the
license of GNOME Shell itself) is the usual choice.
