// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {KEY, THEME_COLOR, normalizeColor} from './common.js';
// Below WCAG AA for normal text, the white text of the top bar gets hard to read.
const MIN_CONTRAST = 4.5;
// The most workspaces mutter accepts.
const MAX_WORKSPACES = 36;

const STYLE = `
.peacock-preview {
    min-width: 48px;
    min-height: 28px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-weight: bold;
}
.peacock-preview.theme {
    border-style: dashed;
    border-color: alpha(currentColor, 0.4);
    color: alpha(currentColor, 0.6);
}
.peacock-column {
    margin-right: 10px;
}
.peacock-handle {
    opacity: 0.5;
}
.peacock-handle.placeholder {
    opacity: 0;
}
.peacock-drop-target {
    background-color: alpha(@accent_bg_color, 0.2);
}
.peacock-header {
    min-height: 0;
    background-color: alpha(currentColor, 0.03);
}
/* The header row is shorter than the others. These selectors reach into
   AdwActionRow's internal nodes, which are not public API: if libadwaita
   renames them, the header just goes back to the normal row height. */
.peacock-header box {
    min-height: 0;
}
.peacock-header > box.header {
    padding-top: 6px;
    padding-bottom: 6px;
}
.peacock-header box.title {
    padding-top: 0;
    padding-bottom: 0;
}
.peacock-header label {
    font-size: smaller;
    font-weight: bold;
    opacity: 0.6;
}
`;

// Missing entries (a list shorter than the rows, no default for a position)
// count as the theme's color.
function parseColor(value) {
    const color = normalizeColor(value ?? '');
    const rgba = new Gdk.RGBA();
    if (!color || !rgba.parse(color))
        return null;
    return rgba;
}

function toHex(rgba) {
    const channels = [rgba.red, rgba.green, rgba.blue]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0'));
    return `#${channels.join('')}`;
}

