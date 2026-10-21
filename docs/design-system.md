# Design system

Nimble Newt shares its look with [Vigilant Vole](https://github.com/Ferdinand99/Vigilant-Vole) (MIT, same owner): an Apple-inspired, quiet interface where colour is used sparingly and the content is the star. This page lists what was taken over, what was added for an editor and the rules to keep it consistent.

## Where things live

| File | Purpose |
|---|---|
| `src/styles/_tokens.css` | The Vigilant Vole token block, copied verbatim: surfaces, text, brand, status and palette colours (`light-dark()`), type, spacing, radii, shadows, motion, layers. |
| `src/styles/style.css` | Base styles, the components an editor needs (buttons, inputs, switch, segmented control, inset lists, sheets, menus, toasts, progress) and the editor-specific parts below. |
| `public/icons.svg` | Icon sprite: the Vigilant Vole line icons we use (24 px grid, 1.5 px stroke, round caps, `currentColor`) plus a few editor icons (file, folder, replace, case, word, regex, …). |
| `public/fonts/` | Inter variable font and its licence (SIL OFL). Everything is bundled; there are no CDNs. |
| `assets/app-icon.svg` | App icon source; `npx tauri icon assets/app-icon.svg` regenerates the platform icons. |

## Principles

1. **Tokens only.** Components never contain their own colours, sizes or durations: they read `var(--…)`. Dark and light come from `light-dark()`; `color-scheme` follows the system and `html[data-theme="light|dark"]` forces one (Settings → Theme).
2. **One accent.** `--brand` (indigo) is used for focus, selection, links and the active state of toggles. Status colours (`--ok`, `--warn`, `--bad`, `--info`) are reserved for meaning.
3. **Syntax colours come from the palette.** `--syn-*` tokens (keyword, string, number, comment, function, type, tag, property, operator, meta) are defined next to the other tokens with a light and a dark value that each meet WCAG AA contrast against the editor background. `src/editor/theme.ts` maps Lezer tags to them, so highlighting follows the theme and the contrast preferences automatically.
4. **Motion is feedback, not decoration.** Press (120 ms), UI (200 ms) and sheet (340 ms) durations, `--ease-out` / `--ease-drawer` curves. `prefers-reduced-motion` removes movement and keeps cross-fades.
5. **Respect the system.** `prefers-reduced-transparency` swaps translucent chrome for solid surfaces, `prefers-contrast: more` strengthens lines and text, `forced-colors` gets outlines instead of fills.
6. **Keyboard first.** Every control is a real button/input with a visible `:focus-visible` ring; menus, the palette and tab lists support arrow keys, Enter and Escape.

## Components

Taken from Vigilant Vole and trimmed: `.btn` (+ `-primary`, `-plain`, `-danger`, `-sm`, `-icon`), `.input`, `.switch`, `.segmented`, `.inset-list` / `.list-row`, `.sheet` (modal dialog, also the alert variant), `.menu`, `.toast`, `.progress`, `kbd`.

Added for the editor:

| Component | Class | Notes |
|---|---|---|
| Tab bar | `.tabbar`, `.tab` | Translucent bar (`--bar` + blur). The active tab is a raised pill. A dot replaces the close button on modified tabs until hover. Tabs reorder with pointer-based dragging. On macOS the bar leaves `--traffic-inset` for the overlay title bar's traffic lights and doubles as the drag region. |
| Status bar | `.statusbar`, `.status-item` | Every item is a button: position → go to line, indentation, language, encoding and line endings → menus/pickers. The update pill (`.status-update`) appears when a new version exists. |
| Find bar | `.find` | Mounted by CodeMirror's panel API; toggles for case, whole word and regex use `aria-pressed`. |
| Find in files | `.fif` | Bottom panel with grouped results, replace preview and per-file checkboxes. |
| Command palette | `.palette` | Fuzzy-filtered quick-pick, reused for quick open and all pickers. |
| Editor surface | `.cm-*` overrides | Gutter, active line, selection, bracket matching, search matches and whitespace markers, all token-driven. |

## Adding UI

- Build DOM with `h()` / `icon()` from `src/lib/dom.ts`; never interpolate user text into `innerHTML`.
- Put every visible string in `src/locales/en.json` and use `t("key")`. `npm test` fails if a key is missing from English or Norwegian.
- Use an existing component class before writing CSS; if you need a new colour, add a token to `_tokens.css` with both a light and a dark value.
