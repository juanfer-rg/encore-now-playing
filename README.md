# Encore - Now Playing

A music player card for GNOME Shell 48–50. It works with any player that supports
[MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/): Spotify, Rhythmbox, Lollypop, mpv
(with mpv-mpris), VLC, Firefox, Chromium and others.

## Features

- **Top bar indicator**: album art or player icon, plus the title and artist. Text that does not fit
  scrolls. Previous/play/next buttons are optional.
- **Player card**:
  - artwork
  - title, artist and album
  - seek bar with elapsed and total time
  - transport controls, shuffle and repeat
  - per-player volume
- **Colors from the artwork**: the popup is tinted with the album art's dominant colors, or a manual
  accent color if you prefer.
- **Several players**: the most recent one is chosen automatically, and a switcher lets you pick another.
  Optionally, other players pause when one starts.
- **Synced lyrics**: taken from the player (`xesam:asText`) when it provides them. You can also turn on
  lookup on [lrclib.net](https://lrclib.net); it is off by default. Click a line to jump to it.
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
