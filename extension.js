// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import {KEY, normalizeColor} from './common.js';

// An unlikely color written before the real one: if St hands it back, it
// threw the real one away. Picking exactly this color gives the theme's.
const SENTINEL = {red: 1, green: 2, blue: 3};

// Bar colors are dark so that the white text stays readable, which would make
// them nearly invisible as dots, on the bar (where inactive dots are also drawn
// at half opacity) or floating over the windows in the switcher popup. Dots get
// a light, saturated shade of the same hue instead.
const DOT_LIGHTNESS = 0.6;
const DOT_MIN_SATURATION = 0.7;
// Below this saturation a color counts as a gray and stays gray.
const GRAY_SATURATION = 0.1;

// GNOME 45 only has ClutterContainer's actor-added; child-added replaced it
// in 46.
function childAddedSignal(actor) {
    return GObject.signal_lookup('child-added', actor) ? 'child-added' : 'actor-added';
}

// Returns the shade as "r, g, b", for both rgb() and rgba().
function dotShade({red, green, blue}) {
    const [r, g, b] = [red, green, blue].map(v => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    // RGB -> HSL, with the hue in sixths of a turn.
    let hue = 0;
    let saturation = 0;
    if (delta > 0) {
        if (max === r)
            hue = ((g - b) / delta + 6) % 6;
        else if (max === g)
            hue = (b - r) / delta + 2;
        else
            hue = (r - g) / delta + 4;
        saturation = delta / (1 - Math.abs(max + min - 1));
    }
    if (saturation >= GRAY_SATURATION)
        saturation = Math.max(saturation, DOT_MIN_SATURATION);

    // HSL -> RGB at the dot lightness.
    const a = saturation * Math.min(DOT_LIGHTNESS, 1 - DOT_LIGHTNESS);
    const channel = n => {
        const k = (n + hue * 2) % 12;
        return Math.round(255 * (DOT_LIGHTNESS - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `${channel(0)}, ${channel(8)}, ${channel(4)}`;
}

export default class WorkspacePeacockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._originalStyle = Main.panel.get_style();
        // The workspace dots inside the Activities button. Not public API: if
        // the shell lays them out differently, only the bar gets colored.
        this._indicators = Main.panel.statusArea.activities?.get_first_child() ?? null;
        // The workspace thumbnails of the overview, also not public API. The
        // shell creates them when the overview opens and destroys them when
        // it closes, so they are colored as they are added.
        this._thumbnailsBox = Main.overview._overview?._controls?._thumbnailsBox ?? null;

        this._loadColors();
        this._settings.connectObject(
            `changed::${KEY}`, () => this._loadColors(),
            this);
        // workspace-switched covers the normal case; the other two fire when
        // the active workspace keeps its place but changes index (dynamic
        // workspaces, or another extension reordering them).
        global.workspace_manager.connectObject(
            'workspace-switched', () => this._applyColor(),
            'workspace-removed', () => this._applyColor(),
            'workspaces-reordered', () => this._applyColor(),
            this);
        // The overview uses the bar's inline style for its own transitions and
        // clears it when done (Main.panel.style = null in ui/overview.js, in
        // every version from 45 to 50), wiping the color: put it back. Only an
        // empty style is refilled, so this never loops.
        Main.panel.connectObject('notify::style', () => {
            if (Main.panel.get_style() === null && this._activeColor())
                this._applyColor();
        }, this);
        // A new workspace gets a new, uncolored dot.
        this._indicators?.connectObject(
            childAddedSignal(this._indicators), () => this._applyColor(),
            // Another extension may rebuild the Activities button.
            'destroy', () => (this._indicators = null),
            this);
        this._thumbnailsBox?.connectObject(
            childAddedSignal(this._thumbnailsBox), () => this._applyColor(),
            'destroy', () => (this._thumbnailsBox = null),
            this);

        // The popup shown when switching workspace from the keyboard rebuilds
        // its dots every time, so they are colored right after. GNOME 49
        // draws them per monitor in MonitorWorkspaceSwitcherPopup.redisplay(),
        // 45-48 in WorkspaceSwitcherPopup._redisplay(); both put them in _list.
        const [popupPrototype, redisplay] = SwitcherPopup.MonitorWorkspaceSwitcherPopup
            ? [SwitcherPopup.MonitorWorkspaceSwitcherPopup.prototype, 'redisplay']
            : [SwitcherPopup.WorkspaceSwitcherPopup.prototype, '_redisplay'];
        const extension = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(popupPrototype, redisplay, original => function (...args) {
            original.apply(this, args);
            if (this._list)
                extension._colorSwitcherDots(this._list);
        });
    }

    disable() {
        // A popup still on screen keeps its colors for the half second it
        // has left.
        this._injections.clear();
        this._settings.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._indicators?.disconnectObject(this);
        this._thumbnailsBox?.disconnectObject(this);
        Main.panel.disconnectObject(this);
        Main.panel.set_style(this._originalStyle);
        // The shell itself never sets an inline style on dots or thumbnails.
        this._getDots().forEach(dot => dot.set_style(null));
        this._getThumbnails().forEach(thumbnail => thumbnail.set_style(null));

        this._injections = null;
        this._settings = null;
        this._originalStyle = null;
        this._indicators = null;
        this._thumbnailsBox = null;
        this._colors = null;
    }

    _getDots() {
        return (this._indicators?.get_children() ?? [])
            .filter(child => !child.destroying)
            .map(child => child.get_first_child())
            .filter(dot => dot?.has_style_class_name('workspace-dot'));
    }

    _getThumbnails() {
        return (this._thumbnailsBox?.get_children() ?? [])
            .filter(child => child.metaWorkspace &&
                child.has_style_class_name('workspace-thumbnail'));
    }

    // Parses the list once per change of the setting, then repaints. St has the
    // last word on color names: a value it rejects, such as a typo, keeps the
    // theme's color on the bar and on its dot alike.
    _loadColors() {
        this._colors = this._settings.get_strv(KEY).map(value => {
            const css = normalizeColor(value);
            if (!css)
                return null;

            const {red, green, blue} = SENTINEL;
            Main.panel.set_style(
                `background-color: rgb(${red}, ${green}, ${blue}); background-color: ${css};`);
            const parsed = Main.panel.get_theme_node().get_background_color();
            if (parsed.red === red && parsed.green === green && parsed.blue === blue)
                return null;
            return {css, shade: dotShade(parsed)};
        });
        // Parsing left the bar in the last tested color.
        this._applyColor();
    }

    _activeColor() {
        return this._colors[global.workspace_manager.get_active_workspace_index()];
    }

    _applyColor() {
        const active = global.workspace_manager.get_active_workspace_index();
        const color = this._activeColor();

        if (color)
            Main.panel.set_style(`background-color: ${color.css};`);
        else
            Main.panel.set_style(this._originalStyle);

        // The active dot keeps the theme's white: in the bar's own color it
        // would disappear.
        this._getDots().forEach((dot, index) => {
            const dotColor = index === active ? null : this._colors[index];
            dot.set_style(dotColor ? `background-color: rgb(${dotColor.shade});` : null);
        });

        // Each thumbnail knows its workspace, so the order of the children
        // does not matter.
        this._getThumbnails().forEach(thumbnail => {
            const thumbnailColor = this._colors[thumbnail.metaWorkspace.index()];
            thumbnail.set_style(thumbnailColor ? `background-color: ${thumbnailColor.css};` : null);
        });
    }

    // In the switcher popup the destination dot is colored too: it is the
    // color you are about to land on. The others keep the theme's half
    // transparency.
    _colorSwitcherDots(list) {
        list.get_children().forEach((dot, index) => {
            const color = this._colors[index];
            if (!color)
                return;
            dot.set_style(dot.has_style_pseudo_class('active')
                ? `background-color: rgb(${color.shade});`
                : `background-color: rgba(${color.shade}, 0.5);`);
        });
    }
}
