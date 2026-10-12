# Canvass — Design Tokens and UI Foundations

Canvass is the working name for the door-to-door field app: a mobile PWA for reps and a desktop console for managers. This document is the visual contract. The code source of truth is `app/tokens.css`; when this document and the CSS disagree, fix the CSS to match this document and note the change.

Related docs: `docs/PRD.md` (what to build), `docs/BACKEND_SPEC.md` (how the data works).

## 1. Direction: road sign meets door hanger

The people using this app are walking between doors in direct sunlight, one hand holding a phone, often in a hurry, sometimes at dusk. The visual language borrows from the two objects they live with all day: US road signage (they drive between neighborhoods) and the door hanger (the die-cut card a rep leaves when nobody answers).

Five principles decide every screen:

1. **Sunlight first.** Body text is at least 7:1 against its background in the rep app, and controls use a 2px ink outline rather than a soft shadow, so edges stay crisp in glare. Grey-on-grey is never allowed.
2. **One thumb.** Every primary action sits in the bottom 40% of the screen. Tap targets are at least 48px, and primary actions are 56px tall.
3. **State is color, shape and word.** A door's status is never communicated by color alone. Every status has a color tone, a Lucide icon and a plain-language label.
4. **One ornament.** The door-hanger card for the current stop is the only decorative element in the product. Everything around it is quiet: flat surfaces, ink outlines, no gradients, no illustrations.
5. **Motion confirms, never decorates.** The only orchestrated animation is the hanger swing when a visit is saved. Everything else is a short state transition in response to a tap.

What this direction deliberately avoids: cream backgrounds with a terracotta accent, dark mode with an acid-green accent, identical rounded cards with grey drop shadows, all-caps eyebrow labels, monospace for data, and arrows appended to button text.

## 2. Typography

**Overpass** (Google Fonts, variable weight 100 to 900) is the only typeface. It descends from Highway Gothic, the face on US interstate signs, so it reads quickly at a glance and carries the road-sign character without effort. Load it with `next/font/google`, expose it as the CSS variable `--font-overpass`, and use `display: swap`.

```ts
// app/fonts.ts
import { Overpass } from "next/font/google";
export const overpass = Overpass({ subsets: ["latin"], variable: "--font-overpass", display: "swap" });
```

Numerals use tabular, lining figures (`.tnum`, or `font-feature-settings: "tnum" 1, "lnum" 1`) for times, distances, counts, stop numbers and house numbers, so columns of figures align and do not jitter as they update.

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `text-display` | 40 / 40 | 800 | Stop number on the hanger tab; big counters on the console |
| `text-title-l` | 26 / 30 | 800 | Screen titles in the rep app |
| `text-title-m` | 21 / 26 | 700 | Company name on the hanger card; console section titles |
| `text-title-s` | 18 / 24 | 700 | List row titles; sheet titles |
| `text-body-l` | 17 / 26 | 400 | Default body text in the rep app |
| `text-body` | 15 / 22 | 400 | Default body text in the manager console |
| `text-label` | 14 / 18 | 600 | Buttons, form labels, chips |
| `text-caption` | 13 / 18 | 500 | Timestamps, helper text. Never below 13px. |

Rules:

- Sentence case everywhere, including buttons, chips and table headers. No all-caps labels and no letter-spaced eyebrows.
- Do not accent single words with a different color or italic.
- Keep line length under 70 characters in sheets and dialogs; the rep app's single column does this naturally.
- Addresses are written in one line, with the house number in tabular figures: **6101 Preston Rd, Plano, TX 75093**.

## 3. Color

### 3.1 Palette

| Name | Hex | Role |
| --- | --- | --- |
| Asphalt 900 | `#172026` | Ink: primary text, outlines, bottom bar |
| Asphalt 700 | `#36434B` | Secondary text |
| Asphalt 500 | `#56636B` | Muted text, input borders |
| Concrete 100 | `#EEF1F2` | App background (cool sidewalk grey) |
| Paper | `#FFFFFF` | Cards, sheets, inputs |
| Interstate blue | `#1565C0` | The single action color (primary buttons, hot doors) |
| Mailbox blue | `#1F4E8C` | Route lines, links, focus rings, "scheduled" |
| Curb yellow | `#F5B800` | Attention ("needs review", "follow-up") |

