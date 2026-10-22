# Spec: Design system ("Briar Brutal")

Status: draft v1 (phase 0; reviewed against the phase-7 build 2026-10-21, see §12). Owner: ux-designer. Used by `apps/studio` and
`@briarflow/editor-react` (phase 7). Tokens ship as a CSS file
(`@briarflow/editor-react/theme.css`) and as a TS object (`briarTheme`) with the same names.

Principles: **flat, heavy, honest.** Square corners, thick borders, hard offset shadows,
monospace headings, a visible grid. Yellow means "you / now / primary". Pastels mean
"kind" (type colors) or "state". Never a gradient, never a blur.

## 1. Color tokens

```css
:root {
  /* base */
  --bf-bg:            #1F1F1F;   /* app + canvas background */
  --bf-surface:       #2A2A2A;   /* panels, node bodies */
  --bf-surface-2:     #333333;   /* inputs, hovered rows, node header (default) */
  --bf-surface-3:     #3A3A3A;   /* pressed, active tab */
  --bf-ink:           #F5F1E6;   /* primary text, borders on dark */
  --bf-ink-muted:     #B3AD9F;   /* secondary text, placeholders */
  --bf-ink-disabled:  #7A766C;   /* disabled text (not required to meet AA) */
  --bf-ink-inverse:   #1F1F1F;   /* text on yellow and pastels */
  --bf-shadow:        #000000;   /* hard shadows */
  --bf-grid-minor:    #2A2A2A;
  --bf-grid-major:    #3A3A3A;

  /* brand */
  --bf-yellow:        #FFD400;   /* primary, selection, focus */
  --bf-yellow-press:  #E6BF00;

  /* pastels */
  --bf-mint:          #A8E6CF;
  --bf-lavender:      #C3B1E1;
  --bf-peach:         #FFC8A2;
  --bf-sky:           #A0D2EB;
  --bf-pink:          #FFB3C6;
  /* extended pastels (type map only) */
  --bf-lime:          #D4F0A0;
  --bf-aqua:          #9EE6E0;
  --bf-sand:          #E8D8B0;
  --bf-coral:         #FF9E9E;
  --bf-stone:         #B8B8B8;

  /* status */
  --bf-danger:        #FF7A7A;   /* errors (text and borders) */
  --bf-status-running: var(--bf-sky);
  --bf-status-done:    var(--bf-mint);
  --bf-status-cached:  var(--bf-lavender);
  --bf-status-error:   var(--bf-danger);
  --bf-status-skipped: var(--bf-stone);
  --bf-status-warning: var(--bf-peach);
  --bf-status-queued:  var(--bf-ink-muted);
}
```

Only a dark theme in v1 (see OPEN_QUESTIONS Q-DS-1).

## 2. Contrast (WCAG 2.1 AA)

AA needs ≥ 4.5:1 for normal text, ≥ 3:1 for large text (≥ 18.66 px bold / 24 px) and UI
component boundaries. Ratios computed with the WCAG relative-luminance formula.

