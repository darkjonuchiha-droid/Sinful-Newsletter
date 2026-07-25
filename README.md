# Sinful Newsletter

A Second Life newsletter system that works like group Notices — announcement +
attached items — but **without a group**: no group slot used, no join required.

Two flavors live in this repo:

| | **Hub** (v2, recommended) | **Standalone** (v1) |
|---|---|---|
| Compose & manage | Web dashboard in your browser | Dialogs + chat commands in-world |
| Storage | SQLite on your server | LinksetData on the prim |
| Capacity | Unlimited | ~1,500 subscribers |
| Delivery log / redelivery | Yes — "Get Latest" button + audit log | Manual `sendto` only |
| Requirements | A machine running Node.js ≥ 22.5 | Nothing |
| Code | `server/` + `kiosk/sinful-kiosk.lsl` | `standalone/sinful-newsletter.lsl` |

Both deliver **packages**: an IM message plus a folder of attachments
(landmarks, notecards, objects — anything copy+transfer).

---

## Hub setup (v2)

### 1. Server — pick a deployment style

The hub picks its database automatically: if `DATABASE_URL` is set it uses
**Postgres**; otherwise it uses **embedded SQLite** (a single local file).
Same code, both tested.

**Option A — free cloud (GitHub + Vercel + Neon), recommended:**

