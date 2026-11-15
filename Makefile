UUID      := encore-now-playing@juanfer-rg.github.io
DOMAIN    := encore-now-playing
EXT_DIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR   := $(CURDIR)
JS_FILES  := extension.js prefs.js $(shell find lib -name '*.js')
PO_FILES  := $(wildcard po/*.po)
MO_FILES  := $(patsubst po/%.po,locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))

.PHONY: all schemas locale pot install uninstall enable disable pack test lint clean logs

all: schemas locale

## Compile the GSettings schema (needed for a symlinked dev install).
schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas --strict schemas/

## Compile translations into locale/ (needed for a symlinked dev install).
locale: $(MO_FILES)

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	@mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

## Regenerate the translation template from the sources.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=N_ --keyword=ngettext:1,2 \
		--package-name="$(DOMAIN)" -o po/$(DOMAIN).pot $(JS_FILES)
	xgettext --from-code=UTF-8 --join-existing -o po/$(DOMAIN).pot \
		schemas/*.gschema.xml
	@for po in $(PO_FILES); do msgmerge --quiet --update --backup=none $$po po/$(DOMAIN).pot; done

## Symlink this folder into the user's extension directory.
install: all
	@mkdir -p $(dir $(EXT_DIR))
	@if [ -e "$(EXT_DIR)" ] && [ ! -L "$(EXT_DIR)" ]; then \
		echo "$(EXT_DIR) exists and is not a symlink; remove it first"; exit 1; fi
	ln -sfn "$(SRC_DIR)" "$(EXT_DIR)"
	@echo "Installed. On Wayland, log out and back in, then run: make enable"

uninstall:
	rm -f "$(EXT_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

## Build the zip for extensions.gnome.org.
pack:
	@mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--extra-source=lib \
		--podir=po --schema=schemas/org.gnome.shell.extensions.$(DOMAIN).gschema.xml .
	@echo "dist/$(UUID).shell-extension.zip"

## Pure-logic unit tests (run with plain gjs, outside GNOME Shell).
test:
	@for t in tests/*.test.js; do echo "== $$t"; gjs -m $$t || exit 1; done

## ESLint with the GNOME Shell style (run `npm install` once first).
lint:
	npx eslint $(JS_FILES) tests

## Follow GNOME Shell's log.
logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf dist locale schemas/gschemas.compiled