The supporting tones (green, red, violet, teal, slate) are used only for status chips and map pins; their exact values live in `tokens.css`.

### 3.2 Semantic tokens

Components use semantic tokens only, never primitives. Tailwind utilities are generated from them (`bg-surface`, `text-ink-2`, `border-line-strong`, `bg-action text-on-action`, and so on).

| Token | Day | Dusk | Use |
| --- | --- | --- | --- |
| `bg` | Concrete 100 | `#11181D` | Page background |
| `surface` | Paper | `#1A242A` | Cards, sheets, inputs |
| `surface-sunken` | `#DCE2E5` | `#23303A` | Wells, skeletons, disabled fills |
| `surface-inverse` | Asphalt 900 | `#E8EDEF` | Bottom action bar, toasts |
| `ink` / `ink-2` / `ink-3` | Asphalt 900 / 700 / 500 | Fog 100 / 300 / Asphalt 300 | Text hierarchy |
| `line` | `#C3CCD0` | `#23303A` | Decorative dividers only |
| `line-strong` | Asphalt 500 | `#6E7C85` | Input and control borders |
| `outline` | Asphalt 900 | Fog 100 | 2px ink outline on rep cards, pins, primary buttons |
| `action` / `on-action` | Interstate blue / Paper | `#5B9BF0` / `#11181D` | Primary button fill and its text |
| `hot` / `hot-text` | Interstate blue / `#0D47A1` | `#5B9BF0` | Hot-door flag; "Hot" as text |
| `link`, `focus`, `route` | Mailbox blue | `#8DB4EA` | Links, focus ring, route line |
| `scrim` | Asphalt 900 at 45% | Black at 60% | Backdrop behind sheets and modals |

### 3.3 Hard rules

1. **Text on Interstate blue is always white** in the day theme. Paper on Interstate blue is 5.75:1. Ink on Interstate blue is only 2.88:1 and fails, so it is never allowed. (In dusk, `on-action` is `#11181D` on `#5B9BF0`, 6.31:1.)
2. **Input borders use `line-strong`** (6.2:1 on paper). `line` (1.6:1) is for decorative dividers only and must never be the only edge of a control.
3. **Map pins always carry a 2px `outline` stroke.** Curb yellow on white is only 1.8:1, so the fill alone cannot define the pin's edge.
4. **Primary buttons carry a 2px `outline` border** in the rep app. Interstate blue against concrete is 5.06:1; the ink border keeps the button edge consistent with every other control and reads in sunlight.
5. Dusk is a full theme, not inverted colors. Apply `data-theme="dusk"` on `<html>`, or let the OS preference choose unless the user forced day.

### 3.4 Verified contrast

Computed with the WCAG 2.x formula on the hex values above.

| Pair | Ratio | Passes |
| --- | --- | --- |
| Ink on paper | 16.52 | AAA |
| Ink on concrete (app bg) | 14.55 | AAA |
| Ink-2 on concrete | 8.97 | AAA |
| Ink-3 on concrete | 5.45 | AA |
| Paper on Interstate blue | 5.75 | AA |
| Interstate blue on concrete (button edge) | 5.06 | 3:1 non-text |
| Hot-text `#0D47A1` on paper | 8.63 | AAA |
| Paper on Mailbox blue | 8.31 | AAA |
| Mailbox blue on concrete | 7.32 | AAA |
| Line-strong on paper (control edge) | 6.19 | 3:1 non-text |
| Status chips (fg on bg), day | 5.2 to 6.6 | AA |
| Dusk: ink on surface | 13.38 | AAA |
| Dusk: ink-2 on surface | 7.27 | AAA |
| Dusk: on-action on action | 6.32 | AA |
| Dusk: status chips | 6.8 to 8.0 | AA (most AAA) |
| Dusk: line-strong on surface | 3.67 | 3:1 non-text |

