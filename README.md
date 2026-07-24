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

### 1. Server

```bash
cd server
cp .env.example .env    # then EDIT .env: set ADMIN_PASSWORD and KIOSK_TOKEN
npm install
npm start               # http://localhost:8710
```

Expose the port to the internet (port forward, VPS, or reverse proxy —
Second Life's simulators must be able to reach it). HTTPS via a reverse
proxy is recommended if exposed publicly.

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
- Server: Express + built-in `node:sqlite` (WAL mode), no other dependencies.
  DB file: `server/data/newsletter.db` (gitignored).
- Admin UI: vanilla JS single page in `server/public/`, no build step.
- Smoke test: start the server, then exercise `/api/*` — see the curl
  sequence in the design doc's API section for the expected flow
  (login → add subscriber → kiosk hello/work/report → send → stats).
