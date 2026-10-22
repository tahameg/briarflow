# Spec: Design system ("Briar Woodshop")

Status: v2 (2026-10-22). Replaces v1 "Briar Brutal" (square, thick cream borders, hard offset
shadows, yellow). Owner: ux-designer. Used by `apps/studio` and `@briarflow/editor-react`.
Tokens ship as CSS (`@briarflow/editor-react/theme.css`, `styles/tokens.css`) and partly as a TS
object (`briarTheme`, `BRIAR_TOKENS`) with the same names. Reference canvas with the node, state
and parts boards: https://claude.ai/artifact/BziNuowaHk2gUFYHLBPriD.

The name comes from briar, the burl wood tobacco pipes are carved from. Principles: **made by
hand, lit from inside.**
- **Wood frames, matte plates.** Things you build with (nodes, menus, dialogs, the top bar) sit
  in a wooden frame. Working surfaces (panels, node faces) are a dark matte plate. The frame
  says what kind of thing it is; the plate holds the content.
- **Radio lights.** State is shown the way an '80s / '90s radio shows it: 3 mm LEDs in black
  bezels, a pilot lamp, a VU strip, a backlit dial window. A light that is on means something
  is connected or happening.
- **Brass for "you / now / primary".** Brass replaces v1 yellow: primary buttons, selection,
  focus, the active tab.
- **Engraved, not printed.** Titles and labels look cut into the plate: condensed uppercase
  with wide letter-spacing.
- Gradients, soft shadows and glows are allowed, but only to imitate a material (wood grain,
  brass, a lit LED, a recessed slot). No decorative gradient washes.

## 1. Color tokens

```css
:root {
  /* base: warm dark workshop */
  --bf-bg:            #1D1914;   /* app background (body uses a radial bench gradient over it) */
  --bf-surface:       #2D2A25;   /* plate base, panels */
  --bf-surface-2:     #36322B;   /* hovered rows */
  --bf-surface-3:     #443E35;   /* pressed */
  --bf-ink:           #EADFCA;   /* primary text (cream) */
  --bf-ink-muted:     #A99C86;   /* secondary text */
  --bf-ink-disabled:  #6F6656;   /* disabled text (exempt from AA) */
  --bf-ink-inverse:   #24170A;   /* text on brass and pastels */
  --bf-shadow:        #000000;
  --bf-line:          #100D0A;   /* 1 px grooves: panel borders, dividers, title bars */

  /* brass (was "yellow" in v1; the token names stay) */
  --bf-yellow:        #F2B84B;   /* accent text, selection, links */
  --bf-yellow-press:  #D99A2B;
  --bf-brass:         #C49A4E;   /* hover rings */
  --bf-brass-hi:      #FFCF6E;   /* focus, selection outline, active tab, drag line */
  --bf-brass-face:    linear-gradient(180deg, #F6DC95, #D4A24C 55%, #A97627);  /* buttons, nameplate */

  /* materials */
  --bf-plate:         linear-gradient(150deg, #38342E 0%, #2D2A25 35%, #24211D 100%);
  --bf-plate-shadow:  0 0 0 1px rgba(208,152,91,.18), inset 0 1px 2px rgba(255,255,255,.08), 0 8px 20px rgba(0,0,0,.4);
  --bf-plate-ink:     #EADFCA;   --bf-plate-muted: #A99C86;   --bf-plate-value: #F3C776;
  --bf-slot:          #15120F;   /* recessed input */
  --bf-slot-shadow:   inset 0 2px 3px rgba(0,0,0,.7), 0 1px 0 rgba(255,255,255,.06);
  /* --bf-wood-briar (reddish burl, flame grain) and --bf-wood-walnut (dark, straight grain):
     layered gradients, see tokens.css */
  --bf-bench:         #262019;   /* canvas */
  --bf-bench-grid-minor: rgba(180,161,132,.07);
  --bf-bench-grid-major: rgba(180,161,132,.13);

  /* LEDs (port families, §6) and cable cores (§8) */
  --bf-led-text: #FFAE2B;  --bf-led-num: #6FE04F;  --bf-led-bool: #F2E04A;
  --bf-led-media: #FF4B3A; --bf-led-data: #FFE9C8; --bf-led-any: #CFC3AD;
  --bf-wire-text: #E39A2F; --bf-wire-num: #5FC243; --bf-wire-bool: #D6C63E;
  --bf-wire-media: #E0473A; --bf-wire-data: #E6D3B0; --bf-wire-any: #A99C86;

  /* pastels: badge text tones, type chips in panels, menu accent dots */
  --bf-mint: #A8E6CF; --bf-lavender: #C3B1E1; --bf-peach: #FFC8A2; --bf-sky: #A0D2EB; --bf-pink: #FFB3C6;
  --bf-lime: #D4F0A0; --bf-aqua: #9EE6E0; --bf-sand: #E8D8B0; --bf-coral: #FF9E9E; --bf-stone: #B8B8B8;

  /* status */
  --bf-danger:        #FF8A72;
  --bf-status-running: var(--bf-sky);  --bf-status-done: var(--bf-mint);  --bf-status-cached: var(--bf-lavender);
  --bf-status-error: var(--bf-danger); --bf-status-skipped: var(--bf-stone); --bf-status-warning: var(--bf-peach);
  --bf-status-queued: var(--bf-ink-muted);
}
```