## 4. Status and outcome system

Every door status and visit outcome maps to one tone, one Lucide icon and one label. Implement it as a single constant so the chip, the map pin, the list row and the filter menu can never disagree.

### 4.1 Door statuses

| Status | Label | Tone | Icon |
| --- | --- | --- | --- |
| `NEW` | New | slate | `circle-dashed` |
| `NEEDS_REVIEW` | Needs review | amber | `triangle-alert` |
| `GEOCODED` | Ready | teal | `map-pin` |
| `ASSIGNED` | Assigned | blue (outlined chip) | `user-check` |
| `SCHEDULED` | Scheduled | blue | `route` |
| `VISITED` | Visited | violet | `door-open` |
| `CLOSED` | Closed | ink | `archive` |
| `UNASSIGNABLE` | No rep nearby | red | `map-pin-off` |

### 4.2 Visit outcomes

| Outcome | Label | Tone | Icon |
| --- | --- | --- | --- |
| `NOT_HOME` | Not home | slate | `door-closed` |
| `NOT_INTERESTED` | Not interested | ink | `circle-x` |
| `FOLLOW_UP` | Follow-up | amber | `calendar-clock` |
| `APPOINTMENT_SET` | Appointment set | blue | `calendar-check` |
| `SOLD` | Sold | green | `badge-check` |
| `BAD_ADDRESS` | Bad address | red | `map-pin-x` |

### 4.3 Review reasons

These show as the secondary line under an amber "Needs review" chip.

| Reason | Label |
| --- | --- |
| `PO_BOX` | Address is a PO box |
| `MISSING_ADDRESS` | No street address |
| `LOCATION_MISMATCH` | Company address is far from the job city |
| `REMOTE_JOB` | Remote job, nothing to visit |
| `LOW_GEOCODE_QUALITY` | Address could not be pinned exactly |
| `COVERAGE_GAP` | No rep within driving range |
| `BAD_ADDRESS` | Rep reported a bad address |
| `ROLLOVER_LIMIT` | Moved to the next day too many times |

```ts
// lib/ui/status.ts
export const DOOR_STATUS = {
  NEW:          { label: "New",           tone: "slate",  icon: "CircleDashed" },
  NEEDS_REVIEW: { label: "Needs review",  tone: "amber",  icon: "TriangleAlert" },
  GEOCODED:     { label: "Ready",         tone: "teal",   icon: "MapPin" },
  ASSIGNED:     { label: "Assigned",      tone: "blue",   icon: "UserCheck", outlined: true },
  SCHEDULED:    { label: "Scheduled",     tone: "blue",   icon: "Route" },
  VISITED:      { label: "Visited",       tone: "violet", icon: "DoorOpen" },
  CLOSED:       { label: "Closed",        tone: "ink",    icon: "Archive" },
  UNASSIGNABLE: { label: "No rep nearby", tone: "red",    icon: "MapPinOff" },
} as const;
// VISIT_OUTCOME and REVIEW_REASON follow the same shape (tables 4.2 and 4.3).
// Tone classes: chip = `bg-{tone}-bg text-{tone}-fg`; pin fill = `{tone}-solid` with a 2px outline stroke.
```

## 5. Space, size, shape, depth

**Spacing** uses Tailwind's default 4px step. Layout constants:

| Token | Value | Use |
| --- | --- | --- |
| `--gutter-rep` | 16px | Rep app side padding |
| `--gutter-mgr` | 24px | Console panel padding |
| `--content-max-rep` | 480px | Rep app column width on tablets |
| `--touch-min` | 48px | Every tappable element |
| `--touch-primary` | 56px | Primary actions in the rep app |
| `--bar-height` | 72px + safe area | Rep bottom action bar |

**Radius scales with hierarchy**, so containers and controls are never the same roundness:

| Token | Value | Use |
| --- | --- | --- |
| `radius-xs` | 4px | Checkbox, small badge |
| `radius-sm` | 6px | Inputs, buttons |
| `radius-md` | 10px | List rows, console cards, bottom of the hanger card |
| `radius-lg` | 18px | Sheets, top of the hanger card |
| `radius-pill` | 999px | Status chips, filter chips |

