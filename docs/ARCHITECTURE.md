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
 │       ├─ lyricsView.js    ← synced lyrics, unfolded below the card
 │       └─ playerSidebar.js ← player icons on the left (several players)
 ├─ lib/ui/wave.js           ← the Android-style squiggly line (top bar and seek bar)
 ├─ lib/art/artCache.js      ← http artwork → ~/.cache, and color extraction
 ├─ lib/lyrics/lrclib.js     ← lyrics from the player or lrclib.net
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

## The audio wave

`lib/ui/wave.js` has two parts:

- **`WaveAnimator`** moves the wave. On every frame of a `Clutter.Timeline` it advances the phase and
  eases the amplitude towards 1 (playing) or 0 (paused). The timeline only runs while the actor is
  visible and something is moving. When animations are turned off system-wide, the wave is drawn
  still.
- **`traceWave()`** adds the sine path to a cairo context. The top bar's `WaveLine` tapers it towards
  both ends. The seek bar (`WavySlider` in `progressBar.js`) draws it only for the part already played,
  followed by a straight line and a pill-shaped handle. `WavySlider` subclasses the Shell's `Slider`,
  so dragging, the keyboard and screen readers keep working.

Sizes and wave shape live in `stylesheet.css` as `-encore-wave-*` lengths, so they can be tuned
without touching the code.

## Colors from the artwork

`palette.js` imports nothing from GNOME, which is why it can be tested with plain `gjs`:

1. The image is shrunk to 32×32 pixels.
2. Grays and near-black pixels are skipped.
3. Each pixel goes into one of 12 hue buckets, weighted by saturation × brightness.
4. The heaviest bucket is the main color; the strongest bucket at least 60° of hue away is the accent.
5. `cardColors()` darkens the background and brightens the accent until both read well.

The accent colors the wave in the top bar, the seek bar, the volume slider and the active toggles.

## Ideas for going further

- Add a language: `cp po/es.po po/fr.po`, translate it and run `make locale`.
- Add a setting, in three steps:
  1. a `<key>` in the schema
  2. a row in `lib/prefs/*.js`
  3. read it in the `_onSettingsChanged()` of the widget that uses it
- Skip back/forward 10 seconds: `player.seekTo(progress.position ± 10e6, progress.position)`.
