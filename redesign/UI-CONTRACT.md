# DOM contract

`app.js` finds elements by **id**, by **data-attribute**, and in a few
places by **class**. Restyle freely; rearrange freely; but keep these
hooks or the app breaks when the redesign is merged back.

Rule of thumb: **ids and `data-*` attributes are API. Class names are
yours**, except the handful marked ⚠ below, which JavaScript toggles or
queries.

## Ids that must survive

**Shell / auth**
`view-login`, `login-form`, `login-password`, `login-error`, `view-app`,
`btn-logout`, `kiosk-pill`, `kiosk-pill-text`, `toasts`

**Tabs** — three panes toggled by `.tab[data-tab]` buttons:
`tab-packages`, `tab-subscribers`, `tab-calendar`

**Packages**
`package-list`, `packages-empty`, `btn-new-package`, `upcoming`

**Package editor**
`editor-overlay`, `editor-title`, `pkg-name`, `pkg-message`,
`pkg-msg-count`, `pkg-pickup` (+ `pkg-pickup-toggle`, `pkg-pickup-panel`, `pkg-pickup-summary`), `pkg-pickup-hint`, `pkg-oo`, `pkg-kiosk-warn`,
`attached-list`, `attach-count`, `attach-filter`, `attach-search`,
`attach-avail`, `btn-pkg-cancel`, `btn-pkg-save`

**Subscribers**
`sub-count`, `list-chips`, `sub-add-input`, `btn-sub-add`,
`btn-refresh-disp`, `sub-search`, `pending-lookups`, `bulk-bar`,
`bulk-count`, `sel-all`, `sub-rows`

**Modals**
`member-overlay`, `member-title`, `member-checks`, `btn-member-close`;
`sendone-overlay`, `sendone-title`, `sendone-search`, `sendone-results`,
`btn-sendone-cancel`; `bulklist-overlay`, `bulklist-title`,
`bulklist-select`, `btn-bulklist-cancel`, `btn-bulklist-go`;
`sendlist-overlay`, `sendlist-title`, `sendlist-checks`,
`btn-sendlist-cancel`, `btn-sendlist-go`; `log-overlay`, `log-title`,
`log-stats`, `log-audiences`, `log-rows`, `btn-log-refresh`,
`btn-log-close`; `schedule-overlay`, `schedule-title`, `schedule-dt`,
`schedule-slt`, `schedule-list`, `btn-schedule-cancel`,
`btn-schedule-save`; `confirm-overlay`, `confirm-text`,
`btn-confirm-yes`, `btn-confirm-no`

**Calendar**
`cal-title`, `cal-grid`, `cal-prev`, `cal-next`, `cal-today`

## Data attributes (event delegation — keep on clickable elements)

| Attribute | Where |
|---|---|
| `data-tab` | tab buttons |
| `data-act` | package card buttons: `sendmenu`, `send`, `sendlist`, `test`, `schedule`, `log`, `edit`, `delete`; subscriber row buttons: `lists`, `shadow`, `remove`, `toggle` (checkbox) |
| `data-id` | on `.pkg-card`, the package id |
| `data-uuid` | on subscriber `<tr>` |
| `data-list` / `data-newlist` / `data-dellist` | list chips |
| `data-list-id` | membership checkboxes |
| `data-send-list` | send-to-list checkboxes |
| `data-pickup` | package editor's Get-Latest pickup checkboxes (`0` = everyone, otherwise a list id) |
| `data-attach-cat` / `data-attach-back` / `data-additem` / `data-detach` | attachment picker |
| `data-sendone-uuid` | send-to-one results |
| `data-bulk` | bulk bar buttons: `addlist`, `removelist`, `activate`, `deactivate`, `shadowban`, `unshadowban`, `delete`, `clear` |
| `data-redeliver` | delivery log rows |
| `data-relist` / `data-relist-oo` | log audience rows |
| `data-sid` | upcoming/calendar schedule entries |

## ⚠ Classes JavaScript depends on

- `hidden` — **the universal show/hide.** Must remain `display: none`.
- `.tab` + `active`, `.list-chip` + `active`, `.filter-chip` + `active`
- `.pkg-card`, `.drop-menu`, `.dropdown`, `.audience-row`,
  `.attached-row`, `.item-check`/`checked`, `.row-sel`, `.upcoming-item`,
  `.cal-chip` + `pending`, `.member-checks input`
- `.toast` + `ok`/`err` — created dynamically by `toast()`
- `.inactive-row` on deactivated subscriber rows
- Status text classes in the log: `st-sent`, `st-pending`, `st-skip`,
  `st-failed`

## Structural expectations

- Subscriber rows: **column order matters** — JS reads
  `td:nth-child(2)` etc. in a few places. Columns are:
  checkbox · Display Name · Legacy Name · UUID · Lists · Source · Active · actions.
- Modals are toggled by adding/removing `hidden` on the `*-overlay`
  element; the overlay is expected to cover the viewport.
- `.drop-menu` sits inside `.dropdown` (`position: relative`) and is
  shown/hidden by the `hidden` class.

If you need to change any of the above, note it in your handback and the
matching JS can be adjusted — just don't change it silently.
