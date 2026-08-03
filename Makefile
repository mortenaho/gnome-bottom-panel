#!/usr/bin/make -f
# Makefile — build schemas, pack, and install Bottom Panel

UUID = bottom-panel@mortenaho.github.io
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall pack enable disable restart-shell logs clean

all: schemas

schemas:
	glib-compile-schemas schemas/

install: schemas
	mkdir -p "$(EXT_DIR)"
	rsync -a --delete \
		--exclude '.git/' \
		--exclude 'agent-tools/' \
		--exclude '*.zip' \
		--exclude 'Makefile' \
		--exclude 'install.sh' \
		--exclude '.gitignore' \
		--exclude 'README.md' \
		./ "$(EXT_DIR)/"
	glib-compile-schemas "$(EXT_DIR)/schemas/"
	@echo "Installed to $(EXT_DIR)"
	@echo "Enable with: make enable  (then restart the Shell / session)"

uninstall:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf "$(EXT_DIR)"
	@echo "Removed $(EXT_DIR)"

# Zip contents for extensions.gnome.org: runtime files only.
pack: schemas
	rm -f $(UUID).zip
	zip -r $(UUID).zip \
		metadata.json \
		extension.js \
		panel.js \
		panelManager.js \
		prefs.js \
		stylesheet.css \
		LICENSE \
		indicators \
		widgets \
		utils \
		flags \
		schemas/*.gschema.xml \
		-x "*~" -x "*.gschema.xml~" -x "schemas/gschemas.compiled"
	@echo "Created $(UUID).zip"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# X11 only. On Wayland, log out/in or use Extensions app toggle.
restart-shell:
	@if [ "$$XDG_SESSION_TYPE" = "wayland" ]; then \
		echo "Wayland session detected: Alt+F2 r is unavailable."; \
		echo "Toggle the extension off/on, or log out and back in."; \
	else \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart(_("Restarting…"))'; \
	fi

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

clean:
	rm -f $(UUID).zip
	rm -f schemas/gschemas.compiled
