# Internet clock blocks — notes & decisions

`WiFi.internetTimestamp()` (Unix s) and `WiFi.internetTime(TimeUnit)`
(year/month/day/hour/minute/second). Group *UartWiFi*.

## 2026-08-19 — why the blocks returned 0, and the fixes

The user reported both blocks showing 0 on hardware. Three separate causes were
found; two were bugs in this code.

### 1. `isWifiConnected` guard blocked everything (root cause)

`fetchNetTime` started with `if (!isWifiConnected) return`. That flag is set
**only** by `setupWifi` (station mode, `AT+CWMODE=1`). Anyone running the access
point program never sets it, so the fetch returned immediately and both blocks
reported 0 without a single AT command being sent. **Guard removed** — the fetch
now just attempts the connection and reports failure honestly.

### 2. Double offset in `parseHttpDate` (would have broken it anyway)

While fixing a decoy-header issue I introduced `findDateHeader()`, which returns
an index *already past* `"Date: "`. `parseHttpDate` then added `+ 6` a second
time, so it read 6 characters into the date string and every parse failed. Caught
by the host-side harness, not by inspection. Now `resp.substr(i, 26)`.

### 3. `AT+CWMODE=2` is AP-only — no uplink exists

The AP setup uses `AT+CWMODE=2` (SoftAP only). In that mode the module has no
station connection, so it cannot reach any internet host no matter what this code
does. Reaching the internet **while** serving the dashboard would need
`AT+CWMODE=3` (AP+STA) plus a `CWJAP` join to a real router. Not changed — the
user confirmed AP mode works as-is and is out of scope. **So: these blocks
require station mode (`Setup Wifi`).**

### Decision: host changed off Google

The user could not open `google.com/generate_204` and asked for a FOSS-friendlier
source. Probed candidates on 2026-08-19:

| host | result |
| --- | --- |
| `detectportal.firefox.com/success.txt` | 200, 8-byte body — **chosen primary** |
| `example.com` | 200, 0-byte body, IANA-reserved — **chosen fallback** |
| `deb.debian.org`, `ftp.debian.org`, `archive.ubuntu.com` | 200, but 1.8 KB body |
| `neverssl.com`, `nav.debian.org` | no response at all |

