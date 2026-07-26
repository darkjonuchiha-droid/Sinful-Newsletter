# Sinful Newsletter Hub — design brief

This folder is a self-contained copy of the admin dashboard for a redesign
pass. **Open `demo.html` in a browser and everything works** — sample data,
fake API, no server or database needed. Click through all of it.

```
demo.html      the page (identical to production apart from one added <script>)
style.css      all styling — this is the main file to rework
app.js         behavior (touch only where the contract below allows)
mock-api.js    the offline demo harness — sample data, not part of production
UI-CONTRACT.md what the JavaScript requires the markup to keep
```

Add `?login` to the URL (`demo.html?login`) to see the login screen; any
password works.

---

## What this product is

A dashboard for running a **newsletter inside Second Life** (a virtual
world). The owner runs an adult nightclub/event venue called *Sinful* and
uses this to announce events and hand out gifts to subscribers, without
requiring them to join an in-world group.

The "delivery vans" are scripted objects in the virtual world called
**kiosks**. The dashboard queues work; the kiosk hands the goods to
avatars in-world. That's why the interface talks about things like
*packages*, *attachments in the kiosk*, and *online/offline avatars*.

**Vocabulary** (please keep these words — they match what the owner and
subscribers see in-world):

| Term | Meaning |
|---|---|
| **Package** | One newsletter: a message plus attached items, delivered as a folder |
| **Attachment** | An item inside the kiosk — landmark (a saved place), notecard (a text document), object (e.g. a wearable invitation), sound |
| **Subscriber** | An avatar receiving the newsletter |
| **Display / Legacy name** | Avatars have a chosen display name (often stylized: `✧ Sïnful Røse ✧`) and a fixed legacy username |
| **List** | An audience segment (Orgy Nights, Concerts, Beach Events) |
| **Kiosk / Satellite** | The in-world delivery object / signup-only boards elsewhere on the grid |
| **Get Latest** | Self-service: an avatar touches a kiosk to re-request the newest public package |
| **Shadow-banned** | Looks subscribed to them, silently receives nothing |
| **Only online** | Deliver only to avatars currently in-world; offline ones are skipped, not queued |

## Who uses it

One person — the venue owner — usually **late at night, often on a second
monitor while in-world**, doing a weekly ritual: compose Tuesday, schedule
for Thursday, check on Sunday morning who received what. Sessions are
short and task-focused. It is not a multi-tenant SaaS; there is no
onboarding, no team, no permissions.

## Current aesthetic

Deliberately "velvet noir" — dark plum/wine background, rose (`#ff3d6e`)
as the action colour, gold (`#d9a441`) for secondary data, italic
*Fraunces* display type over *Karla* body text. The venue is a sensual,
adult, nightlife brand: the interface should feel like a **members' club
after midnight**, not like enterprise SaaS or a generic admin template.

Light mode is not required.

## What to improve

The functionality is finished and works; this pass is about visual
appeal and clarity. Known weak points, roughly in priority order:

1. **The package card** is the heart of the app and currently reads as a
   flat wall of small text: name, message, attachment chips, a progress
   bar, six stat numbers, an audience line, and five buttons. It needs
   hierarchy — the name and message should carry, stats should be
   glanceable rather than a run-on row.
2. **Density and rhythm** — spacing is uniform everywhere, so nothing
   leads the eye. There is no sense of "primary vs. secondary" beyond
   button colour.
3. **The empty and pending states** are plain text ("No packages yet",
   "…" while a display name resolves). They are the first thing a new
   user sees and deserve some charm.
4. **The modals** (package editor, delivery log, schedule, send-to-list)
   all look the same weight regardless of importance. The editor in
   particular is a long stack of fields plus a two-pane attachment
   picker and could use structure.
5. **The subscribers table** is functional but plain; consider how
   display name vs. legacy name vs. UUID are weighted, and how the
   👻/💤 states read.
6. **Personality** — a masthead, a favicon, some texture or motion at
   key moments (a send starting, a delivery completing) would make it
   feel like the venue's own tool rather than a form.

Things to keep: the dark palette direction, the terminology, the
information density on the subscribers table (this owner does bulk work),
and the fact that every destructive action is confirmed.

## Constraints

- **No build step and no framework.** Plain HTML + CSS + vanilla JS,
  served as static files. Please don't introduce React/Tailwind/etc.
- **Google Fonts are available** (already used); other external assets
  should be avoided — self-host or inline SVG instead.
- Must stay usable at **1280px wide** and degrade sanely on a phone
  (the owner sometimes checks sends from a tablet).
- Keep the DOM contract in `UI-CONTRACT.md` intact, or the app stops
  working when the design is merged back.

## How to hand the result back

Ideally return `style.css` (reworked) plus `demo.html` if markup changed,
keeping ids/classes per the contract. Those map 1:1 onto
`server/public/style.css` and `server/public/index.html` in the real
project — the only edit needed on merge is removing the `mock-api.js`
script tag from the page.
