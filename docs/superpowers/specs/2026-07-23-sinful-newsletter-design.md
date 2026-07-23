# Sinful Newsletter — Design

**Date:** 2026-07-23
**Status:** Approved by Jon

## Purpose

A Second Life newsletter/notice system in LSL that works like group Notices but
without requiring subscribers to join a group (no group slot used, no group cap).
Single owner-admin (Jon). Subscribers receive event announcements as an IM plus a
folder of attached items (notecards, landmarks, objects).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Storage | **LinksetData** on the prim (survives script reset/update/replacement, re-rez, and object copies). Notecard backup/restore as safety net and as the migration path to an unrelated prim. |
| Admin UI | **Both** dialog menus (touch) and chat commands on a private channel (default `/9`). Text entry via `llTextBox`. |
| Signup | **Both** admin-managed (add by UUID or legacy name) and self-service (non-owner touch → Subscribe/Unsubscribe dialog). |
| Events | **Persistent and re-sendable** — stored as name + message + attached item names; items live in the object inventory. |

## Architecture

One prim, one script (`sinful-newsletter.lsl`). No external server, no Experience.

### Data model (LinksetData, 128KB budget, separate from script memory)

- `sub:<uuid>` → legacy name (captured at add/subscribe time)
- `evt:<name>` → JSON `{"msg": "...", "items": ["item1", "item2"]}`

Capacity ≈ 1,500+ subscribers. Attached items are referenced by inventory name;
the actual items sit in the prim's inventory and must be **copy + transfer**
(enforced at attach time so no-copy items are never given away).

### Key techniques

- Paged iteration with `llLinksetDataFindKeys("^sub:", first, count)` — the full
  subscriber list is never materialized in script memory (which couldn't hold
  1,500 UUIDs).
- Name→UUID via `llRequestUserKey`; UUID→legacy name via
  `llRequestAgentData(id, DATA_NAME)`. All async through `dataserver`.
- Delivery: `llInstantMessage` (message) + `llGiveInventoryList` (folder named
  after the event). Blasts run on a timer, one recipient per tick (~5 s each due
  to LSL sleeps), with progress reports every 25 and a completion summary. The
  object stays responsive during a blast.

### Admin interface

- **Touch (owner)** → main menu: Subscribers / Events / Status / Help.
  - Subscribers: paginated (8/page), tap number → remove; `+ Add` → textbox for
    UUID or legacy name.
  - Events: paginated list; `+ New` → name textbox → message textbox → item
    toggle menu (paginated over object inventory, excluding scripts and the
    backup notecard). Per-event menu: Send All / Send One / Edit Msg / Items /
    Delete.
- **Chat channel `/9`** (owner only): `add`, `remove`, `list`, `send <event>`,
  `sendto <dest> | <event>`, `backup`, `restore`, `status`, `menu`, `reset`, `help`.

### Subscriber interface

Non-owner touch → Subscribe/Unsubscribe dialog with confirmation via
`llRegionSayTo`. Owner gets a notification on each change.

### Backup / restore / migration

- `backup` → dumps `uuid,name` CSV lines to owner chat in chunks; owner pastes
  into a notecard named `backup`.
- `restore` → reads notecard `backup` from the prim's inventory line by line and
  re-adds missing subscribers. This is also the migration path to a brand-new
  prim (LinksetData follows the object and its copies, not the script).

## Error handling

- LinksetData writes checked against `LINKSETDATA_OK`; owner warned when full.
- Items missing at send time (deleted from inventory) are skipped silently per
  recipient, keeping the blast running.
- Unresolvable names reported ("No such resident").
- Event messages capped at 800 chars (IM byte limit); names at 40 chars.
- Concurrent blasts blocked.

## Known limitations (accepted)

- Offline subscribers with capped IMs can miss deliveries — identical to group
  notices.
- LSL throttles make a 300-person blast take ~15–25 minutes.
- No automated tests: LSL has no local runtime; verification is by in-world
  testing (checklist in README).

## Deliverables

- `sinful-newsletter.lsl`
- `README.md` (setup, usage, backup/restore, in-world test checklist)