Mozilla's captive-portal endpoint is purpose-built for unauthenticated probes,
plain HTTP (the module can't do HTTPS here), and tiny. Two hosts are now tried in
order so one retired/blocked endpoint doesn't kill the feature.

### Other fixes in this pass

- **Line-anchored `Date:` match.** `indexOf("Date: ")` also matches
  `X-Origin-Date: `, `X-Firefox-Date: ` etc. If such a header precedes the real
  one, the old code returned *that* (wrong) time. `findDateHeader` now only
  accepts a match at the start of a line.
- **`CIPMUX` restored.** The fetch forces `CIPMUX=0` for the client request; if
  `serverRunning` it now restores `CIPMUX=1` afterwards, so a running dashboard
  server isn't left in single-connection mode.
- Connect/read timeouts raised 6 s → 8 s for slower DNS.

### Verification (host-side; NOT on hardware)

Functions extracted, type-stripped, run under node against a stubbed AT module:

- **608 date cases** vs Python `datetime` (leap years, 2100, epoch, 2038,
  600 random 1971–2099), all six fields each.
- `+IPD`-framed replies, replies arriving in fragments (0 until complete),
  decoy-header-only (→ 0), bad month, empty.
- Fetch path: primary host success (one CIPSTART only), fallback used when
  primary is dead, both dead → 0, caching (no refetch, clock advances locally),
  `CIPMUX=1` restored when the server runs, `CIPCLOSE` on every exit path.

**Still unverified on hardware:** that `serial.readString()` surfaces the `+IPD`
response body/headers in this driver's setup. That is the remaining assumption if
the blocks still read 0 after switching to station mode.

## Earlier: "Internet OK?" block

`internetOk()` / `internetOkHost(host)` — tries `AT+PING`, falls back to a TCP
connect on port 80 because not all ESP-AT builds ship `AT+PING` (ERROR is
ambiguous between "unsupported" and "unreachable"). Also forces `CIPMUX=0` and
always closes its socket.

## 2026-08-19 (later) — simplified: one network operation

The user reported the blocks still showing 0, and often the display showing
nothing at all, with this program:

```ts
loops.everyInterval(1000, function () {
    if (WiFi.internetOk()) {
        basic.showIcon(IconNames.Yes)
        basic.showNumber(WiFi.internetTime(TimeUnit.Year))
    } else {
        basic.showIcon(IconNames.Asleep)
    }
})
```

They also judged the approach too complex. Correct on both counts.

### The "nothing at all" symptom

`internetOk()` and `internetTime()` each opened their **own** TCP connection.
`internetOk` alone could block ~8 s (`AT+PING` timeout + TCP fallback) inside a
1000 ms interval, so:

- `loops.everyInterval` re-entered while the previous run was still mid-AT
  conversation → two fibers interleaving AT commands on one serial port,
  corrupting both replies;
- `basic.showNumber` (~1 s per digit) never finished before the next tick, so the
  display looked dead.

### What was removed

- `AT+PING` entirely, plus its TCP fallback — `internetOk` no longer does any
  network work of its own.
- `internetOkHost()` (custom-host variant) and the `example.com` second-host
  fallback: two hosts doubled the worst-case blocking time for a rare benefit.
- `fetchDateFrom`/`fetchNetTime` split and `daysFromCivil`.

281 lines → 217, and **one** network operation (5 AT commands) instead of up to
three independent connects per loop tick.

### The shape now

`internetOk()` / `internetTimestamp()` / `internetTime(unit)` all call
`refreshNetTime()`, which fetches **only** if there is no cached time or it is
stale (10 min; 15 s after a failure). Everything else is served from cache.
`internetOk()` simply reports whether the last fetch succeeded — no separate
probe. Added `netBusy` re-entry guard so a second fiber cannot start an AT
conversation while one is running.

### Verification

Simulated the user's exact 60-tick loop: **one** fetch total, every tick returns
2026, no zeros. Also: 4 block calls in a row → 1 fetch; host down → false/0 with
backoff, then recovery; local clock advance; CIPSEND failure closes the socket;
re-entry guard blocks a concurrent fetch. Plus the 608-case date suite
(leap years, 2100, epoch, 2038, `+IPD` framing, partial/decoy headers) — all pass.

**Still unverified on hardware.**

## 2026-08-19 (third pass) — the actual bug: how the reply was read

User report: "Internet OK?" fails even though WiFi connects, and the time still
shows 0/nothing. They asked whether `+IPD` is only needed for the time metadata,
then corrected an early hypothesis of mine: **they also poll data from
adafruit.io**, i.e. this driver already reads reply bodies successfully.

That correction located the bug. `adafruitIOGetValue()` (line ~589) is the one
pre-existing function that reads a reply BODY, and it works. My `fetchNetDate`
differed from it in four ways, each capable of losing the reply:

| working `adafruitIOGetValue` | my broken version |
| --- | --- |
| `clearSerialBuffer()` first | (missing) — stale bytes corrupted the parse |
| `serial.writeString(req + "\r\n")`, `CIPSEND=req.length` | `sendAtCmd(req)` with `CIPSEND=req.length + 2` |
| tight read loop, `basic.pause(5)` only after 150 empty reads | `basic.pause(50)` **every** iteration — too slow, missed the reply |
| never touches `CIPMUX` | forced `CIPMUX=0`, fighting the AP server |

`fetchNetDate` was rewritten to mirror `adafruitIOGetValue` exactly.

### Answer to "is +IPD only necessary for the time metadata?"

No — `+IPD,<len>:<data>` is how the module delivers *any* inbound TCP payload,
including the adafruit.io JSON. Nothing here is special to time. What *is* special
is that reading a reply at all is rare in this driver: `sendToThingSpeak`,
`sendToIFTTT` and `adafruitIOPost` only wait for `SEND OK` and discard the body,
so they never had to get this right. Only `adafruitIOGetValue` did — which is why
it was the correct template. We don't parse the `+IPD` framing itself; we just
scan the raw stream for the `Date:` header.

### Secondary root cause: `waitAtResponse` is destructive

`waitAtResponse` accumulates into a **local** `buffer` and discards it on return.
The module frequently delivers `SEND OK` and the beginning of the HTTP reply in
one read, so waiting for `SEND OK` with `waitAtResponse` silently eats the Date
header. The read loop after the send therefore does its own `serial.readString()`
and keeps everything. Noted in a comment so this isn't "simplified" back later.

### New diagnostic blocks (advanced)

- `last time error` → 0 ok / 1 connect failed / 2 no send prompt / 3 sent but no
  date in reply.
- `last time reply` → the raw text the module returned, newlines flattened.

These exist so an on-device failure can be identified instead of guessed at.

### Verification

Simulated the UART realistically: the reply is delivered in fixed-size chunks via
a queue that `readString()` drains one chunk at a time (rather than returning the
whole reply at once). Passes for **every chunk size from 1 to 40 bytes**, with the
`Date:` header straddling read boundaries — the case the previous version failed.
Also asserts `CIPSEND` length has no `+2`, `CIPMUX` is never touched, stage codes
1/2 on the failure paths, and one fetch across 30 loop ticks. Plus the 506-case
date suite. All pass.

**Still unverified on hardware.**