The wood gradients are written out in `tokens.css`. Briar is the frame for **working nodes**,
**menus** and **dialogs**. Walnut is the frame for the **flow Input/Output nodes** and the
**top bar**. Maple (light, node CSS only) is the frame for **variable GET/SET nodes**.

Only a dark theme (Q-DS-1).

## 2. Contrast (WCAG 2.1 AA)

AA needs ≥ 4.5:1 for normal text and ≥ 3:1 for large text and UI boundaries.

| Foreground | Background | Ratio | Use | AA |
|---|---|---|---|---|
| ink `#EADFCA` | bg `#1D1914` | 13.24 | body text | ✓ |
| ink | surface `#2D2A25` | 10.82 | panel / plate text | ✓ |
| ink | surface-2 `#36322B` | 9.65 | hovered rows | ✓ |
| ink | slot `#15120F` | 14.14 | input text | ✓ |
| ink | walnut `#4A2F1D` (lightest band) | 9.27 | top bar text | ✓ |
| ink-muted `#A99C86` | surface | 5.30 | secondary text, node type line | ✓ |
| ink-muted | surface-2 | 4.72 | | ✓ |
| ink-muted | slot | 6.92 | | ✓ |
| placeholder `#8F826D` | slot | 4.96 | placeholders | ✓ |
| plate-value `#F3C776` | slot | 11.77 | values in node slots | ✓ |
| brass `#F2B84B` / brass-hi `#FFCF6E` | surface | 7.98 / 9.80 | accent text, active tab | ✓ |
| ink-inverse `#2A1A06` | brass face (mid `#D4A24C` / top `#F6DC95`) | 7.26 / 12.48 | primary button, nameplate | ✓ |
| dial text `#2A1A08` | dial window `#E9BD6C`–`#F6DFA6` | 9.57–12.82 | node preview | ✓ |
| danger `#FF8A72` | surface | 6.21 | error text | ✓ |
| failure tag `#FFB3A6` | tag `#2A1513` | 10.08 | node run error | ✓ |
| badge tones (mint / peach / danger) | badge `#1A1613` | 12.74 / 11.31 / 8.96 | engraved badges | ✓ |
| filled danger `#FFE3DD` | `#9C3023` (gradient mid) | 6.04 | confirm delete | ✓ |
| LED colors (text / num / bool / data / any) | surface | 7.72 / 8.47 / 10.57 / 12.07 / 8.21 | non-text indicators | ✓ (3:1) |
| LED media `#FF4B3A` | surface | 4.30 | non-text indicator | ✓ (3:1) |
| ink-disabled `#6F6656` | surface | 2.53 | disabled only | exempt |

Rules:
- Text on brass, pastels or the dial window is always dark (`--bf-ink-inverse`).
- Do not put ink-muted on surface-3: it falls below 4.5.
- LED color is never the only cue. The row label, the tooltip and the inspector name the type.
  Lists also get a different LED shape (bar).

## 3. Typography

```css
:root {
  --bf-font-display:  "Barlow Condensed", "Arial Narrow", system-ui, sans-serif;  /* titles, tabs, buttons */
  --bf-font-engraved: "Barlow Condensed", "Arial Narrow", system-ui, sans-serif;  /* node titles, badges, captions */
  --bf-font-body:     "Barlow", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bf-font-plate:    "Barlow", system-ui, sans-serif;                            /* text on nodes and menus */
  --bf-font-code:     "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
}
```
The studio self-hosts the fonts with `@fontsource` (Barlow 400/500, Barlow Condensed 500/600,
JetBrains Mono). An app embedding `editor-react` loads them itself; the stacks fall back cleanly.