| Foreground | Background | Ratio | Use | AA |
|---|---|---|---|---|
| ink `#F5F1E6` | bg `#1F1F1F` | 14.60 | body text on canvas | ✓ |
| ink `#F5F1E6` | surface `#2A2A2A` | 12.72 | panel text | ✓ |
| ink `#F5F1E6` | surface-2 `#333333` | 11.20 | inputs | ✓ |
| ink `#F5F1E6` | surface-3 `#3A3A3A` | 10.08 | active tab | ✓ |
| ink-muted `#B3AD9F` | bg `#1F1F1F` | 7.37 | secondary text | ✓ |
| ink-muted `#B3AD9F` | surface `#2A2A2A` | 6.42 | descriptions, placeholders | ✓ |
| ink-muted `#B3AD9F` | surface-2 `#333333` | 5.65 | placeholders in inputs | ✓ |
| yellow `#FFD400` | bg `#1F1F1F` | 11.51 | headings, links, selected labels | ✓ |
| yellow `#FFD400` | surface `#2A2A2A` | 10.03 | | ✓ |
| yellow `#FFD400` | surface-2 `#333333` | 8.83 | | ✓ |
| ink-inverse `#1F1F1F` | yellow `#FFD400` | 11.51 | primary button | ✓ |
| ink-inverse `#1F1F1F` | mint `#A8E6CF` | 11.68 | badges, node headers | ✓ |
| ink-inverse `#1F1F1F` | lavender `#C3B1E1` | 8.40 | | ✓ |
| ink-inverse `#1F1F1F` | peach `#FFC8A2` | 11.02 | | ✓ |
| ink-inverse `#1F1F1F` | sky `#A0D2EB` | 10.14 | | ✓ |
| ink-inverse `#1F1F1F` | pink `#FFB3C6` | 9.82 | | ✓ |
| ink-inverse `#1F1F1F` | lime `#D4F0A0` | 13.16 | | ✓ |
| ink-inverse `#1F1F1F` | aqua `#9EE6E0` | 11.65 | | ✓ |
| ink-inverse `#1F1F1F` | sand `#E8D8B0` | 11.68 | | ✓ |
| ink-inverse `#1F1F1F` | coral `#FF9E9E` | 8.35 | | ✓ |
| ink-inverse `#1F1F1F` | stone `#B8B8B8` | 8.31 | | ✓ |
| ink-inverse `#1F1F1F` | danger `#FF7A7A` | 6.53 | error badge | ✓ |
| mint / lavender / peach / sky / pink as text | surface `#2A2A2A` | 10.17 / 7.31 / 9.59 / 8.83 / 8.55 | type names in panels | ✓ |
| lime / aqua / sand / coral / stone as text | surface `#2A2A2A` | 11.46 / 10.15 / 10.17 / 7.27 / 7.24 | | ✓ |
| danger `#FF7A7A` | surface `#2A2A2A` | 5.68 | error messages | ✓ |
| danger `#FF7A7A` | bg `#1F1F1F` | 6.53 | | ✓ |
| ink-disabled `#7A766C` | surface `#2A2A2A` | 3.17 | disabled only (exempt) | n/a |

Rules: text on a pastel or yellow is **always** `--bf-ink-inverse`. Never put ink text on a
pastel. Non-text: grid lines (`#3A3A3A` on `#1F1F1F`, 1.45) are decorative and exempt;
borders that identify controls use ink (14.6) or yellow (11.5).

## 3. Typography

```css
@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&family=Space+Grotesk:wght@400;500;700&display=swap");
:root {
  --bf-font-display: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --bf-font-body:    "Space Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bf-font-code:    "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;

  --bf-text-xs: 11px;  --bf-text-sm: 12px;  --bf-text-md: 14px;
  --bf-text-lg: 16px;  --bf-text-xl: 20px;  --bf-text-2xl: 28px;
  --bf-leading: 1.4;   --bf-leading-tight: 1.15;
}
```

| Role | Font | Size / weight | Case |
|---|---|---|---|
| App title, panel titles | display | 16 / 800 | UPPERCASE, letter-spacing 0.04em |
| Node title | display | 13 / 600 | as typed |
| Port labels | body | 12 / 500 | as typed |
| Type names, ids, values, event log | code | 12 / 400 | as typed |
| Body, forms | body | 14 / 400 | sentence case |
| Big empty-state headline | display | 28 / 800 | UPPERCASE |

Minimum size anywhere: 11 px (ids and badges only).

## 4. Spacing, borders, shadows, radius, motion

