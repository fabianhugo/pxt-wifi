# Changelog

All notable changes to the WiFi Access Point dashboard are documented here.

## [Unreleased]

This work began from a dashboard that re-sent **all 100 most-recent log rows on
every 2-second poll** and evolved into an incremental (diff) streaming dashboard
with bidirectional controls, wall-clock sync, and a number of stability fixes.

> **File scope.** `main.ts` and `testprj/wifi.ts` are now byte-identical: every
> feature and stability fix below (diff streaming, timestamp sync, control
> piggybacking, the per-poll cap, regression guard, watchdog re-fire,
> `CIPSERVERMAXCONN=5`, the "Empfangene Pakete" field, and the slider fix) is
> present in both.

### Added — multiple sensor nodes (push to hub)

Several Calliope+WiFi minis can now feed one hub dashboard. Each **node** joins
the hub's WiFi in station mode (`WiFi.setupWifi` / "Setup Wifi") and pushes a row
of readings; the **hub** logs each pushed row (tagged with the node name) and the
dashboard draws **one chart line per node**. The hub stays the only server; nodes
are plain short-lived HTTP clients (`GET /push?node=B&temp=..&light=..`).

- **Hub: `/push` ingest route.** Parses `key=value` pairs from the query into
  datalogger columns and logs them (`datalogger.logData`). `node=` identifies the
  sender. The hub's `setColumnTitles` must include `"node"` + the sensor names.
- **Node: `WiFi.pushToHub(node, ...createCV)` block** (group *Sensor Node*), plus
  `WiFi.setHubAddress(host)` (default `4.3.2.1`). Mirrors the `datalogger.log`
  block — same `createCV` slots. Opens a TCP connection, sends the row, closes it
  (so it never holds one of the hub's connection slots). Percent-encodes values.
- **Dashboard groups by node.** When a `node` column is present the table becomes
  *Node × sensors* (latest per node) and each sensor gets a multi-series chart
  with a coloured legend. With **no** `node` column the dashboard is byte-for-byte
  the original single-source layout (zero change / zero regression risk).
- **Download is unchanged:** "Als CSV herunterladen" gives the hub's combined
  session log (all nodes interleaved). Each node's *complete* full-resolution log
  remains available losslessly over **USB** (`MY_DATA.HTM`) — the hub's flash is a
  bounded session view, not the master archive (it fills ~N× faster with N nodes).

Example **node** program (a second mini called "B"):

```ts
// Join the hub's WiFi (station mode). SSID must match the hub's AP.
WiFi.setupWifi(SerialPin.C17, SerialPin.C16, BaudRate.BaudRate115200, "CalliopeHub", "")
WiFi.setHubAddress("4.3.2.1")
datalogger.setColumnTitles("temp", "light", "sound")   // node's own local log
basic.forever(function () {
    datalogger.log(                                    // keep a full local log (USB download)
        datalogger.createCV("temp", input.temperature()),
        datalogger.createCV("light", input.lightLevel()),
        datalogger.createCV("sound", input.soundLevel())
    )
    WiFi.pushToHub("B",                                // ...and push the same row to the hub
        datalogger.createCV("temp", input.temperature()),
        datalogger.createCV("light", input.lightLevel()),
        datalogger.createCV("sound", input.soundLevel())
    )
    basic.pause(2000)
})
```

> **Stability note.** Each push is connection open→send→close churn — the exact
> load the hub's stability work fights. A handful of nodes pushing every ~2 s is
> fine; many nodes pushing fast increases module heap pressure and reboot risk.
> If crashes increase, slow the node push interval before anything else.

- **Fixed error 022 (`GC_TOO_BIG_ALLOCATION`) on every page load.** The multi-node
  UI grew the dashboard page from ~9.1 KB to ~12.7 KB (+~40%), and assembling it
  as one string no longer fit a single contiguous free block on the fragmented
  heap — so it failed while *building* the page, before it could be sent. Fix: the
  page is now stored as ~190 small string segments (largest ~180 B) and **never
  concatenated into one big string**; `servePage` streams the segments in
  ≤CHUNK packets, so total page size no longer matters for this error class.
  Likewise `/log.csv` streams in 20-row batches (two passes: measure length, then
  send) instead of materialising the whole log at once. Headers are sent as their
  own packet so no response ever allocates a full-size duplicate.

### Added

- **"Empfangene Pakete" field.** A line under the table shows the total number of
  rows recorded on the device. (It used to be a table row; it moved to its own
  line so the table can be freely rebuilt in multi-node mode.) The count rides on
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
