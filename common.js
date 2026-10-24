// SPDX-License-Identifier: GPL-2.0-or-later

// Shared by the extension (St) and the settings window (GTK), which must agree
// on what counts as a color: neither looks at a value that fails here.

export const KEY = 'workspace-colors';

// Marks a workspace that keeps the theme's color, like an empty entry does.
export const THEME_COLOR = 'default';

// Only a bare color value may reach an inline style: anything else, such as
// "red; border: 9px solid", would inject extra CSS declarations into the bar.
// No alpha on purpose: a see-through bar can make its white text unreadable.
const COLOR_PATTERN = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-z]+)$/i;

// Words the pattern lets through that are not an opaque color.
const NOT_COLORS = [THEME_COLOR, 'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none'];

// Returns the trimmed value if it may be a color, null otherwise. Whether a
// name such as "darkslategray" really is one is left to St or GTK.
export function normalizeColor(value) {
    const color = value.trim();
    if (!COLOR_PATTERN.test(color) || NOT_COLORS.includes(color.toLowerCase()))
        return null;
    return color;
}