```css
:root {
  --bf-space-0: 0; --bf-space-1: 4px; --bf-space-2: 8px; --bf-space-3: 12px;
  --bf-space-4: 16px; --bf-space-5: 24px; --bf-space-6: 32px; --bf-space-7: 48px; --bf-space-8: 64px;

  --bf-border-thin: 1px;     /* dividers inside panels */
  --bf-border: 2px;          /* inputs, buttons, ports */
  --bf-border-thick: 3px;    /* nodes, panels, dialogs */
  --bf-border-heavy: 4px;    /* selected node, focused dialog */

  --bf-shadow-sm: 2px 2px 0 0 var(--bf-shadow);
  --bf-shadow-md: 4px 4px 0 0 var(--bf-shadow);
  --bf-shadow-lg: 6px 6px 0 0 var(--bf-shadow);
  --bf-shadow-yellow: 4px 4px 0 0 var(--bf-yellow);

  --bf-radius: 0;            /* everything is square */
  --bf-duration: 80ms;       /* only for press offset and color; no easing curves beyond linear */
  --bf-z-canvas: 0; --bf-z-panel: 10; --bf-z-popover: 100; --bf-z-dialog: 1000; --bf-z-toast: 2000;
}
```

- **Press effect:** buttons and nodes move `translate(2px,2px)` and the shadow shrinks by 2 px
  on `:active`. Respect `prefers-reduced-motion` (no translate, color change only).
- **Focus:** `outline: 3px solid var(--bf-yellow); outline-offset: 2px;` on every
  interactive element (`:focus-visible`). Never remove focus outlines.

## 5. Canvas grid

```css
.bf-canvas {
  background-color: var(--bf-bg);
  background-image:
    linear-gradient(var(--bf-grid-major) 1px, transparent 1px),
    linear-gradient(90deg, var(--bf-grid-major) 1px, transparent 1px),
    linear-gradient(var(--bf-grid-minor) 1px, transparent 1px),
    linear-gradient(90deg, var(--bf-grid-minor) 1px, transparent 1px);
  background-size: 120px 120px, 120px 120px, 24px 24px, 24px 24px;
}
```
Grid unit 24 px (major every 5). Node positions snap to 12 px (half cell). With React Flow use
the `Background` component with the same sizes/colors (two layers). Grid scales with zoom.

## 6. Type → port color map

Ports encode **kind by color** and **shape by container**:

| Type | Token | Port shape |
|---|---|---|
| text | `--bf-mint` | filled square 12 px |
| int | `--bf-sky` | filled square |
| float | `--bf-aqua` | filled square |
| boolean | `--bf-lime` | filled square |
| image | `--bf-peach` | filled square |
| video | `--bf-coral` | filled square |
| audio | `--bf-pink` | filled square |
| model3d | `--bf-sand` | filled square |
| file | `--bf-stone` | filled square |
| struct (any) | `--bf-lavender` | filled square |
| enum (any) | `--bf-lavender` | filled **diamond** (square rotated 45°) |
| `list<X>` | color of X | **hollow** square, 3 px border in X's color, small `≡` glyph on hover |
| `X?` | color of X | X's shape with a **dashed** 2 px ink outline |
| unbound `$T` | `--bf-ink` | hollow square, dashed ink border |

Every port also has a 2 px `--bf-shadow` border so it stands out on any surface. Color is never
the only cue: the port tooltip and the inspector show the type name (`list<Character?>`).
Edges take the color of their **source port** type.

`briarTheme.typeColor(typeRef): string` implements this map so all components agree.

## 7. Node anatomy

```
 ┌──────────────────────────────────────────┐  3px ink border, shadow-md
 │▌TEXT TEMPLATE                  ● ⟳ 0.4  │  header: surface-2, 4px left strip in category color,
 ├──────────────────────────────────────────┤  title in display 13/600, status dot + badge right
 │ ■ name        ←  Break.name              │  connected input: label + source (muted, code font)
 │ ■ style       [ anime            ▾ ]     │  unconnected input: constant widget inline
 │ ◇ mood        [ calm             ▾ ]     │
 │                                text ■ ──┼─▶ outputs right-aligned
 ├──────────────────────────────────────────┤
 │ Draw {name} in {style} style             │  config preview (optional, muted, 2 lines max)
 └──────────────────────────────────────────┘
```

- Width: min 220 px, max 360 px; grows with the longest constant widget. Rows 28 px.
- Ports sit on the border line (half outside). Inputs left, outputs right.
- Header strip color: definition `color`, else by category (Text=mint, Image=peach,
  AI=lavender, Data=sky, Flow=yellow for `briar.input`/`briar.output`, Variables=pink).
