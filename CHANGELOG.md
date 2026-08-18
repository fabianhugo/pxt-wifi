# Changelog

All notable changes to the WiFi Access Point dashboard are documented here.

## [Unreleased]

This work began from a dashboard that re-sent **all 100 most-recent log rows on
every 2-second poll** and evolved into an incremental (diff) streaming dashboard
with bidirectional controls, wall-clock sync, and a number of stability fixes.

> **File scope.** `main.ts` and `testprj/wifi.ts` are byte-identical: every
> feature and stability fix below (diff streaming, timestamp sync, control
> piggybacking, the per-poll cap, regression guard, watchdog re-fire,
> `CIPSERVERMAXCONN=5`, the "Empfangene Pakete" field, and the slider fix) is
> present in both.

### Removed — multiple sensor nodes (push to hub)

The multi-node experiment (`7e14cb4`) was **reverted** on 2026-08-18; the driver
is back to the single-source dashboard, based on `testprj/wifi.ts` as of
`2242023`. Removed: the `WiFi.pushToHub` / `WiFi.setHubAddress` blocks and the
"Sensor Node" group, the push diagnostics (`pushStatus`, `lastResponse`), the
hub-side `/push` ingest route, and the node-aware dashboard (per-node table
grouping and multi-series charts).

Also reverted with it: the **page-segmentation rewrite**. It existed to fix error
022 (`GC_TOO_BIG_ALLOCATION`), which the multi-node UI had *caused* by growing the
page ~9.1 KB → ~12.7 KB; with the node UI gone the page is back to ~9.3 KB and is
served again as one cached string (`pageHtml`). The `/push` example program and
the boot-time `datalogger.deleteLog()` (a multi-node schema workaround) are gone
from `testprj/main.ts` too.

**Kept from the multi-node branch** (independent of nodes, so reapplied on top of
`2242023`):

- **Cold-boot AT handshake retry.** `setupWifi` polls `AT` for up to ~12 s instead
  of once, so a module still booting alongside the Calliope doesn't swallow the
  first commands (including the join).
- **`AT+CWJAP` join retry** (3 attempts) — the first join can fail even after `AT`
  answers.
- **mDNS advertisement** (`AT+MDNS=1,"calliope","_http",80`, set after the SoftAP
  IP) so the dashboard is reachable as `calliope.local` on clients that resolve
  `.local`. `4.3.2.1` stays the fallback.
- **`X-Total-Rows` header + "Empfangene Pakete" field** — the device's true row
  total, independent of the client's diff cursor, so it stays correct while a
  client is catching up.
- **Sliders start at 0** (`value="0"`) instead of the browser's midpoint default.
- **`/log.csv` streamed in 20-row batches** (two passes: measure `Content-Length`,
  then send) rather than materialising the whole log as one string — general
  protection for large downloads on a fragmented heap. Verified byte-identical to
  the previous output at every batch boundary.
- **`CIPSERVERMAXCONN=5` and the re-firing idle watchdog**, which `testprj/wifi.ts`
  already had at `2242023` but `main.ts` did not — `main.ts` now has both.

### Added