| Role | Font | Size / weight | Case |
|---|---|---|---|
| Nameplate (BRIARFLOW) | engraved | 16 / 600, letter-spacing .22em | UPPERCASE |
| Panel titles, tabs | engraved | 15–16 / 600, letter-spacing .12em | UPPERCASE |
| Buttons | engraved | 13–14 / 600, letter-spacing .1em | UPPERCASE |
| Node title | engraved | 17 / 600, letter-spacing .05em | UPPERCASE |
| Node captions ("Run failed"), badges | engraved | 10.5–12 / 600, letter-spacing .08–.16em | UPPERCASE |
| Port labels, menu items | plate / body | 13.5–14 / 400 | as typed |
| Types, ids, values, event log | code | 11–12 / 400 | as typed |
| Body, forms | body | 14 / 400 | sentence case |

The minimum size anywhere is 10.5 px, used only for engraved captions and node type lines.

## 4. Spacing, borders, shadows, radius, motion

```css
:root {
  --bf-space-1: 4px; --bf-space-2: 8px; --bf-space-3: 12px; --bf-space-4: 16px; /* unchanged scale */
  --bf-border-thin: 1px; --bf-border: 1px; --bf-border-thick: 1px; --bf-border-heavy: 2px;
  --bf-shadow-sm: 0 1px 2px rgba(0,0,0,.55);
  --bf-shadow-md: 0 4px 10px rgba(0,0,0,.45);
  --bf-shadow-lg: 0 10px 24px rgba(0,0,0,.55);
  --bf-shadow-yellow: 0 0 0 1px var(--bf-brass-hi), 0 0 14px rgba(255,184,74,.35);
  --bf-radius: 6px;      /* panels, docks, canvas */
  --bf-radius-sm: 4px;   /* buttons, toggles */
}
```

- **Radii by layer** (kept small; large radii made dense chrome look soft and broke title bars and tabs):
  - node frame 12 px, node plate 4 px
  - dialog / modal / splash frame 10 px
  - menu frame 9 px
  - panel 6 px
  - button 4 px
  - slot, badge, tab 3 px
- **Borders** are 1 px `--bf-line` grooves with a 1 px light line beneath (`0 1px rgba(255,255,255,.05)`).
  Do not use cream borders.
- **Press:** buttons move down 1 px and their shadow turns inset. With `prefers-reduced-motion`,
  LED pulse/blink and cable sparks stop.
- **Focus:** `outline: 1px solid var(--bf-brass-hi)` on fields, `3px` on canvas items
  (`:focus-visible`). Never remove focus outlines.

## 5. Canvas (the bench)

- **Background:** warm radial gradient (`#3D3227` → `--bf-bench` → `#1A1612`) with two React
  Flow `Background` line layers.
  - Minor lines every 24 px (`--bf-bench-grid-minor`), major every 120 px (`--bf-bench-grid-major`).
  - Nodes snap to 12 px.
- **Framing:** the canvas is a 6 px-radius plate with the plate shadow.
- **Controls and minimap:** small plates with dark kicked buttons.

## 6. Ports: brass sockets and LEDs

Every port row has two parts:

- A **brass socket** (18 px) set into the wooden rim.
  - Its center sits 6 px in from the node's outer edge: inputs on the left rim, outputs on the right.
  - Empty, it shows a dark hole. With a cable plugged in (`links > 0`), the hole shows the
    cable's core color.
  - Hover / compatible drop target: a brass ring with a glow. An incompatible target gets a red ring.
- A **3 mm LED** in a black bezel, between the socket and the label.
  - Input row: `socket · LED · label · value`.
  - Output row: `type · label · LED · socket`.