function contrastWithWhite(rgba) {
    const [r, g, b] = [rgba.red, rgba.green, rgba.blue]
        .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

export default class WorkspacePeacockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._rows = [];

        // The preview colors change at runtime, so they live in a stylesheet
        // regenerated on every sync rather than in fixed CSS classes.
        const styleProvider = new Gtk.CssProvider();
        styleProvider.load_from_string(STYLE);
        this._colorProvider = new Gtk.CssProvider();
        const providers = [styleProvider, this._colorProvider];
        const display = Gdk.Display.get_default();
        for (const provider of providers) {
            Gtk.StyleContext.add_provider_for_display(display, provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        }

        // Fits four workspaces without empty space below; more rows scroll.
        window.set_default_size(560, 520);
        const page = new Adw.PreferencesPage();
        window.add(page);

        // The description depends on the workspace mode: _sync() sets it.
        this._group = new Adw.PreferencesGroup({title: 'Workspaces'});
        page.add(this._group);

        const countButtons = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
        this._removeButton = new Gtk.Button({icon_name: 'list-remove-symbolic'});
        this._addButton = new Gtk.Button({icon_name: 'list-add-symbolic'});
        countButtons.append(this._removeButton);
        countButtons.append(this._addButton);
        this._group.set_header_suffix(countButtons);

        // A header row names the preview column once, so the rows need not
        // repeat "Workspace". Being a row itself, it lines up with the others;
        // the size group makes the previews as wide as its label.
        this._previewSizeGroup = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL});
        const headerLabel = new Gtk.Label({
            label: 'Workspace',
            css_classes: ['peacock-column'],
        });
        this._previewSizeGroup.add_widget(headerLabel);
        const header = new Adw.ActionRow({
            activatable: false,
            selectable: false,
            css_classes: ['peacock-header'],
        });
        header.add_prefix(headerLabel);
        // Invisible, it takes the place of the rows' drag handles.
        header.add_prefix(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            css_classes: ['peacock-handle', 'placeholder'],
        }));
        this._group.add(header);

        const resetGroup = new Adw.PreferencesGroup();
        const resetButton = new Gtk.Button({label: 'Restore', valign: Gtk.Align.CENTER});
        // The subtitle depends on the workspace mode: _sync() sets it.
        this._resetRow = new Adw.ActionRow({
            title: 'Restore Default Colors',
            activatable_widget: resetButton,
        });
        this._resetRow.add_suffix(resetButton);
        resetGroup.add(this._resetRow);
        page.add(resetGroup);

        this._addButton.connect('clicked', () => this._addWorkspace());
        this._removeButton.connect('clicked', () => this._removeWorkspace());
        resetButton.connect('clicked', () => this._settings.reset(KEY));

        // The window stays in sync with changes made elsewhere, e.g. gsettings.
        const handlers = [
            [this._settings, this._settings.connect(`changed::${KEY}`, () => this._sync())],
            [this._wmSettings, this._wmSettings.connect('changed::num-workspaces', () => this._sync())],
            [this._mutterSettings, this._mutterSettings.connect('changed::dynamic-workspaces', () => this._sync())],
        ];
        window.connect('close-request', () => {
            handlers.forEach(([settings, id]) => settings.disconnect(id));
            for (const provider of providers)
                Gtk.StyleContext.remove_provider_for_display(display, provider);
            // The shell keeps this object after the window closes: drop every
            // reference to the window's objects so they can be collected.
            this._window = null;
            this._settings = null;
            this._wmSettings = null;
            this._mutterSettings = null;
            this._rows = null;
            this._colorProvider = null;
            this._group = null;
            this._removeButton = null;
            this._addButton = null;
            this._previewSizeGroup = null;
            this._resetRow = null;
            return false;
        });

        this._sync();
    }

    _getDefaultColor(index) {
        return this._settings.get_default_value(KEY).deepUnpack()[index];
    }

    _isDynamic() {
        return this._mutterSettings.get_boolean('dynamic-workspaces');
    }

    // With fixed workspaces there is one row per workspace, and the colors of
    // workspaces removed earlier stay in the list, hidden, for when they come
    // back. With dynamic workspaces the shell decides how many there are, so
    // the rows are the color list itself.
    _getRowCount() {
        return this._isDynamic()
            ? this._settings.get_strv(KEY).length
            : this._wmSettings.get_int('num-workspaces');
    }

    _addWorkspace() {
        const count = this._getRowCount() + 1;

        // A new workspace gets the prepared color of its position, unless the
        // list still holds one from before.
        const colors = this._settings.get_strv(KEY);
        if (colors.length < count) {
            while (colors.length < count)
                colors.push(this._getDefaultColor(colors.length) ?? THEME_COLOR);
            this._settings.set_strv(KEY, colors);
        }
        if (!this._isDynamic())
            this._wmSettings.set_int('num-workspaces', count);
    }

    _removeWorkspace() {
        if (this._isDynamic())
            this._settings.set_strv(KEY, this._settings.get_strv(KEY).slice(0, -1));
        else
            this._wmSettings.set_int('num-workspaces', this._getRowCount() - 1);
    }

    _sync() {
        const colors = this._settings.get_strv(KEY);
        const count = this._getRowCount();

        while (this._rows.length > count) {
            const {row, preview} = this._rows.pop();
            this._previewSizeGroup.remove_widget(preview);
            this._group.remove(row);
        }
        while (this._rows.length < count)
            this._rows.push(this._createRow(this._rows.length));

        const css = [];
        this._rows.forEach(({row, preview, clearButton, warning}, index) => {
            const rgba = parseColor(colors[index]);
            const hex = rgba ? toHex(rgba) : null;
            const lowContrast = !!rgba && contrastWithWhite(rgba) < MIN_CONTRAST;

            if (rgba) {
                css.push(`.peacock-preview-${index} { background-color: ${hex}; color: white; }`);
                preview.remove_css_class('theme');
            } else {
                preview.add_css_class('theme');
            }
            clearButton.visible = !!rgba;
            warning.visible = lowContrast;

            row.title = hex ?? 'Theme color';
            row.subtitle = lowContrast ? 'Too light for the white text' : '';
        });
        this._colorProvider.load_from_string(css.join('\n'));

        const dynamic = this._isDynamic();
        this._group.description = 'The top bar takes the color of the workspace you are on. ' +
            (dynamic
                ? 'Workspaces are added automatically: each color goes to the workspace in that position.'
                : 'Dark colors keep its white text readable.');
        this._resetRow.subtitle = dynamic
            ? 'Back to the six prepared colors'
            : 'The number of workspaces stays the same';
        this._addButton.tooltip_text = dynamic ? 'Add a color' : 'Add a workspace';
        this._removeButton.tooltip_text = dynamic ? 'Remove the last color' : 'Remove the last workspace';
        this._addButton.sensitive = count < MAX_WORKSPACES;
        this._removeButton.sensitive = count > 1;
    }

    _createRow(index) {
        const preview = new Gtk.Label({
            label: `${index + 1}`,
            valign: Gtk.Align.CENTER,
            css_classes: ['peacock-preview', 'peacock-column', `peacock-preview-${index}`],
        });
        this._previewSizeGroup.add_widget(preview);
        const warning = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            tooltip_text: 'The white text of the top bar may be hard to read on this color',
            css_classes: ['warning'],
        });
        const chooseButton = new Gtk.Button({
            icon_name: 'color-select-symbolic',
            tooltip_text: 'Choose a color',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Use the theme color',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });

        const row = new Adw.ActionRow({activatable_widget: chooseButton});
        // add_prefix() puts each widget before the previous ones: the drag
        // handle, added last, ends up leftmost.
        row.add_prefix(preview);
        row.add_prefix(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            tooltip_text: 'Drag to reorder',
            css_classes: ['peacock-handle'],
        }));
        row.add_suffix(warning);
        // The choose button goes last so it lines up in every row, whether or
        // not the clear button is shown.
        row.add_suffix(clearButton);
        row.add_suffix(chooseButton);

        chooseButton.connect('clicked', () => this._chooseColor(index));
        clearButton.connect('clicked', () => this._setColor(index, THEME_COLOR));
        this._setupDragAndDrop(row, index);

        this._group.add(row);
        return {row, preview, clearButton, warning};
    }

    // The whole row can be dragged: a plain click still activates it, since a
    // drag only starts once the pointer moves. The payload is the row index.
    _setupDragAndDrop(row, index) {
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        let hotX = 0, hotY = 0;
        dragSource.connect('prepare', (source, x, y) => {
            [hotX, hotY] = [x, y];
            const value = new GObject.Value();
            value.init(GObject.TYPE_INT);
            value.set_int(index);
            return Gdk.ContentProvider.new_for_value(value);
        });
        dragSource.connect('drag-begin', source => {
            source.set_icon(new Gtk.WidgetPaintable({widget: row}), hotX, hotY);
        });
        row.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_INT, Gdk.DragAction.MOVE);
        dropTarget.connect('enter', () => {
            row.add_css_class('peacock-drop-target');
            return Gdk.DragAction.MOVE;
        });
        dropTarget.connect('leave', () => row.remove_css_class('peacock-drop-target'));
        dropTarget.connect('drop', (target, from) => {
            row.remove_css_class('peacock-drop-target');
            this._moveColor(from, index);
            return true;
        });
        row.add_controller(dropTarget);
    }

    // Moves a color to another position; the ones in between shift by one.
    _moveColor(from, to) {
        if (from === to)
            return;
        const colors = this._getColors(Math.max(from, to) + 1);
        colors.splice(to, 0, ...colors.splice(from, 1));
        this._settings.set_strv(KEY, colors);
    }

    _chooseColor(index) {
        const initial = parseColor(this._settings.get_strv(KEY)[index]) ??
            parseColor(this._getDefaultColor(index));
        const dialog = new Gtk.ColorDialog({
            title: `Workspace ${index + 1}`,
            with_alpha: false,
        });
        dialog.choose_rgba(this._window, initial, null, (source, result) => {
            let rgba;
            try {
                rgba = dialog.choose_rgba_finish(result);
            } catch (e) {
                // Closing the dialog is not an error; anything else is.
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
                    !e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                    console.error(e);
                return;
            }
            this._setColor(index, toHex(rgba));
        });
    }

    _setColor(index, value) {
        const colors = this._getColors(index + 1);
        colors[index] = value;
        this._settings.set_strv(KEY, colors);
    }

    // The color list, padded with the theme's color up to length: workspaces
    // added outside this window may have no entry yet.
    _getColors(length) {
        const colors = this._settings.get_strv(KEY);
        while (colors.length < length)
            colors.push(THEME_COLOR);
        return colors;
    }
}