- `briar.input`/`briar.output` have a yellow header (ink-inverse text) and cannot be deleted
  (no delete action shown).
- Variable get/set nodes are compact (one row): `GET count` / `SET count`, pink header.

### Constant value widgets (unconnected inputs)

| Type | Widget |
|---|---|
| text | single-line input; `multiline` → 3-row textarea that grows to 8 rows; `widget:"password"` masks |
| int | number input with − / + steppers (step 1), clamps to min/max on blur |
| float | number input (step 0.1), `widget:"slider"` when both min and max are set |
| boolean | square checkbox 16 px, yellow check on ink-inverse |
| enum | select showing labels |
| media | **v1:** a chip (thumbnail for image, icon + name for others, mime + size, × to clear) plus a secondary `CHOOSE FILE` button; the chip/button area is also a drop target (yellow dashed 2 px border while dragging a file over it). *Later:* 64 px drop zone "Drop file or click". |
| struct | **v1:** on the node a read-only preview `{…}` / `{ name, style }`; in the inspector and run form a JSON textarea (code font) **prefilled with a skeleton** built from the struct's fields (defaults, else `""` / `0` / `false` / `null` / `[]`), pretty-printed on blur, parse errors shown below in danger with line:col. *Later:* button `Edit Character…` opening a form popover. |
| list | **v1:** preview `3 items` / `empty` on the node; JSON textarea (prefilled `[]`) in inspector and run form, same error rules as struct. *Later:* list editor popover (add / remove / reorder). |
| optional | small "set" checkbox before the inner widget; unchecked = `null` (muted "none") |
| `$T` unbound | muted text "connect first" (setValue would be rejected) |

Connected input: the widget is hidden and replaced by `← <source node>.<port>`; a stored
constant is kept and shown as a ghost value in the inspector ("used when disconnected").

## 8. Edges

| State | Style |
|---|---|
| default | 3 px solid, source type color, orthogonal step path (React Flow `smoothstep` with radius 0) |
| hover | 4 px, ink 1 px outline |
| selected | 4 px **yellow**, plus a 2 px ink outline |
| invalid (`edge.type_mismatch`) | 3 px `--bf-danger`, dashed `6 4`, a ⚠ marker at the midpoint with the message on hover |
| running (target node running) | animated dash (`stroke-dasharray: 8 6`, moves 14 px / 400 ms), source color |
| implicit variable order | 1 px ink-muted dotted, visible only when a get/set node is selected. **Not drawn in v1** (REQ-25); planned for v1.1. |
| drag preview | 3 px yellow dashed; turns `--bf-danger` over an incompatible port, compatible ports glow (yellow 2 px ring) |

## 9. States

| State | Node | Port / control |
|---|---|---|
| hover | shadow-lg, header surface-3 | port grows to 14 px |
| focus (keyboard) | yellow outline 3 px offset 2 px | same |
| selected | border-heavy **yellow**, shadow-yellow | — |
| error (validation or run) | border `--bf-danger`, ⚠ badge in header (count), messages in inspector | invalid constant: input border danger + message below |
| warning | ⚠ badge peach | |
| queued (run) | status dot ink-muted hollow | |
| running | status dot sky, pulsing 1 s (no pulse with reduced motion); progress bar 3 px sky under the header; badge with fraction | |
| retrying | badge `retry 2/3` peach | |
| cached | status dot lavender + badge `CACHED` | |
| done | status dot mint, badge `0.8s` duration | |
| failed | status dot danger, header text danger on hover tooltip with error message | |
| skipped | whole node 50% opacity, badge `SKIPPED` stone | |
| disabled control | ink-disabled text, dashed border | |

Status dots are 10 px squares (not circles).

## 10. Components (studio + editor-react)

- **Button primary:** yellow bg, ink-inverse text, 2 px `--bf-shadow` border, shadow-md,
  display font 13/600 uppercase; hover → `--bf-yellow-press`. Secondary: surface-2 bg, ink
  text, ink border. Danger: danger border + text; filled danger on confirm dialogs.
