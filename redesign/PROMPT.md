# Prompt to hand to the designer

Copy everything below the line, and attach the `redesign/` folder.

---

I'd like you to redesign the UI of this dashboard. Everything you need is
in the attached folder: **open `demo.html` in a browser and the whole app
works** — sample data, fake API, no server needed. Click through every
tab and modal before changing anything. Read `README.md` for product
context and `UI-CONTRACT.md` for the DOM hooks you must preserve.

**What it is:** the private admin tool for an adult nightclub in Second
Life (a virtual world). One person uses it — the venue owner — late at
night, usually on a second monitor while in-world, in short focused
sessions: write an event invitation on Tuesday, schedule it for Thursday,
check Sunday morning who received it. There is no team, no onboarding, no
marketing surface. It is a personal instrument, not a product.

**The feeling I'm after:** appealing, modern, clean — but above all
*elegant*. To be concrete about how those resolve when they conflict:

- **Elegant beats trendy.** No glassmorphism, no neon glow-everything, no
  gradient-on-every-surface. Restraint, confident spacing, and one or two
  memorable gestures.
- **Clean does not mean sterile.** This is a sensual, adult, after-dark
  brand — a members' club at 2am, not a fintech dashboard. Warmth,
  atmosphere and a little sex appeal are wanted; corporate neutrality is
  not.
- **Modern means current craft**, not a visual trend: real typographic
  hierarchy, deliberate rhythm, generous negative space where it earns
  attention, tight density where the owner does bulk work.

Keep the existing direction as your starting point — dark, wine/plum,
rose as the action colour, gold as the secondary accent, an italic
display face over a clean body face — but treat it as a foundation to
refine, not a constraint. If a better palette or type pairing serves
"elegant" more strongly, propose it and show me. Dark mode only; no
light theme needed.

**Priorities, highest first:**

1. **The package card** is the heart of the app and currently reads as a
   flat wall of small text: title, message, attachment chips, progress
   bar, six stat numbers, an audience line, five buttons. Give it real
   hierarchy — the event name and message should carry the card; the
   metrics should be glanceable, not a run-on row.
2. **Hierarchy across the app.** Right now spacing is uniform everywhere
   and nothing leads the eye. Establish a clear primary / secondary /
   tertiary language for type, surfaces and controls.
3. **The package editor modal** — a long stack of fields plus a two-pane
   attachment picker. Needs structure and breathing room.
4. **The subscribers table** — dense on purpose (bulk selection, bulk
   actions), but it should feel considered rather than plain. Consider
   how display name vs. legacy name vs. UUID are weighted, and how the
   👻 shadow-banned and 💤 inactive states read.
5. **States with personality** — empty states, the "…" placeholder while
   a name resolves, in-progress sends, toasts. These are currently bare
   strings.
6. **One memorable moment.** Something small and tasteful that makes the
   tool feel like *this venue's* — a masthead treatment, a texture, a
   considered transition when a send begins. One gesture done well beats
   five effects.

**Hard constraints:**

- Static HTML + CSS + vanilla JS. **No build step, no framework, no
  Tailwind, no component library.** It's served as plain files.
- Google Fonts are fine (already used). Avoid other external assets —
  inline SVG or CSS instead. No large images.
- Must work at 1280px and stay usable down to phone width.
- Preserve every id, `data-*` attribute and behavioural class listed in
  `UI-CONTRACT.md`. In particular `hidden` must remain `display: none` —
  it's the app's universal show/hide. Restyle and rearrange freely;
  just don't rename the hooks. If you need to break one, say so
  explicitly in your handback instead of doing it silently.
- Keep the vocabulary (package, attachment, kiosk, subscriber, list,
  Get Latest, shadow-banned) — those words match what people see
  in-world.

**Please hand back:** the updated `style.css`, plus `demo.html` if the
markup changed, still runnable by double-clicking `demo.html`. A short
note on what you changed and why — and flag anything you'd do next if
there were more time.

If something in the interface seems confusing, say so. Some of it is
awkward because it grew feature by feature, and I'd rather hear that than
have it politely restyled.
