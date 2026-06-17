# Ops Console — Visual Design Spec

**Status:** design reference · **Created:** 2026-06-17 · companion to [`ops-console-plan.md`](ops-console-plan.md)

Visual direction for the ops-console UI, taking inspiration from the **Clay** dashboard
(app.clay.com): light, airy, neutral canvas with a slim icon rail, a prominent command/search
bar, colorful quick-action cards, and clean data tables. This doc is about **look & feel** — the
domain/data model lives in the PRD.

> Inspiration, not a clone. We borrow the *patterns* (layout, spacing, tone), not Clay's brand,
> logo, copy, or proprietary assets.

---

## 1. Mood

Clean, calm, professional, slightly friendly. White space does the work. Color is reserved for
the primary action and small accents (icons, avatars, status) — the canvas itself stays neutral.
Nothing heavy: thin borders, soft radii, restrained shadows.

---

## 2. Design tokens

### Color
```
/* neutrals (canvas + text) */
--bg            #FFFFFF   page background
--bg-subtle     #F7F8FA   cards, hover rows, input fills
--bg-rail       #FBFBFC   left nav rail
--border        #ECECEF   1px hairline borders/dividers
--text          #16181D   primary text / headings
--text-muted    #6B7280   secondary text, descriptions
--text-faint    #9CA3AF   table meta, placeholders

/* brand / primary action */
--primary       #2563EB   primary buttons, active nav, links  (rebrandable)
--primary-hover #1D4ED8
--primary-tint  #EFF4FF   selected/active backgrounds

/* status accents (used sparingly, on chips/dots) */
--success #16A34A   --warning #D97706   --danger #DC2626   --info #0EA5E9
```
Accent emoji/icon colors on action cards are allowed to be vivid (Clay-style) — they're the only
"loud" color on the page.

### Typography
- **Font:** Inter (or system `-apple-system, Segoe UI, Roboto`). Variable weights.
- **Scale:** page greeting `28–32px / 700`; section headings `18–20px / 600`; body `14px / 400`;
  meta/labels `12–13px / 500`; numbers in tables tabular-nums.
- Generous line-height (1.4–1.5), comfortable letter-spacing on headings (slightly tight).

### Shape, spacing, elevation
```
--radius-sm 6px    inputs, chips
--radius    10px   cards, buttons
--radius-lg 14px   modals, large panels
--shadow-sm 0 1px 2px rgba(16,24,40,.05)
--shadow    0 4px 12px rgba(16,24,40,.08)   /* cards on hover, popovers */
```
Spacing on an 8px grid (4/8/12/16/24/32). Page gutters ~32px. Card padding 20–24px.

---

## 3. Layout shell

```
┌──┬───────────────────────────────────────────────────────────┐
│  │  topbar: (breadcrumb / page title)        🪙  ?  ⌄avatar    │
│R ├───────────────────────────────────────────────────────────┤
│A │                                                             │
│I │   Hey {name}, ready to get started?            [Show less ⌃]│
│L │   ┌───────────────────────────────────────────────────┐    │
│  │   │  ✦  Ask anything or search jobs…              [↑]  │    │  ← command bar
│  │   └───────────────────────────────────────────────────┘    │
│  │   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │  ← quick-action cards
│  │   │ 🔎 …   │ │ ⬆ …    │ │ 📣 …   │ │ 🧩 …   │              │
│  │   └────────┘ └────────┘ └────────┘ └────────┘              │
│  │                                                             │
│  │   All  ·  Recents  ·  Favorites              [🔎] [+ New]   │  ← tabs + table toolbar
│  │   ┌───────────────────────────────────────────────────┐    │
│  │   │ Name        ★   Last activity   Owner    Access  …  │    │  ← data table
│  │   └───────────────────────────────────────────────────┘    │
└──┴───────────────────────────────────────────────────────────┘
```

### Left icon rail
- Width ~56–64px, `--bg-rail`, hairline right border.
- Colorful logo mark at top; below it, monochrome (`--text-muted`) nav icons with generous
  vertical spacing. Active item = `--primary` icon on a `--primary-tint` rounded square; tooltip
  on hover. Settings/help pinned to the bottom.
