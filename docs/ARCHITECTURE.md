# How Encore works

A short guide to understanding (and changing) the extension.

## Lifecycle

GNOME Shell loads `extension.js` and calls two methods:

- **`enable()`** creates everything, in this order:
  1. the settings (`getSettings()`)
  2. the album art cache
  3. the lyrics provider
  4. the MPRIS manager
  5. the top bar indicator
- **`disable()`** destroys everything in reverse order and sets every field to `null`. It also runs
  when the screen locks, so **nothing may stay alive**: no signal handlers, no timers
  (`GLib.timeout_add`), no network requests. This is the rule extensions.gnome.org reviewers check
  most closely.

Nothing is created at module level or in the `Extension` constructor.

## Layers

```
extension.js
 ├─ lib/mpris/manager.js     ← finds players and picks the "active" one
 │   └─ lib/mpris/player.js  ← one player: D-Bus proxies, state, commands
 ├─ lib/ui/indicator.js      ← top bar button (PanelMenu.Button) with the audio wave
 │   └─ lib/ui/mediaCard.js  ← the compact card in the popup
 │       ├─ progressBar.js   ← wavy seek bar + position timer
 │       ├─ lyricsView.js    ← lyrics canvas, unfolded below the card
 │       └─ playerSidebar.js ← player icons on the left (several players)
 ├─ lib/ui/panelLyrics.js    ← current lyric line for the top bar, even with the card closed
 ├─ lib/ui/wave.js           ← animation driver + Encore's ribbon (two twisting strands)
 ├─ lib/ui/visualizer.js     ← top bar visualizer: wave, bars, orbit
 ├─ lib/art/artCache.js      ← http artwork → ~/.cache, and color extraction
 ├─ lib/lyrics/lrclib.js     ← lyrics: player, local files, lrclib.net, lyrics.ovh
 │   ├─ local.js             ← "<track>.lrc" beside local files, and tags inside them
 │   └─ embedded.js          ← MP3 (ID3 USLT/SYLT) and FLAC (Vorbis) lyrics parser
 └─ lib/nativePlayerHider.js ← hides GNOME's built-in player (private API)
```

**The model knows nothing about the UI.** `MprisManager` emits signals and the UI listens to them:

- `players-changed`
- `active-changed`
- `active-updated`
- `active-seeked`

So the whole card can be redesigned without touching the MPRIS code.

## MPRIS in two minutes

Every player puts a name like `org.mpris.MediaPlayer2.<something>` on the session bus, with two
interfaces:

- `org.mpris.MediaPlayer2`: `Identity`, `DesktopEntry` and `Raise()`.
- `org.mpris.MediaPlayer2.Player`: `PlaybackStatus`, `Metadata`, `Volume`, `PlayPause()`,
  `SetPosition()`, and so on.

Things worth knowing:

1. **Discovery**: the manager first listens to `NameOwnerChanged` and *then* calls `ListNames`. The
   other way round, a player that starts between the two calls would be missed.
2. **`Position` is never signalled**: players do not announce position changes. So `progressBar.js`:
   - reads it with `Properties.Get` every 5 seconds
   - advances it locally every 250 ms in between
   - listens to the `Seeked` signal
   - does all of this only while the popup is open
3. **Everything is asynchronous**: a `call_sync` would freeze the whole compositor (pointer, windows,
   everything). Every D-Bus or network call uses `async`/`await` and a `Gio.Cancellable` that is
   cancelled in `destroy()`.

## Signals without leaks

Instead of storing handler ids and disconnecting them by hand, the code uses `connectObject`, which
GNOME Shell adds to every GObject:

```js
manager.connectObject('active-changed', () => this._sync(), this);
// ...
manager.disconnectObject(this);   // in _onDestroy
```

When the third argument is an actor (a widget), the handlers are disconnected automatically when it
is destroyed.

## The ribbon

Encore's wave is a "ribbon": two thin strands in counter-phase that cross at regular points and look
twisted, scaled by a swell that travels along them and a slow "breath" over time, so it keeps
changing shape. Both stay above 60 % so the motion is always clear. When playback stops it settles into one
straight line. `lib/ui/wave.js` has two parts:

- **`WaveAnimator`** moves it. On every frame of a `Clutter.Timeline` it advances the phase and eases
  the amplitude towards 1 (playing) or 0 (paused). The phase is never wrapped: the travelling swell
  moves at a different speed than the strands, and wrapping made the whole ribbon jump once per
  cycle. The timeline only runs while the actor is visible
  and something is moving. When animations are turned off system-wide, it is drawn still.
- **`drawRibbon()`** draws the two strands (`traceStrand()`): the faint, thinner partner first, then
  the main one. The top bar visualizer tapers it towards both ends. The seek bar (`WavySlider` in
  `progressBar.js`) draws it only for the part already played, followed by a thin straight line and
  a round handle with a soft halo. The position itself only updates four times a second, so the
  handle is drawn where it *would* be now (`setLive()`: last position plus the time since, at playback
  speed) and glides on every frame instead of moving in steps. `WavySlider` subclasses the Shell's `Slider`, so dragging, the
  keyboard and screen readers keep working.