- **Input:** surface-2 bg, 2 px ink-muted border, focus → yellow outline; height 32 px.
- **Panel:** surface bg, 3 px ink border, title bar 36 px with display uppercase title and
  a 3 px yellow underline when active.
- **Badge:** pastel bg, ink-inverse text, 11 px code font, 2 px padding, 1 px shadow border.
- **Toast:** surface, 3 px border in status color, shadow-lg, bottom-right.
- **Icons:** lucide, 16 px, stroke 2.
- **Ghost button** (borderless text button): only for low-stakes inline actions *inside a row*
  (`COPY`). Any action in a toolbar, top bar or panel footer (`UNDO`, `REDO`, `GET`, `SET`,
  `CLEAR`, `CHOOSE FILE`) is a **secondary** button, so enabled and disabled differ by more than
  the border: enabled = solid ink border + shadow-sm; disabled = dashed ink-disabled border, no
  shadow. A borderless enabled control next to a bordered disabled one reads backwards.
- **Add buttons** (`+ CONTEXT`, `+ INPUT`, `+ MEMBER`, …) beside a name field stay disabled
  (dashed) while the field is empty; pressing Enter in the field triggers them.
- **Row delete (×):** hit target ≥ 24×24 px, icon 12 px, danger color on hover only.
- **Empty states:** a muted one-line sentence that says what to do (`No runs yet — press RUN
  or Ctrl+Enter.`), never a blank box.

## 11. Studio layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ BRIARFLOW ▌ Marketing ▾  /  Portrait ▾          rev 13 · saved        [▶ RUN] [⋯]          │ 48px top bar
├──────────────┬────────────────────────────────────────────────────────────┬───────────────┤
│ CONTEXTS     │ ┌canvas (grid)───────────────────────────────────────────┐ │ INSPECTOR      │
│ ▸ Marketing  │ │                                                        │ │ Text template  │
│   ▸ Portrait │ │  ┌INPUT──────┐      ┌BREAK Character┐    ┌TEXT TEMPLATE┐│ │ id n_tpl       │
│   ▸ Banner   │ │  │ character■├─────▶■value   name ■├───▶■name         ││ │ Template       │
│ ▸ Support    │ │  └───────────┘      │        style◇├───▶■style   text■├┼▶│ [Draw {name}…] │
│ [+ CONTEXT]  │ │                     └──────────────┘    └─────────────┘│ │ Inputs …       │
│──────────────│ │                                       ┌OUTPUT────┐     │ │                │
│ NODES        │ │                                    ──▶■prompt     │     │ │                │
│ [search…  ]  │ │                                       └──────────┘     │ │                │
│ ▾ Text       │ │                                         [− 100% +] [⤢] │ │                │
│   Template   │ └────────────────────────────────────────────────────────┘ │                │
│   Join       ├────────────────────────────────────────────────────────────┤                │
│ ▾ AI (mock)  │ TYPES │ VARIABLES │ RUN                                    │                │
│   LLM        │ ┌──────────────────────────────────────────────────────────┐│                │
│   Image      │ │ RUN run_7  ● running  2/5 nodes   [CANCEL]               ││                │
│ ▾ Data       │ │ inputs { character: {…} }                                ││                │
│   Make struct│ │ 10:00:00.120  node.started   Break Character             ││                │
│   Constant   │ │ 10:00:00.140  node.completed Break Character  20ms       ││                │
│              │ │ 10:00:00.141  node.started   Text template               ││                │
│              │ └──────────────────────────────────────────────────────────┘│                │
└──────────────┴────────────────────────────────────────────────────────────┴───────────────┘
   260px left                    flexible center (canvas 65% / dock 35%)          320px right