**Borders:** 1px hairlines for dividers; 2px ink (`--border-ink`) for rep cards, primary buttons and pins; a 3px focus ring with a 2px offset.

**Elevation is for overlays only** (sheets, toasts, map controls, popovers). Cards in the rep app sit flat with an ink outline. The console may use `shadow-1` on cards that float over the map. Shadows are tinted asphalt, never neutral grey.

**Layers:** map controls 10, bottom bar 20, sheet 30, toast 40, modal 50.

## 6. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120ms | Press feedback, chip toggles |
| `--dur-base` | 200ms | Sheet open and close, row expand |
| `--dur-slow` | 320ms | Map fly-to, list reflow |
| `--dur-swing` | 420ms | The hanger swing (only use) |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | Default for entering elements |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | Elements moving between positions |
| `--ease-swing` | `cubic-bezier(.34,1.56,.64,1)` | Hanger swing overshoot |

**The hanger swing** is the product's one orchestrated moment. When a visit is saved, the hanger card rotates about its hole (`transform-origin: 50% var(--hanger-hole-y)`) from 0 to -4 degrees to 2 degrees to 0, then collapses into the "Done" list while the next stop's card rises into place. With `prefers-reduced-motion`, all durations are 0: the card is replaced instantly and the toast still confirms.

No entrance animations on page load, no hover lift on cards, no parallax.

## 7. Layout

### 7.1 Rep app (360 to 430px wide, single column)

```
┌──────────────────────────────┐
│ Today                  [⋯]   │  title-l
│ 9 of 14 stops left           │  status line in ink-2
│ ● Sharing location           │  shift indicator (only while day is on)
├──────────────────────────────┤
│  ┌──────────(  )──────────┐  │  door-hanger card: current stop
│  │        Stop 5          │  │  tab: stop number in text-display
│  ├────────────────────────┤  │
│  │ Bluebonnet Dental Group│  │  title-m
│  │ 6101 Preston Rd, Plano │  │  body-l, tnum house number
│  │ Arrive ~10:40, 6 min   │  │  caption
│  │ [Hot] Hiring an office │  │  notes (2 lines, expandable)
│  │ [ Navigate ] [Arrived] │  │  secondary + primary
│  └────────────────────────┘  │
│  Up next                     │
│  6  Metroplex HVAC  10:58    │  list rows, 56px
│  7  Harvest Table    11:20   │
│  Done (4)               ▾    │  collapsed group
├──────────────────────────────┤
│ [  List  |  Map  ]  [ Log visit ] │  inverse bottom bar, safe-area padded
└──────────────────────────────┘
```

The bottom bar holds the one primary action for the current state: "Start day" before the shift, "Log visit" during it, "End day" when all stops are done. Content is left-aligned throughout; nothing is centered except the stop number on the hanger tab.

### 7.2 Manager console (1280px and up; usable at 1024px)

```
┌───────────────────────────────────────────────────────────────┐
│ Canvass  Map  Review (7)  Doors  Reps  Imports  Settings   [me]│
├──────────────────────────────────────┬────────────────────────┤
│                                      │ Needs review (7)       │
│   Live map                           │ ┌────────────────────┐ │
│   • rep markers with freshness ring  │ │ Red River Logistics│ │
│   • door pins by status              │ │ Far from job city  │ │
│   • route lines for selected rep     │ │ [Use company addr] │ │
│                                      │ │ [Edit] [Close]     │ │
│   [filters: date, rep, status]       │ └────────────────────┘ │
│                                      │ Today by rep           │
│                                      │ Jordan  12 of 14, 3 appt│
└──────────────────────────────────────┴────────────────────────┘
        map: 7 of 12 columns                 panel: 5 of 12
```

## 8. Components

### 8.1 Door-hanger card (signature)

The current stop is drawn as a door hanger: a card with a tab at the top and a round hole punched through it.

Anatomy:

- Tab: height `--hanger-tab-h` (64px), full card width, top corners `radius-lg`. It holds the hole and, centered below it, the stop number ("Stop 5") in `text-title-l`. (`text-display` at 40px cannot fit under the hole in a 64px tab.)
- Hole: a circle of radius `--hanger-hole` (14px), centered horizontally, `--hanger-hole-y` (22px) from the top. Cut with a CSS mask so the page background shows through, with a 2px ink ring drawn by a pseudo-element.
- Body: `surface` fill, 2px `outline` border, bottom corners `radius-md`, 16px padding. It holds the company name, address, planned arrival and drive time ("Arrive ~10:40, 6 min drive"), notes and the two actions.
- A hot door gets an Interstate-blue (`hot`) tab with `on-action` text (white in day). Normal doors get a `surface-sunken` tab.

```css
.hanger { border: var(--border-ink) solid var(--outline); border-radius: var(--radius-lg) var(--radius-lg) var(--radius-md) var(--radius-md); background: var(--surface); }
.hanger__tab {
  position: relative; height: var(--hanger-tab-h); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--surface-sunken);
  -webkit-mask: radial-gradient(circle var(--hanger-hole) at 50% var(--hanger-hole-y), transparent 98%, #000 100%);
          mask: radial-gradient(circle var(--hanger-hole) at 50% var(--hanger-hole-y), transparent 98%, #000 100%);
}
.hanger--hot .hanger__tab { background: var(--hot); color: var(--on-action); }
.hanger__ring { position: absolute; left: 50%; top: var(--hanger-hole-y); width: calc(var(--hanger-hole) * 2 + 4px); aspect-ratio: 1;
  translate: -50% -50%; border: var(--border-ink) solid var(--outline); border-radius: 50%; pointer-events: none; }
```

States: current (full card), done (collapses to a 56px row with the outcome chip), skipped (row with a "Skipped" slate chip and the reason).

### 8.2 Buttons

| Variant | Fill | Text | Border | Height (rep / console) |
| --- | --- | --- | --- | --- |
| Primary | `action` | `on-action`, `text-label` 700 | 2px `outline` (rep), none (console) | 56 / 40 |
| Secondary | `surface` | `ink` | 2px `outline` (rep), 1px `line-strong` (console) | 56 / 40 |
| Quiet | transparent | `link` | none | 48 / 36 |
| Danger | `surface` | `danger` | 1px `danger` | 48 / 40 |

Pressed state: translate 1px down and an inset 2px ink shadow; the fill may darken slightly (a darker blue only raises contrast with white text). Disabled: `surface-sunken` fill, `ink-3` text, no border. Labels are verbs: "Start day", never "Submit".

### 8.3 Form controls

- Inputs: `surface` fill, 1px `line-strong` border (2px in the rep app), `radius-sm`, 48px tall in the rep app. The label sits above in `text-label`, helper text below in `text-caption`, errors in `danger` with a `circle-alert` icon.
- Outcome picker (visit form): a 2-column grid of six large toggle tiles (56px tall). Each shows the outcome icon and label; the selected tile takes its tone's `bg` fill with a 2px tone `fg` border.
- Date and time: native pickers (`<input type="date">`, `<input type="time">`) in the rep app for reliability.

### 8.4 Chips

Pill radius, 28px tall, `text-label`, a 16px icon then the label. Filled (`{tone}-bg` with `{tone}-fg`) for status. Outlined (`{tone}-fg` border, transparent fill) for "Assigned" and for filter chips.

### 8.5 Bottom action bar (rep)

A `surface-inverse` fill, `--bar-height` plus `env(safe-area-inset-bottom)`. It holds the List/Map segmented toggle on the left and the single primary button on the right. It does not scroll away.

### 8.6 Sheets and toasts

- Sheets slide up from the bottom (rep) or in from the right (console), with `radius-lg` top corners, `shadow-3`, a drag handle, and a sticky footer containing the action.
- Toasts appear above the bottom bar, on `surface-inverse` with `ink-inverse` text, for 4 seconds, with one optional action ("Undo"). The copy is the past tense of the action: "Visit saved", "Day started".