LED color is the **type family** (`ledFamily(type)`; `list<X>` and `X?` take X's family):

| Family | Types | LED | Cable core |
|---|---|---|---|
| text | text | amber `--bf-led-text` | `--bf-wire-text` |
| num | int, float | green | |
| bool | boolean | yellow | |
| media | image, audio, video, model3d | magenta | |
| error | error (a failed node's reason) | red | `--bf-wire-error` |
| data | struct, enum, json, file | frosted white | |
| any | unbound `$T` | warm grey | |

LED **shape**: a 10 px dot for a single value, a 16×6 bar for a list (`isListType`).

LED **state** (`inputLed` / `outputLed` in `nodeParts.tsx`):

| State | Meaning | Look |
|---|---|---|
| off | nothing wired, no value | tinted dark dome |
| dim | an input with a typed-in constant | color at ~60 % brightness, no glow |
| on | a cable is plugged in (input wired, output used) | bright dome, 6 + 14 px glow |
| pulse | data flowing: wired input of a running node | `on`, brightness pulses at 1.1 s |

Type shapes in panels and pickers (type chips, `.bf-port` markers) keep the v1 pastel map:

| Type | Pastel | Shape |
|---|---|---|
| text / int / float / boolean | mint / sky / aqua / lime | square |
| image / video / audio / model3d / file | peach / coral / pink / sand / stone | square |
| struct / enum | lavender | square / diamond |

Lists get a hollow marker, optionals a dashed outline. `briarTheme.typeStyle` implements this
map. Ports on the canvas use the LED families instead.

## 7. Node anatomy

```
  ╭──────────────────────────────────────────────╮  briar frame, 10 px, 12 px radius
  │ ╭──────────────────────────────────────────╮ │  matte plate, 4 px radius
  │ │ (◎) TEXT TEMPLATE            [1MS]  (●)  │ │  medal · engraved title · badge · pilot lamp
  │ │     text.template                        │ │  type line (code 10.5, muted)
  │ │ ▮▮▮▮▮▮▮▯▯▯▯▯                             │ │  VU strip (only while running with progress)
  │ ├──────────────────────────────────────────┤ │
  ◉─┼─● count          ← Input.count           │ │  socket on rim · LED · label · source
  ◉─┼─◐ template      [ Write {topic}… ]      │ │  unconnected: recessed slot
  │ │                         text  Text  ●───┼─◉  outputs right-aligned
  │ │ ┌──────────────────────────────────────┐ │ │
  │ │ │ Write {count} lines about {topic}.   │ │ │  dial window: backlit cream glass
  │ │ └──────────────────────────────────────┘ │ │
  │ │ ┌ RUN FAILED ──────────────────────────┐ │ │  failure tag (only when the run failed)
  │ │ │ photo.heic could not be decoded…     │ │ │
  │ │ ✕                                    ✕ │ │  two slotted screws, bottom corners
  │ ╰──────────────────────────────────────────╯ │
  ╰──────────────────────────────────────────────╯
```

- **Frontend nodes** (definition `frontend: true`, e.g. Print) run in the studio, not on the
  server, and look different:
  - an ebonized, near-black frame with a faint cyan rim
  - a small "STUDIO" display badge in the header (cyan VFD text in a dark glass window,
    `--bf-vfd #6FF3D6`)
  - an add-menu hint "· studio" and a cyan accent dot
  - Cyan means "this happens on your screen". It is reserved for frontend nodes and the Console.
- **Size:** width 260–380 px (variables min 200). Rows are 34 px. The header is at least 52 px.
- **Frame by kind:** briar for working nodes, walnut for `briar.input` / `briar.output`, maple for
  variable GET/SET. Built-in nodes cannot be deleted (no delete action is shown).
- **Medal:** a 24 px brass disc with a category icon (`medalIcon`): text, ai, image, list, data,
  convert, variable, input, output. Unknown categories get a plain dot.
- **Pilot lamp** (12 px) shows the run state (§9).
- **Badges** are engraved chips in a dark recess with pastel text: duration, `CACHED`,
  `FAILED`, `SKIPPED`, `n warn`, `n errors`.
- **Dial window** holds the config preview (template text, up to ~4 lines) in dark code type on
  warm cream glass.
- **Failure tag** sits under the dial with a red border, a "RUN FAILED" caption and the error
  message (`role="alert"`).
- **Input/Output signature rows:** `× name [type ▾] [ ]`, plus an LED and socket. The type chip
  is a dark recess. "+ INPUT" / "+ OUTPUT" is a dashed engraved button.

### Constant value widgets (unconnected inputs)

| Type | Widget |
|---|---|
| text | single-line input; `multiline` → 3-row textarea that grows to 8 rows; `widget:"password"` masks |
| int | number input with − / + steppers (step 1), clamps to min/max on blur |
| float | number input (step 0.1), `widget:"slider"` when both min and max are set |
| boolean | LED checkbox 14 px: dark amber dome when off, lit amber with glow when checked |
| enum | select showing labels |
| media | **v1:** a chip (thumbnail for image, icon + name for others, mime + size, × to clear) plus a secondary `CHOOSE FILE` button; the chip/button area is also a drop target (brass dashed 1 px border while dragging a file over it). *Later:* 64 px drop zone "Drop file or click". |
| struct | **v1:** on the node a read-only preview `{…}` / `{ name, style }`; in the inspector and run form a JSON textarea (code font) **prefilled with a skeleton** built from the struct's fields (defaults, else `""` / `0` / `false` / `null` / `[]`), pretty-printed on blur, parse errors shown below in danger with line:col. *Later:* button `Edit Character…` opening a form popover. |
| list | **v1:** preview `3 items` / `empty` on the node; JSON textarea (prefilled `[]`) in inspector and run form, same error rules as struct. *Later:* list editor popover (add / remove / reorder). |
| optional | small "set" checkbox before the inner widget; unchecked = `null` (muted "none") |
| `$T` unbound | muted text "connect first" (setValue would be rejected) |

Connected input: the widget is hidden and replaced by `← <source node>.<port>`; a stored
constant is kept and shown as a ghost value in the inspector ("used when disconnected").

## 8. Edges: cables

Cables are bezier curves (React Flow `getBezierPath`) built from layers:
- a dark cloth **sheath**: 6 px `#1D140D`, with a drop shadow
- a 2.5 px **core** in the source port's family color (`--bf-wire-*`)
- a spark layer while running

| State | Style |
|---|---|
| default | sheath + core |
| hover | sheath lightens to `#3A2A1C` |
| selected | sheath turns brass (`--bf-brass-hi`, 7 px) |
| invalid (`edge.type_mismatch`) | core `--bf-led-media`, dashed `6 5`; a red LED-like "!" marker at the midpoint with the message on hover |
| running (target node running) | cream sparks (`#FFF3C9`, dash `3 11`) run along the core, 14 px / 700 ms |
| drag preview | 2.5 px brass dashed line; red over an incompatible port |
| released on empty canvas | opens the "connect" menu: only nodes with a port that fits the dragged type (exact matches by category, generic ports under "Any type"); the pick is added at the drop point, wired |
| implicit variable order | not drawn in v1 (planned v1.1) |

### Execution lines (execution.md §6)

- **Execution sockets** are ivory arrow plates on the rim of the **header row**: `in` on the left,
  `then` on the right. A plugged-in socket shows a bright core.
- **Nodes that can fail** have an "On fail" band under the title, tinted red. It holds the red
  `failed` socket and the red `error` data output (LED and socket).
- **Execution lines** are heavy cream cables (`--bf-wire-exec`, 3.5 px core on an 8 px sheath).
  - A line goes brass with a glow where the current run went.
  - A line leaving `failed` has a red core.
- **Pure nodes** have no execution sockets.
- **Nodes off the line** (they never run) are dimmed to 55 % and desaturated, with a tooltip
  saying why.

## 9. States

| State | Node | Control |
|---|---|---|
| focus (keyboard) | 3 px brass outline | 1 px brass outline |
| selected | 2 px brass outline 1 px outside the frame, warm glow | — |
| error (validation) | thin red ring around the plate; `n errors` badge; messages in inspector and PROBLEMS | invalid slot: red ring |
| warning | `n warn` badge (peach text) | |
| queued (run) | pilot lamp amber, dim | |
| running | pilot lamp amber, **blinking** 0.9 s; VU strip under the header; wired input LEDs pulse; cables into it spark | |
| retrying | badge `retry 2` (peach) | |
| cached | pilot lamp green; badge `CACHED` | |
| done | pilot lamp green; badge with duration | |
| failed | pilot lamp red; badge `FAILED`; title in danger tone; failure tag with the message | |
| skipped | node at 50 % opacity, desaturated; badge `SKIPPED` | |
| disabled control | — | ink-disabled text, dashed 1 px border, no shadow |

The VU strip has 12 segments. They light from the left in proportion to progress: the first 9
green, the next 2 amber, the last red.

Status dots outside the canvas (run log, PROBLEMS) are 10 px circles in a black bezel.

## 10. Components (studio + editor-react)

- **Primary button:**
  - brass face, dark ink (`#2A1A06`), 1 px `#6A4A1C` border, light top bevel, faint glow
  - hover: lighter brass
- **Secondary button:**
  - dark kicked plate (`#4A443A` → `#36312A`), 1 px groove, top bevel, engraved label
- **Danger button:** dark red plate, salmon text. The filled danger button on confirm dialogs is
  a red gradient with pale text.
- **Ghost button** (borderless): only for inline row actions (`COPY`). Toolbar, top bar and
  footer actions stay secondary buttons, so their enabled and disabled looks differ by more than
  a border.
- **Disabled:** dashed 1 px `#4A4238` border, flat dark fill, no shadow.
- **Input:**
  - a recessed slot: `--bf-slot` with an inner shadow and no border
  - focus: 1 px brass outline
  - invalid: 1 px red ring
  - inline inputs stay transparent until hover or focus
- **Checkbox:** a 14 px amber LED (§7 boolean).
- **Toggle:** a recessed track; the "on" option is brass.
- **Panel / dock:** plate background, 6 px radius, plate shadow.
- **Panel header:** a 34 px raised strip (`#3B362F` → `#2F2B26`, light top bevel, groove
  underneath). From left to right:
  - collapse caret
  - a 6 px pilot LED: dark normally, lit amber while focus is inside the panel
  - engraved title (14 px, letter-spacing .16em, cream `#D8C7A8`, cut-in text shadow)
  - actions on the right
- **Tabs** are radio band selectors in the header strip:
  - 24 px high, 3 px radius, each with its own 6 px LED
  - inactive: muted text, LED off
  - active: pressed in (dark `#1D1A16` recess with an inner shadow), brass text, LED lit
  - no underlines and no separators
- **List selection:** a faint amber wash with a 2 px brass bar on the left.
- **Badge:** a dark recess with pastel tone text (`--bf-badge-bg` is used as the text color).
- **Dialog / modal / move menu / splash:**
  - a plate inside a briar frame (6–10 px wood border, `#C07A48` outer line)
  - dim warm backdrop
- **Context menu:**
  - a plate inside a 6 px briar frame
  - 32 px items
  - active item: amber wash and a 2 px amber bar
  - node and variable entries carry a small LED dot in their accent
  - search is a recessed slot
  - grooves as separators
- **Add rows** (`+ VARIABLE`, `+ INPUT`, …): a dashed 1 px rounded box with an engraved label,
  brass on hover. Disabled while the name field is empty; Enter triggers them.
- **Row delete (×):** hit target ≥ 24×24 px, danger tone on hover only.
- **Empty states:** one muted sentence that says what to do (`No runs yet — press RUN or
  Ctrl+Enter.`).
- **Icons:** inline stroke SVG, 1.6–1.7 px stroke, round caps.

## 11. Studio layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ [BRIARFLOW] [Demo ▾][+] / [Bench ▾][+] [TYPES] [GLOBALS]  rev 5 · saved [UNDO][REDO][⚠0][▶ RUN] │ walnut top bar, 48 px
├────────────┬──────────────────────────────────────────────────────────────┬──────────────────┤
│ CONTEXTS   │ ╭ bench canvas ──────────────────────────────────────────────╮ │ INSPECTOR        │
│ ▾ Demo     │ │   ╭INPUT╮        ╭TEXT TEMPLATE╮       ╭MOCK LLM╮          │ │ flow / selection │
│   Bench    │ │   │ topic ●◉═══◉● topic       │       │        │  ╭OUTPUT╮│ │ details          │
│ [+ FLOW]   │ │   ╰─────╯        ╰─────────────╯═════◉╰────────╯══◉       ││ │                  │
│────────────│ │                                                            │ │                  │
│ VARIABLES  │ ╰────────────────────────────────────────────────────────────╯ │                  │
│ ...        │ ╭ RUN │ PROBLEMS 0 ──────────────────────────────────────────╮ │                  │
│            │ │ inputs form · run status · event log                       │ │                  │
└────────────┴──────────────────────────────────────────────────────────────┴──────────────────┘
```

- **Context and flow switchers** in the top bar (`Switcher.tsx`), not a panel. Each one is a
  dropdown followed by a `+`.
  - `+` turns into a name field: Enter creates the item and opens it, Esc cancels.
  - Right-click the dropdown for New, Rename (inline), Duplicate (flows), Reload list
    (contexts) and Delete (with a confirmation).
  - With no contexts, the bar shows only a brass `+ Add context` button.
  - The server can choose what opens first: `BRIAR_STUDIO_CONTEXT` / `BRIAR_STUDIO_FLOW` (id or
    name, created when missing), served at `GET /api/studio`. That target beats the last-used
    context kept in localStorage.
- **Dockable panels** (`apps/studio/src/dock.tsx`): variables, inspector, run, console and problems, in left / right (stacked, collapsible) and bottom (tabs) zones.
  - Move a panel by dragging its title or tab, or from its right-click menu.
  - The layout is stored in localStorage and normalized when loaded.
  - The default puts variables on the left, inspector on the right, and run, console and
    problems at the bottom.
- **There is no node palette panel.** Right-click the empty canvas, or press `/`, for the add
  menu: every node by category, variable/global GET/SET, and a search box.
- **Console** (bottom tab, `ConsolePanel`): a cyan VFD screen showing what frontend nodes
  printed (time, node, text). Click a node name to select it. Clear empties it; it follows new
  lines while scrolled to the bottom.
- **Context menus everywhere:** canvas, node, port, edge, variable / global / signature /
  struct field / enum value / type rows, dock panels, and the context / flow switchers.
  - The browser menu is suppressed everywhere except text fields.
  - The menus are extensible: `ContextMenuTargets` declaration merging, `useContextMenuContributor`.
- **Globals and Types** open as briar-framed modals from the top bar.
- **Variables panel:** flow variables. The grip drags a GET node onto the canvas.
- **Inspector** (right): the selection (title, id, config, input constants, diagnostics). With
  nothing selected it shows the flow name, description and signature editor.
- **RUN:** an inputs form generated from the signature, RUN / CANCEL / CLEAR, run status,
  outputs, and an event log (code font, filter by node).
- **PROBLEMS:** diagnostics with errors first. Clicking a row selects and frames the target.
  The top bar carries a count badge that opens it.
- **Top bar:**
  - walnut strip with a brass BRIARFLOW nameplate
  - context and flow switchers
  - TYPES / GLOBALS buttons
  - revision + save state
  - undo / redo, problems badge, brass RUN button

Keyboard: `Space+drag` pan, `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z` undo/redo, `Delete` remove,
`/` add-node menu under the pointer, `Ctrl/Cmd+D` duplicate, `Shift+F10` / ContextMenu key selection menu, `Ctrl/Cmd+Enter` run, `F` frame selection.

Minimum supported viewport: 1280×720. Below 1024 px the right inspector becomes an overlay.

**Canvas legibility:** text on the canvas must never render below 9 px on screen. Initial
fit (`fitView`) uses `minZoom 0.85, maxZoom 1` (pan to the flow's top-left if it does not
fit); the **fit** control uses `maxZoom 1`. Below zoom 0.6 the node body switches to a
compact rendering (title, LEDs and sockets; no types/widgets/preview/tags) instead of unreadable text.

## 12. v1 implementation review (REQ-25, 2026-10-21)

| # | Deviation | Verdict |
|---|---|---|
| 1 | Struct / list constants as JSON, preview on node | **Accepted for v1** with conditions: skeleton prefill, pretty-print on blur, inline parse errors with line:col (§7). Popover editors stay the target. |
| 2 | Media: chip + "Choose file" | **Accepted**; the chip area must also accept a dropped file (§7). |
| 3 | Variables: Get / Set buttons in the panel | **Accepted**; buttons must look like secondary buttons, node added at viewport center and selected (§11). Drag-to-canvas later. |
| 4 | Implicit variable-order edges not drawn | **Accepted, deferred to v1.1** (§8). |
| 5 | Fixed rails; contexts tree create-only | **Fixed width accepted. Create-only pushed back:** rename and delete of contexts and flows are basic CRUD and the API already has them (`context.rename`, `flow.rename`, `flow.delete`, `DELETE /contexts/:id`). Row actions instead of a context menu are fine (§11). |
| 6 | Extra PROBLEMS dock tab | **Accepted** and adopted into the spec (§11). |