- **"Empfangene Pakete" field.** A line under the table shows the total number of
  rows recorded on the device. (It used to be a table row; it moved to its own
  line below the table.) The count rides on
  the regular `/data` poll via a new `X-Total-Rows` response header (the device's
  true total, independent of the client's diff cursor), so it stays correct even
  while a client is catching up.
- **Incremental ("diff") data streaming.** `/data` now accepts a `?from=N` query
  param and returns only the rows the client has not yet seen, plus an
  `X-Row-Count` response header telling the client its new cursor. The first poll
  (no `from`) seeds the chart with a window of recent rows. The browser
  accumulates rows in a buffer and advances `offset` from `X-Row-Count`, so
  steady-state polls transfer ~1 row instead of 100.
- **`WiFi.timestamp()` block** — returns the current wall-clock time as a Unix
  timestamp (whole seconds). The browser piggybacks its clock (`&t=<unix s>`) on
  every `/data` poll; the device records it alongside `input.runningTime()` and
  reconstructs the current time, re-synced each poll (drift bounded by the poll
  interval). Returns `0` until a browser has connected. Intended for use with
  `datalogger.setTimestamp(Timestamp.None)` and logging the value as a column.
- **Dashboard controls piggybacked on `/data`.** Toggle/slider state now rides on
  the regular poll (`&tA=..&sA=..`) instead of a separate request.
- **Per-poll row cap** (`MAX_ROWS_PER_POLL = 50`). A client that fell behind
  catches up over several bounded polls rather than pulling one large burst.
  `X-Row-Count` reports the client's new cursor (start + rows actually sent), so
  no rows are skipped when a response is capped. *(testprj/wifi.ts)*
- **Client-side regression guard.** If `X-Row-Count` goes backwards (the device
  restarted/reset its log), the client drops its now-stale buffer and reseeds on
  the next poll instead of following the count downward into garbage.
  *(testprj/wifi.ts)*
- **CSV download serialization.** Pressing "Als CSV herunterladen" now pauses
  polling, waits for any in-flight poll to finish, fetches the full `/log.csv`
  with exclusive use of the socket, then resumes polling (catching up via the
  diff). Includes a 30 s abort and status feedback. *(testprj/wifi.ts)*
- **Per-poll debug logging** in the browser console:
  `poll: X-Row-Count=.. neueZeilen=.. offset=.. puffer=..`. *(testprj/wifi.ts)*

### Changed

- **Removed the `/set` control endpoint.** Controls are folded into `/data`, so
  the single-fiber/single-socket server only ever has one request type in flight.
- **Initial seed reduced 100 → 50 rows** (`SEED_ROWS = 50`) for a faster first
  paint. *(testprj/wifi.ts)*
- **Initial status text** "Verbinde..." → "warte auf Daten...". *(testprj/wifi.ts)*
- **Polling made resilient**: a 5 s `AbortController` timeout per `/data` poll so
  a stalled socket recovers in seconds (instead of a tens-of-seconds freeze), and
  a single-flight `inflight` guard. The earlier `pending` re-fire was removed
  (live control state rides every poll, so nothing is lost). *(testprj/wifi.ts)*
- **Idle watchdog now re-fires.** `webWatchdog()` re-issues `AT+CIPCLOSE=5` every
  idle period (was once per episode) until a browser connects again — fixes
  "can't reconnect after closing the dashboard". The one-shot `webRecovered` flag
  was removed. *(testprj/wifi.ts)*
- **Max simultaneous connections raised 2 → 5** (`AT+CIPSERVERMAXCONN=5`, the AT
  firmware maximum) so extra/backup or stale sockets can't exhaust the slots.
  *(testprj/wifi.ts)*

### Fixed

- **Sliders started in the middle.** The `Regler A/B/C` range inputs had no
  `value` attribute, so browsers defaulted the thumb to the midpoint (50) while
  the displayed value and the device-side state were 0. Added `value="0"` so the
  thumb starts at the left, matching the 0 it reports.
- **Dashboard freeze when flipping a toggle.** The old separate `/set` request
  collided with the concurrent `/data` poll in the single-fiber server's RX
  buffer, mangling the parse and hanging the page. Folding controls into `/data`
  removes the concurrency entirely.
- **Frozen sensor values while polls kept succeeding.** `drainIdle()` was a tight
  busy-loop with no yield; running before every response, it starved the user's
  `datalogger.log()` fiber so no new rows were logged. Added `basic.pause(5)` so
  other fibers keep running. *(testprj/wifi.ts)*
- **Unreliable / failing CSV download.** Was a second concurrent connection that
  the single-fiber server couldn't serve (`ERR_EMPTY_RESPONSE` /
  `ERR_CONNECTION_REFUSED`); now serialized with polling. *(testprj/wifi.ts)*

### Ported to main.ts

All of the stability fixes have now been ported, so `main.ts` ≡ `testprj/wifi.ts`:
`SEED_ROWS = 50` + "warte auf Daten..." text, the 5 s poll `AbortController`,
`drainIdle()` yield, CSV download serialization, `MAX_ROWS_PER_POLL` + client
regression guard, watchdog re-fire (`webRecovered` removed), and
`AT+CIPSERVERMAXCONN=5`. The per-poll `console.log` debug line was kept.

### Known issues / notes

- Intermittent device crashes/reboots remain (seen as a non-monotonic
  `X-Row-Count`, e.g. `67 → 37 → 67`). These originate at the module/Calliope
  level under sustained connection churn and can't be fully prevented from the
  TypeScript driver; the changes above make the client and server **recover**
  gracefully rather than wedge.
- Raising `CIPSERVERMAXCONN` to 5 increases module heap pressure; if crashes get
  *more* frequent, the bottleneck is module memory, not slot count.
- The example program (`testprj/main.ts`) only calls `datalogger.deleteLog()` on
  the A+B button, so the log persists and grows across runs/reboots. Add a
  startup `deleteLog()` unless cross-run history is wanted.