1. Push this repo to GitHub.
2. On [vercel.com](https://vercel.com): *New Project* → import the repo →
   set **Root Directory** to `server`.
3. In the project's *Storage* tab, add the **Neon** (Postgres) integration —
   it sets `DATABASE_URL` automatically. Free tiers of both are far more
   than this app needs.
4. In *Settings → Environment Variables*, add `ADMIN_PASSWORD` and
   `KIOSK_TOKEN` (long random strings).
5. Deploy. Your hub is at `https://<project>.vercel.app` — HTTPS, no port
   forwarding, no machine to keep on. Every `git push` redeploys.

**Option B — self-hosted (your own PC or a VPS):**

```bash
cd server
cp .env.example .env    # then EDIT .env: set ADMIN_PASSWORD and KIOSK_TOKEN
npm install
npm start               # http://localhost:8710  (SQLite in server/data/)
```

Expose the port to the internet (port forward + dynamic DNS, reverse proxy,
or a Cloudflare Tunnel — Second Life's simulators must be able to reach it).
You can also point a self-hosted install at Postgres by setting
`DATABASE_URL` in `.env`.

### 2. Kiosk

1. Rez a prim in-world; drop [kiosk/sinful-kiosk.lsl](kiosk/sinful-kiosk.lsl)
   into it.
2. Edit the config at the top: `SERVER_URL` (your server's public address)
   and `TOKEN` (must equal `KIOSK_TOKEN` from `.env`).
3. Drop the items you want to send into the same prim. **Copy + transfer
   only** — others are refused and greyed out in the web UI.

The kiosk announces itself to the server; the dashboard's status pill turns
green ("kiosk online").

### 3. Use it

Open the dashboard, log in, and:

- **Subscribers** — add by UUID or legacy name (`Lelouch Resident`). Name
  lookups are performed in-world by the kiosk (SL has no public name API) and
  appear as ⏳ chips until resolved. Search, deactivate (pause without
  deleting), or remove.
- **Packages** — create with a name (becomes the received folder's name), a
  message (≤ 800 chars, IM limit), and attachments ticked from the kiosk's
  actual inventory. *Send to all* queues a delivery per active subscriber;
  progress is shown live on the card. *Send to one…* delivers to a single
  UUID/name — perfect for people who joined late.
- Residents touch the kiosk to **Subscribe / Unsubscribe / Get Latest**
  (self-service redelivery of the newest package).
- **Lists** (audience segments): create them on the Subscribers tab
  (`+ New list` chip, names ≤ 20 chars — they double as kiosk dialog
  buttons). Filter the table by list, and edit any subscriber's
  memberships via the `…` button in their row. Packages then offer
  **Send to list…** next to Send to all, and scheduling lets you pick
  All subscribers or a list. When lists exist, the kiosk's Subscribe
  dialog asks new subscribers which newsletter they want ("Everything"
  or a specific list).
- **Program sends ahead of time**: each package card has *Schedule…* — pick
  a date and time (shown in your local time **and SLT**), e.g. compose the
  newsletter on Tuesday, program delivery for Thursday 8pm. Programmed sends
  appear in an *Upcoming* strip (cancellable) and on the **Calendar** tab, a
  month view of programmed and past sends. Firing is driven by the kiosk's
  5-minute heartbeat (plus a 60 s timer when self-hosted, and the dashboard
  itself), so scheduling works on every deployment including Vercel's free
  tier — expect delivery to start within ~5 minutes of the programmed time.

### Satellite kiosks (signup points anywhere on the grid)

Rez [kiosk/sinful-satellite.lsl](kiosk/sinful-satellite.lsl) in a prim
anywhere — other parcels, other sims. Satellites offer Subscribe /
Unsubscribe / Get Latest only; run exactly ONE primary kiosk (it does all
deliveries). Configure each satellite's `LABEL` (signups show it as their
source in the dashboard) and optionally pin `LIST_NAME` so subscribing
there auto-joins that list (e.g. a "Beach Events" board at the beach —
leave `""` for the normal list picker). "Get Latest" at a satellite is
relayed: the primary kiosk delivers the package cross-region within
moments. The dashboard pill shows satellite status ("kiosk online · 2/2
sat"; hover for details per satellite).

### Invitation HUDs (the intended workflow for events)

Instead of sending loose items, send **one invitation object** that
recipients wear and open — like a sealed envelope:

1. Build a prim styled as your invitation (envelope, ticket, rose…).
2. Drop into it: [kiosk/invitation-hud.lsl](kiosk/invitation-hud.lsl) plus
   the contents — notecard, landmark, gifts. Make the contents **copy** so
   the invite can be re-opened.
3. Configure the top of the script if you like: event region + position
   (opening then also pops the world map at the venue), auto-detach on/off.
4. Name the object (that name becomes the folder recipients get), take it,
   drop it into the **kiosk prim**, and attach it to a package in the
   dashboard — just that one object.
5. Send. Subscribers receive the invitation; when they attach it as a HUD
   it asks *"Open it now?"* — opening delivers the folder with everything
   inside, shows the map to the venue, and (by default) removes itself.

Tip: put a line like "Wear the enclosed invitation and touch it!" in the
package message, since it arrives like any object.

### Resilience model

- **Server down:** kiosk keeps accepting signups (queued in LinksetData,
  flushed on reconnect) and keeps serving "Get Latest" from its cached copy.
- **Kiosk down:** dashboard fully usable; sends queue on the server and drain
  automatically when the kiosk reconnects (deliveries claimed but never
  confirmed are re-queued after 10 minutes).
- **Kiosk script reset / re-rez / region restart:** re-registers itself
  automatically; nothing is lost (all data lives on the server).

### Speed & SL limitations

- LSL throttles mean ~5 s per delivery (~12/min). A 300-person blast takes
  ~25 min; it runs unattended and the card shows live progress.
- Offline recipients with capped IMs can miss deliveries — an SL limitation
  shared with group notices. That's what "Get Latest" is for.

---

## Standalone setup (v1)

No server: one prim, one script, dialog/chat admin, notecard backup.
See [standalone/sinful-newsletter.lsl](standalone/sinful-newsletter.lsl) —
usage instructions are in the script header and the design doc under
`docs/superpowers/specs/`.

---

## Development

- Design docs: `docs/superpowers/specs/`
- Server: Express + a storage layer (`server/src/storage.js`) with two
  drivers — built-in `node:sqlite` (WAL mode) or Postgres via `pg`, chosen
  by `DATABASE_URL`. Local SQLite file: `server/data/newsletter.db`
  (gitignored). Vercel entry: `server/api/index.js` + `server/vercel.json`.
- Admin UI: vanilla JS single page in `server/public/`, no build step.
- Smoke test: start the server, then exercise `/api/*` — see the curl
  sequence in the design doc's API section for the expected flow
  (login → add subscriber → kiosk hello/work/report → send → stats).