- Icons map to: Dashboard · Clients · Campaigns · Jobs (index search) · Tracker · Settings.

### Topbar
- Thin, borderless over the canvas. Right-aligned: a small "credits/usage" pill (optional),
  a help `?`, and the avatar menu. No heavy app bar.

---

## 4. Component styling

**Command bar** (the hero element, Clay's "Ask me anything")
- Full-width, `--bg-subtle` fill, `--radius-lg`, 1px `--border`, ~56px tall.
- Left: a small colored mark/icon. Right: a round `--primary` send button with `↑`.
- Placeholder muted. On focus: white bg, `--primary` ring (2px, low-alpha), `--shadow`.

**Quick-action cards**
- Equal-width row (4 across desktop, wrap to 2 on tablet, 1 on mobile).
- `--bg-subtle` (or white with `--border`), `--radius`, padding 20–24px.
- Top: a vivid emoji/icon in a small rounded tinted square. Then bold 15–16px title, then a
  13px `--text-muted` one-line description.
- Hover: lift to white + `--shadow`, border darkens slightly, cursor pointer.

**Tabs** (All / Recents / Favorites)
- Text tabs, `--text-muted` default, active = `--text` with a 2px `--primary` (or dark) underline.
  No pill background.

**Data table**
- Borderless rows, hairline `--border` row dividers, header in `--text-faint` 12px uppercase-ish
  (or sentence-case 12px medium). Row height ~52px.
- Cells: Name (with a small file/entity icon), a star Favorite toggle, meta columns in
  `--text-muted`, Owner as avatar + name, an Access chip, trailing `…` row-actions menu (ghost
  button, appears/darkens on row hover). Whole-row hover = `--bg-subtle`.
- Toolbar above: left = Owner/Filters dropdowns (ghost, `--radius-sm`, with chevron); right =
  search input (`--bg-subtle`, magnifier) + `+ New` primary button.

**Buttons**
- Primary: `--primary` bg, white text, `--radius`, 14px/500, 36–40px tall, `--primary-hover` on
  hover. Secondary/ghost: transparent or `--bg-subtle`, `--text`, hairline border.
- Icon buttons: square, ghost, rounded, `--text-muted` → `--text` on hover.

**Chips / status**
- Small pill, `--radius-sm`, 12px/500, tinted bg of the status accent at ~12% alpha with the
  accent as text (e.g. active=success, paused=warning, archived=faint). For campaign/placement
  states.

**Avatars** — circular, 24–28px in tables, with subtle ring; initials fallback on a tinted bg.

---

## 5. Domain mapping of the home screen (visual only)

Reusing Clay's home layout with our content:
- **Greeting:** "Hey {operator}, ready to get started?"
- **Command bar:** natural-language entry → job search / "find roles for {client}" (wires to
  `search_jobs` later; visually it's the hero input now).
- **Quick-action cards:** `🔎 Find jobs` · `👤 Add client` · `📣 New campaign` · `🧩 From template`.
- **Tabbed table:** recent **clients / campaigns** with columns Name · ★ · Last activity ·
  Owner (operator avatar) · Access · `…`.

Other screens (Clients, Campaigns, Jobs, Tracker) reuse the same shell, table, card, and chip
primitives — one consistent system.

---

## 6. Implementation notes

- **Tailwind v4** (matches `status-page`) with the tokens above as CSS variables / theme.
- Component primitives: build a small set (`Card`, `Table`, `Tabs`, `Button`, `Chip`, `Avatar`,
  `CommandBar`, `Rail`) so every screen composes from them. shadcn/ui is a reasonable starting
  point (Radix + Tailwind, easy to restyle to these tokens) — optional.
- Dark mode: defer; design tokens are structured to add a dark theme later.
- Accessibility: visible focus rings (the `--primary` ring), AA contrast on `--text-muted` over
  `--bg-subtle`, keyboard-navigable rail + table row menus.
```
```