### 8.7 Offline and sync indicator

- A slim banner under the title: `tone-amber` with the text "Offline. 3 visits will sync when you're back online."
- When the connection returns: `tone-teal` with "Syncing 3 visits", then the banner disappears.
- A failed sync: `tone-red` with "2 visits didn't sync. Tap to retry." It never auto-dismisses.

### 8.8 Map

MapLibre GL with OpenFreeMap vector tiles, restyled with the `--map-*` tokens (land concrete, roads paper with concrete casing, water blue-100, labels asphalt-500; the dusk theme swaps all five).

- Door pins: 28px teardrop, `{tone}-solid` fill, 2px `outline` stroke, white status icon. The selected pin grows to 36px.
- Hot doors get a 4px Interstate-blue (`hot`) halo and a small `flame` badge. Hot and scheduled pins are both blue, so the halo and badge, not the fill, are what mark a hot door.
- Route line: 5px `route` color with a 2px `surface` casing, numbered stop markers (tabular figures) along it.
- Rep markers (console): a 32px circle with the rep's initials on `surface-inverse`. A freshness ring encodes how recent the location is: solid ring under 15 minutes, dashed from 15 to 120 minutes, none beyond that, with "Last seen 3h ago" in the tooltip.

### 8.9 Icons

lucide-react, 24px at 1.75px stroke in the rep app and 20px in the console. Icons always sit next to a text label, except in map pins and the List/Map toggle; those carry `aria-label`.

## 9. Voice and copy

Write for a rep standing on a sidewalk: short, plain verbs, sentence case, no jargon. Keep the same verb throughout a flow.

| Moment | Copy |
| --- | --- |
| Before the shift | Button "Start day". Title "Today", status line "14 stops planned" |
| Shift running | Indicator "Sharing location while your day is on" |
| Arrive | Button "Arrived". Toast "Marked as arrived" |
| Off-site arrival | "You're 340 m from this address. Log the visit anyway?" |
| Visit | Button "Log visit". Sheet title "How did it go?". Save button "Save visit". Toast "Visit saved" |
| Hot door pushed | Notification "New hot door: Bluebonnet Dental, 2.1 mi away" |
| Empty day | "No stops today. New doors will show up here as they're assigned." |
| End of day | Button "End day". If stops remain: "4 stops not visited. They'll move to your next working day." |
| Location denied | "Canvass needs your location to log visits. Turn it on in Settings, then come back." |
| Console, needs review | "7 doors need an address decision" |

Errors state what happened and what to do, without apologizing: "Photo is over 5 MB. Take a smaller one or skip it."

## 10. Accessibility checklist

- Every pair in section 3.4 meets AA; rep-app body text meets AAA.
- Status never relies on color alone (icon and label always present).
- Touch targets are 48px minimum, with 8px between adjacent targets.
- Focus is visible on every control (3px focus ring, 2px offset).
- `prefers-reduced-motion` zeroes all durations.
- Dynamic type: layouts hold at 200% zoom; the hanger card grows and does not truncate the address.
- The map is never the only way to reach information. Every pin's content is reachable from the list.
- Form errors are announced (`aria-live="polite"`) and linked to their field.

## 11. Implementation notes for Claude Code

1. Copy `app/tokens.css`, import it in `app/globals.css`, and apply `overpass.variable` on `<html>`.
2. Theme switching: a `ThemeProvider` sets `data-theme` on `<html>` to `day` or `dusk`, or removes it for automatic (OS preference). The rep app also offers an automatic option that switches to dusk after local sunset.
3. Build these primitives first, in `components/ui/`: Button, Chip, StatusChip, Input, Field, Sheet, Toast, BottomBar, HangerCard, OutcomePicker, MapPin, RepMarker, OfflineBanner.
4. Never use a hex value or a Tailwind palette color (`bg-gray-100`) in components. Lint for raw hex in `components/` and `app/`.
5. Keep the dusk block in `tokens.css` and the `prefers-color-scheme` block identical. If they drift, generate both from one TypeScript token object.
