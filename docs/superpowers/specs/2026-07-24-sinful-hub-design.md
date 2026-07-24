# Sinful Newsletter Hub — v2 Design

**Date:** 2026-07-24
**Status:** Architect's choice build (user delegated architecture decisions)

## Goal

Same product as v1 (group-style notices without a group) but built the way I'd
build it for myself: web-based composing and management, delivery logging,
redelivery as a first-class feature, and "packages" — named bundles of a
message plus attachments (landmarks, objects, notecards) delivered as a folder.

## Architecture

```
┌─────────────────────┐        HTTPS/HTTP        ┌──────────────────────┐
│  Web Admin (browser)│ ◄──────────────────────► │  Hub server (Node)   │
│  compose packages,  │        JSON API          │  Express + node:sqlite│
│  manage subscribers │                          │  source of truth     │
└─────────────────────┘                          └──────────┬───────────┘
                                                            │ push ping (HTTP-in)
                                                            │ pull work (llHTTPRequest)
                                                 ┌──────────▼───────────┐
                                                 │  Kiosk (LSL, 1 prim) │
                                                 │  signups, lookups,   │
                                                 │  ALL item delivery,  │
                                                 │  LinksetData cache   │
                                                 └──────────────────────┘
```

**Why this split:** only an in-world object can hand out inventory, and only a
web page makes composing pleasant. The server owns the data; the kiosk is a
resilient delivery agent that keeps core functions (signup, "Get latest")
working from its LinksetData cache even when the server is unreachable.

## Server

- Node ≥ 22.5 (built-in `node:sqlite`), Express is the only npm dependency.
- SQLite in WAL mode with `wal_autocheckpoint` set (lesson learned).
- Config via `.env`: `PORT`, `ADMIN_PASSWORD`, `KIOSK_TOKEN`, optional `DB_PATH`.
- Admin auth: password login → signed HMAC cookie (8 h expiry), login rate-limited.
- Kiosk auth: `X-Kiosk-Token` header, constant-time compare.

### Schema

- `subscribers(uuid PK, name, active, source, created_at)`
- `packages(id, name, message, items JSON, created_at, updated_at)` — items are
  kiosk inventory names
- `deliveries(id, package_id, uuid, status queued|inflight|sent|failed, queued_at, sent_at)`
- `lookups(id, kind name2key|key2name, query, status pending|done|notfound)` —
  avatar name resolution is delegated to the kiosk (`llRequestUserKey` /
  `llRequestAgentData`); there is no official off-world name API
- `kiosk(id=1, url, last_seen, inventory JSON)` — single kiosk in v2

### API (all `/api`)

Admin (cookie): `login`, `logout`, `overview`, `subscribers` CRUD+search,
`packages` CRUD, `packages/:id/send` (enqueue all active), `packages/:id/sendto`,
`deliveries?package_id` (stats + recent), `kiosk` (status + inventory).

Kiosk (token):
- `POST /kiosk/hello {url, inventory}` → `{latest package, queued count}` —
  registration + heartbeat + inventory report; kiosk caches latest package in
  LinksetData
- `GET /kiosk/work` → batch of pending lookups + up to 3 queued deliveries
  (marked inflight; stale inflight >10 min is requeued automatically)
- `POST /kiosk/report` → lookup results and delivery outcomes
- `POST /kiosk/event` → subscribe/unsubscribe from in-world touches
- `GET /kiosk/latest?uuid=&name=` → latest package for redelivery (logged)

Push: when work is created the server POSTs "work" to the kiosk's HTTP-in URL
(instant reaction); the kiosk also polls on a heartbeat as fallback, since
kiosk URLs die on region restart.

## Kiosk (LSL)

- Registers `llRequestURL` on rez/region-restart; `hello` on grant and every
  5 min heartbeat; re-reports inventory on `CHANGED_INVENTORY` (with per-item
  copy+transfer flags so the web UI can grey out undeliverable items).
- Work loop: fetch batch → deliver one per timer tick (`llInstantMessage` +
  `llGiveInventoryList`, ~5 s each) → report → fetch again until drained.
- Non-owner touch → Subscribe / Get Latest / Unsubscribe dialog.
- Resilience: sub/unsub events that fail to POST are queued in LinksetData and
  flushed on next successful hello; "Get latest" falls back to the cached
  package when the server is down.
- Owner touch → Status / Sync dialog (all real admin happens on the web).

## Web admin UI

Single page, vanilla JS, no build step, served by the same Express app.
- **Packages** (primary tab): card list with per-package sent/queued/failed
  stats; composer with name, message textarea, and an attachment checklist
  sourced from the kiosk's actual reported inventory (non-copy+transfer items
  disabled with an explanation; empty state explains "drop items into the
  kiosk"). Send-to-all with confirmation showing recipient count; test-send to
  one UUID/name; live progress while a blast runs.
- **Subscribers**: add by UUID or legacy name (name goes through kiosk lookup,
  shown as pending until resolved), search, active toggle, remove, count.
- Header shows kiosk online/offline (last_seen < 12 min) at all times.

## Error handling

- Every kiosk endpoint tolerant of retries (reports are idempotent updates).
- Deliveries for items missing from kiosk inventory at send time: kiosk skips
  missing items but still delivers message + remaining items.
- Server down: kiosk keeps signups (outbox) and redelivery (cache) working.
- Kiosk down: admin UI still fully works; sends queue up and drain when the
  kiosk returns.

## Out of scope (deliberate)

- Multiple kiosks (schema allows later; v2 registers one)
- Scheduled sends, per-subscriber delivery history UI (log table exists)
- HTTPS termination (run behind a reverse proxy if exposed publicly)
