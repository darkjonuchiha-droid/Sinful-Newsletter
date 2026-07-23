# Sinful Newsletter

A Second Life newsletter/notice system in LSL that works like group Notices —
IM announcement + attached items — but **without a group**: subscribers don't
spend a group slot and there's no member cap from SL groups.

- Subscribers and events are stored in **LinksetData on the prim**, so they
  survive script resets, script updates, replacing the script, taking the
  object to inventory, re-rezzing, and copying the object.
- Capacity: roughly **1,500+ subscribers** (128KB LinksetData budget).
- No external server, no Experience, no Premium requirement.

## Setup

1. Rez a prim (your kiosk/sign) and name it whatever you like.
2. Create a new script inside it, paste the contents of
   `sinful-newsletter.lsl`, and save.
3. Optionally edit the config at the top of the script:
   - `ADMIN_CHANNEL` — chat command channel (default `9`, i.e. type `/9 help`)
   - `NEWSLETTER_NAME` — shown in IMs and dialogs
4. Drop the notecards, landmarks, and objects you want to send into the prim's
   inventory. **Items must be copy + transfer** — the script refuses no-copy
   items so they can't be accidentally given away.

## Admin usage (owner only)

**Touch the object** for the menu UI:

- **Subscribers** — paginated list; tap a number to remove someone; `+ Add`
  opens a text box where you paste a UUID (`4eebe02d-2827-...`) or a legacy
  name (`Lelouch Resident`).
- **Events** — `+ New` walks you through: name → message → item selection
  (tap numbers to toggle `[X]` marks). Each event's menu has:
  - `Send All` — blast to every subscriber (with confirmation)
  - `Send One` — deliver this event to a single UUID/name (great for people
    who joined after it originally went out)
  - `Edit Msg`, `Items`, `Delete`
- **Status** — subscriber/event counts, LinksetData and script memory free.

**Chat commands** on `/9` (faster for bulk work):

```
/9 help
/9 add Lelouch Resident
/9 add 4eebe02d-2827-4f71-a25d-d6eed9486a10
/9 remove Lelouch Resident
/9 list
/9 send Weekend Party
/9 sendto Lelouch Resident | Weekend Party
/9 backup
/9 restore
/9 status
/9 menu
```

## Subscriber experience

Anyone who touches the object gets a **Subscribe / Unsubscribe** dialog.
When you send an event, each subscriber receives:

1. An IM: `Sinful Newsletter — <event name>` + your message
2. A folder (named after the event) containing all attached items

## Backup, restore, and moving to another prim

LinksetData lives on the **object**, not the script — so resets, script swaps,
re-rezzing, and copies all keep your data automatically. You only need the
backup flow for disaster recovery (object deleted) or moving to an unrelated prim:

1. `/9 backup` — the script dumps `uuid,name` lines to your chat.
2. Copy those lines into a notecard named exactly `backup`.
3. Keep it in your inventory. To restore/migrate: drop the notecard (and the
   script) into the target prim and run `/9 restore`.

Run a backup occasionally — it's your safety net if the object itself is lost.

## Delivery speed and limitations

- LSL throttles (`llInstantMessage` 2 s + `llGiveInventoryList` 3 s) mean
  **~5 seconds per subscriber**. A 300-person blast takes ~25 minutes; it runs
  unattended with progress reports every 25 and a summary at the end.
- Offline subscribers whose IMs are capped may miss the delivery — this is a
  Second Life limitation and applies equally to group notices.
- Don't add/remove subscribers *during* a blast; changes mid-send can cause a
  recipient to be skipped or hit twice (pagination is index-based).
- Event messages are capped at 800 characters (IM limit safety).

## In-world test checklist

After installing, verify:

- [ ] `/9 status` responds; touch opens the main menu
- [ ] `add` by legacy name and by UUID both resolve and appear in `list`
- [ ] Non-owner (alt) touch → Subscribe works; touch again → Unsubscribe
- [ ] Create an event, attach a notecard + landmark, `Send One` to your alt:
      alt receives IM + folder with both items
- [ ] Reset the script (`/9 reset`) — subscribers and events still there
- [ ] `backup` dump → paste to notecard `backup` → drop in a fresh prim with
      the script → `restore` → `list` matches
- [ ] No-copy item is refused at attach time with a warning