Sizes and shape live in `stylesheet.css` as `-encore-wave-*` lengths, so they can be tuned without
touching the code.

## The top bar visualizer

`PanelVisualizer` (`lib/ui/visualizer.js`) is always shown and draws one of three styles with cairo:
the wave, bars (rounded and mirrored around the middle, each driven by sines of its own plus random
beats) or orbit (two dots with fading trails tracing Lissajous figures). They are animations, not an
analysis of the sound: GNOME Shell cannot read the audio without spawning a capture process.

None of them loops the same way. `Drift` (in `wave.js`) is a value that picks a new random target
every few seconds and glides there with smoothstep, so nothing ever jumps. The ribbon's speed, height
and twist length drift (in `WaveAnimator`, so the seek bar varies too); the bars' peak position and
loudness drift and a random "kick" decays every 0.35–1 s; the orbit's speed and size drift, and every
5–10 s it morphs over 1.6 s into another figure (ellipse, figure eight, pretzel, knots).

It moves while *any* player plays: `MprisManager` emits `playback-changed` whenever the set of playing
players, or what they play, changes, and `indicator.js` asks `manager.playing`. With album art colors
on, `lib/art/accent.js` gives it up to three colors of the artwork that is playing, blended
horizontally (`waveColors()` in `palette.js`); otherwise it is white, the panel's text color. The
seek bar in the card blends the same colors.

## Colors from the artwork

`palette.js` imports nothing from GNOME, which is why it can be tested with plain `gjs`:

1. The image is shrunk to 32×32 pixels.
2. Grays and near-black pixels are skipped.
3. Each pixel goes into one of 12 hue buckets, weighted by saturation × brightness.
4. The heaviest bucket is the main color; the strongest bucket at least 60° of hue away is the accent.
5. `cardColors()` darkens the background and brightens the accent until both read well.

The accent colors the wave in the top bar, the seek bar, the volume slider, the active toggles and
the dots in the player bar. The card background is never tinted. With "Colors from album art" on,
`mediaCard.js` also shows an ambient glow: a blurred copy of the artwork (`Shell.BlurEffect`) placed
behind it, bigger than it, inside a fixed-size holder so it can spill around the artwork without
changing the layout.

## Light and dark style

Text, buttons, sliders and the lyrics (drawn with the popup's text color) follow GNOME's style on
their own. The
few colors the stylesheet pins (the player dots) have light counterparts under `.encore-light`, a class `indicator.js` sets on the popup box while
`Main.getStyleVariant()` is `light`, updated live on `notify::color-scheme`.

A separate `stylesheet-light.css` would not work well here: GNOME loads only one stylesheet per
extension, and St does not rank `@import`ed rules above the Shell theme, so it would have to repeat
every rule.

## Lyrics

`LyricsProvider` (`lib/lyrics/lrclib.js`) tries, in order:

1. the player's own lyrics (`xesam:asText`)
2. for local tracks (`xesam:url` is `file://`), `local.js`: a `<name>.lrc` file beside the track, and
   lyrics embedded in its tags, read by `embedded.js`. That parser only walks the tag area at the
   start of the file and *skips* big parts such as the cover picture, so it reads a few kilobytes,
   not the whole file. Synced lyrics win; between two of the same kind, the `.lrc` file wins
3. only with online lookup on, three requests at once: lrclib.net exact match, lrclib.net search
   (closest duration within 5 s) and lyrics.ovh (plain text). Synced beats plain, lrclib beats
   lyrics.ovh

`LyricsView` draws everything on one `St.DrawingArea` with Pango, so there is no scrollbar: the
current line is centered and bigger, its neighbors a little smaller, the rest faint, and a mask fades
the top and bottom edges. The scroll position eases towards its target on every frame of a
`Clutter.Timeline` that only runs while the view is on screen. Unsynced lyrics are spread evenly over
the track (`distributePlainLyrics()` in `lrc.js`) so they scroll line by line too. Behind the text, a
very subtle backdrop: a neutral tint, or soft radial glows in the artwork's colors that drift slowly.

## The two card layouts

`MediaCard` creates its widgets once and `_arrange()` moves them into the containers of the current
layout (`compact` or `large`, from the `card-layout` setting). The button in the card's corner just
flips that setting, so the choice is remembered and the preferences stay in sync.

## Ideas for going further

- Add a language: `cp po/es.po po/fr.po`, translate it and run `make locale`.
- Add a setting, in three steps:
  1. a `<key>` in the schema
  2. a row in `lib/prefs/*.js`
  3. read it in the `_onSettingsChanged()` of the widget that uses it
- Skip back/forward 10 seconds: `player.seekTo(progress.position ± 10e6, progress.position)`.
