# Cómo está hecha Encore

Guía corta para entender (y modificar) tu primera extensión.

## El ciclo de vida

GNOME Shell carga `extension.js` y llama a dos métodos:

- **`enable()`**: crea todo, en este orden:
  1. los ajustes (`getSettings()`)
  2. la caché de carátulas
  3. el proveedor de letras
  4. el gestor MPRIS
  5. el indicador del panel
- **`disable()`**: destruye todo en orden inverso y pone cada campo a `null`. Se llama también al
  bloquear la pantalla, así que **nada puede quedar vivo**: ni señales, ni temporizadores
  (`GLib.timeout_add`), ni peticiones de red. Es la regla que más revisa extensions.gnome.org.

Nada se crea a nivel de módulo ni en el constructor de la clase `Extension`.

## Las capas

```
extension.js
 ├─ lib/mpris/manager.js     ← descubre reproductores y elige el "activo"
 │   └─ lib/mpris/player.js  ← un reproductor: proxies D-Bus, estado, comandos
 ├─ lib/ui/indicator.js      ← botón del panel (PanelMenu.Button)
 │   └─ lib/ui/mediaCard.js  ← la tarjeta del popup
 │       ├─ progressBar.js   ← barra de progreso + temporizador de posición
 │       ├─ lyricsView.js    ← letras sincronizadas
 │       └─ playerSwitcher.js
 ├─ lib/art/artCache.js      ← carátulas http → ~/.cache, y extracción de color
 ├─ lib/lyrics/lrclib.js     ← letras: del reproductor o de lrclib.net
 └─ lib/nativePlayerHider.js ← oculta el reproductor nativo (API privada)
```

**El modelo no conoce la UI.** `MprisManager` emite señales y la UI las escucha:

- `players-changed`
- `active-changed`
- `active-updated`
- `active-seeked`

Así puedes cambiar la tarjeta entera sin tocar MPRIS.

## MPRIS en dos minutos

Cada reproductor publica en el bus de sesión un nombre `org.mpris.MediaPlayer2.<algo>` con dos
interfaces:

- `org.mpris.MediaPlayer2`: `Identity`, `DesktopEntry` y `Raise()`.
- `org.mpris.MediaPlayer2.Player`: `PlaybackStatus`, `Metadata`, `Volume`, `PlayPause()`, `SetPosition()`, etc.

Detalles que conviene saber:

1. **Descubrimiento**: primero se escucha `NameOwnerChanged` y *después* se llama a `ListNames`. Si
   fuera al revés, un reproductor que se abra justo entre las dos llamadas se perdería.
2. **`Position` no se notifica**: el reproductor nunca avisa de que la posición cambió. Por eso
   `progressBar.js` hace esto:
   - la lee con `Properties.Get` cada 5 s
   - la avanza localmente cada 250 ms entre lecturas
   - escucha la señal `Seeked`
   - solo hace todo esto mientras el popup está abierto
3. **Todo es asíncrono**: un `call_sync` bloquearía el compositor entero (ratón, ventanas, todo). Por eso
   cada llamada D-Bus o de red usa `async`/`await` y un `Gio.Cancellable` que se cancela en `destroy()`.

## Señales sin fugas

En lugar de guardar ids y desconectarlos a mano, se usa `connectObject`, que añade GNOME Shell:

```js
manager.connectObject('active-changed', () => this._sync(), this);
// ...
manager.disconnectObject(this);   // en _onDestroy
```

Si el tercer argumento es un actor (un widget), las señales se desconectan solas cuando se destruye.

## Colores desde la carátula

`palette.js` no importa nada de GNOME (por eso se puede probar con `gjs` a secas):

1. La imagen se reduce a 32×32 píxeles.
2. Se descartan los grises y los casi negros.
3. Cada píxel se reparte en uno de 12 "cubos" de tono, con peso saturación × brillo.
4. El cubo más pesado da el color principal; el más fuerte a ≥ 60° de tono da el acento.
5. `cardColors()` oscurece el fondo y aclara el acento hasta que se lean bien.

## Ideas para seguir aprendiendo

- Añadir otro idioma: `cp po/es.po po/fr.po`, traducir y ejecutar `make locale`.
- Añadir un ajuste nuevo, en tres pasos:
  1. una `<key>` en el schema
  2. una fila en `lib/prefs/*.js`
  3. leerlo en `_onSettingsChanged()` del widget que lo use
- Botones de "retroceder/avanzar 10 s": `player.seekTo(progress.position ± 10e6, progress.position)`.