```

Panels:
- **Left rail** (260 px; **fixed width in v1**, resizable 200–400 later): Contexts tree
  (contexts → flows; create, rename, delete — v1 may use row actions instead of a context
  menu: on hover/selection a row shows `✎` (inline rename, Enter saves, Esc cancels) and `×`
  (confirm dialog naming what is deleted; deleting a context also says how many flows go).
  The contexts section takes the height it needs (max 40 % of the rail) and the palette
  gets the rest) above the **Node palette** (search by title/type/category, grouped
  by category, drag onto canvas or press Enter to add at viewport center).
- **Canvas** (center): flow editor. Minimap off by default (toggle).
- **Bottom dock** (center, resizable, collapsible) with tabs TYPES, VARIABLES, RUN,
  **PROBLEMS** (tab label carries the count, `PROBLEMS 2`, in danger when any error):
  - **TYPES**: global types and this flow's local types in two sections; struct editor
    (fields table: name, type picker with shorthand + autocomplete, default, description);
    enum editor (members, labels); "Move to global/local" action; usage count per type.
  - **VARIABLES**: globals (name, type, access toggle readonly/readwrite, value widget) and
    flow variables (name, type, public/private toggle, default). **v1:** `GET` / `SET`
    secondary buttons per variable add the node at the viewport center, selected (`SET` is
    disabled for readonly globals, tooltip says why). *Later:* drag a variable onto the
    canvas → menu "Get / Set".
  - **RUN**: inputs form generated from the signature (same widgets as constants), RUN button,
    current run status, outputs (rendered: text, image thumbnails, JSON for structs),
    public variables, global writes, and the **event log** (code font, one line per event,
    filter by node, click a line → selects the node). Past runs in a dropdown.
- **Inspector** (right, 320 px): selection details — title, id (copyable), config fields,
  all input constants (same widgets), diagnostics for the selection; for edges: types of both
  ends; with nothing selected: flow name, description, signature editor (inputs/outputs).
- **Top bar**: context and flow switchers, revision + save state (`saved`, `saving…`,
  `conflict — reload`), Run button (yellow), overflow menu (export JSON, duplicate flow).
  - **PROBLEMS**: all diagnostics of the flow, errors first, each row: severity badge
    (aligned to the first text line, not stretched), message, code (muted, code font),
    target name; click → selects and frames the node/edge. Empty: `No problems.`
- **Diagnostics**: a count badge in the top bar (danger bg when any error, peach when only
  warnings) opens the PROBLEMS tab.

Keyboard: `Space+drag` pan, `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z` undo/redo, `Delete` remove,
`/` focus palette search, `Ctrl/Cmd+Enter` run, `F` frame selection.

Minimum supported viewport: 1280×720. Below 1024 px the right inspector becomes an overlay.

**Canvas legibility:** text on the canvas must never render below 9 px on screen. Initial
fit (`fitView`) uses `minZoom 0.85, maxZoom 1` (pan to the flow's top-left if it does not
fit); the **fit** control uses `maxZoom 1`. Below zoom 0.6 the node body switches to a
compact rendering (title + ports, no labels/widgets/preview) instead of unreadable text.

## 12. v1 implementation review (REQ-25, 2026-10-21)

| # | Deviation | Verdict |
|---|---|---|
| 1 | Struct / list constants as JSON, preview on node | **Accepted for v1** with conditions: skeleton prefill, pretty-print on blur, inline parse errors with line:col (§7). Popover editors stay the target. |
| 2 | Media: chip + "Choose file" | **Accepted**; the chip area must also accept a dropped file (§7). |
| 3 | Variables: Get / Set buttons in the panel | **Accepted**; buttons must look like secondary buttons, node added at viewport center and selected (§11). Drag-to-canvas later. |
| 4 | Implicit variable-order edges not drawn | **Accepted, deferred to v1.1** (§8). |
| 5 | Fixed rails; contexts tree create-only | **Fixed width accepted. Create-only pushed back:** rename and delete of contexts and flows are basic CRUD and the API already has them (`context.rename`, `flow.rename`, `flow.delete`, `DELETE /contexts/:id`). Row actions instead of a context menu are fine (§11). |
| 6 | Extra PROBLEMS dock tab | **Accepted** and adopted into the spec (§11). |
