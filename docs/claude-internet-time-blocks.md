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

## 2026-08-19 (fourth pass) — works on hardware; simplification round

User confirmed the blocks work on the device. Then asked what could be simplified,
noting correctly that **"Internet OK?" should not need to poll the time**.

### `internetOk` is now a real ping again (5 lines)

The user's rule was: make it a plain ping unless that costs more lines than
reusing the time fetch. It doesn't — the expensive part before was the *TCP
fallback* for firmware without `AT+PING`, not the ping itself. Since the module
demonstrably answers `AT+PING` (the block works on hardware), the fallback is
dead weight:

```ts
export function internetOk(): boolean {
    clearSerialBuffer()
    sendAtCmd("AT+PING=\"" + TIME_HOST + "\"")
    return waitAtResponse("+PING:", "ERROR", "timeout", 5000) == 1
}
```

`internetOk` is now fully independent of the clock — no shared state, no fetch
triggered, works standalone (which is what the user's original test program
assumed). It does block up to 5 s on failure; that is inherent to a ping.

### Removed

- `lastTimeError` / `lastTimeReply` diagnostic blocks and the `netStage` /
  `netRaw` state. They existed only to find the read bug, which is fixed. `netRaw`
  also retained a ~1 KB string permanently, which matters on this heap.
- `refreshNetTime` collapsed: the two staleness guards became one
  (`wait = netTimeOk ? TIME_REFRESH_MS : TIME_RETRY_MS`), and the
  `if/else` assigning `netTimeOk` became `netTimeOk = epoch > 0`.

303 → 262 lines in the internet-clock region.

### Kept deliberately, with reasons

- **`findDateHeader` (line-anchored match, 12 lines).** The chosen host currently
  sends only one `Date:` header, so this is not load-bearing today — but a proxy
  or a host change adding `X-...-Date:` would produce a *silently wrong time*,
  which is worse than no time. Cheap insurance.
- **`netBusy` re-entry guard (2 lines).** `fetchNetDate` calls `basic.pause`, which
  yields, so two user fibers (e.g. `forever` + `everyInterval`) can still overlap
  even though there is now only one call site. This was a real, hard-to-diagnose
  corruption source.
- **Failure backoff (`TIME_RETRY_MS`).** A failed fetch costs several seconds; a
  loop with no internet would otherwise retry nonstop.
- **The validation block in `parseHttpDate`.** Guarantees a mangled/partial header
  yields 0 rather than a bogus time.

### Verification

Re-ran everything after the edits: `internetOk` issues exactly one `AT+PING` and
**no** `CIPSTART` (proving it no longer touches the time path) and leaves the
clock unpopulated; time blocks still parse chunked `+IPD` replies at every chunk
size 1–30; one fetch across 30 loop ticks; refresh after the window; backoff and
recovery; re-entry guard. Plus the 506-case date suite. All pass.

## 2026-08-19 (fifth pass) — UART log finds two AT handshake bugs; CET/CEST added

The user added a bit-banged debug UART (`softserial.ts`) and captured the real AT
conversation. It showed the failure directly:

```
>>AT+CIPSTART="TCP","detectportal.firefox.com",80
<<AT+CIPSTART="TCP","d          <- truncated: no OK, no CONNECT
>>AT+CIPSEND=80                 <- we sent anyway
<<AT+CIPSEND=80  OK             <- this "OK" is the ECHO, not the ">" prompt
>>AT+CIPCLOSE
<<AT+CIPCLOSE  ERROR
```

### Bug 1 — connect failure fell through on TIMEOUT

```ts
if (waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 5000) == 3) return 0
```

`waitAtResponse` returns 3 only for the *third* target (`ERROR`). A **timeout
returns 0**, which is not 3 — so when CIPSTART simply never answered (slow DNS on
a first lookup), the code proceeded to CIPSEND on a socket that was never opened.
That is precisely the "sometimes it works but often not" symptom. Now accepts
only 1 or 2 (CONNECT / ALREADY CONNECTED) and bails on both ERROR *and* timeout.
Timeout raised 5 s → 10 s for cold DNS.

### Bug 2 — the ">" wait matched the command echo

```ts
if (waitAtResponse(">", "OK", "ERROR", 2000) == 3) { ... }
```

The module echoes the command and then prints `OK`. With `"OK"` as target2 this
matched the echo, so the check "passed" even when no `>` prompt ever came. Now
waits for `">"` only (`!= 1` fails).

Both are the same class of mistake: `waitAtResponse`'s return codes are
positional, and target strings can match the module's echo of our own command.

### CET/CEST local time

The HTTP `Date:` header is always GMT, so the hour read 12 instead of 14. Added
the EU rule: CET = UTC+1, CEST = UTC+2 from 01:00 UTC on the last Sunday of March
to 01:00 UTC on the last Sunday of October (`toLocal` / `isSummerTime` /
`lastSundayUtc`, ~20 lines, no table).

- `internetTime(unit)` now returns **local** CET/CEST, 24 h.
- `internetTimestamp()` stays **UTC** — a Unix timestamp is UTC by definition, and
  shifting it would make it wrong for logging/arithmetic.

### Verification

- **695 timezone points** vs Python `zoneinfo` (`Europe/Berlin`): every DST
  transition 2020–2040 checked to the second on both sides, plus 400 random
  instants. All fields match.
- Reported case reproduced: UTC 12:00 in August → **14** local; January → 13.
- Regression test for bug 1: on a CIPSTART **timeout**, **zero** `CIPSEND` is
  issued. On a missing `>` prompt (echo still says OK), the fetch aborts.
- Re-ran the fetch suite (chunk sizes 1–30, caching, one fetch per 30 ticks) and
  the date suite. All pass.

## 2026-08-25 (sixth pass) — CIPSTART gets no reply at all

New trace: `AT+PING` succeeds (`+PING:9`, so DNS and internet are fine), then
`AT+CIPSTART` is echoed and **nothing comes back at all**. Still 0 on many
attempts. The user confirmed the problem persists with `debugMODE = false`.

### Ruled out

- **Debug logging blocking the UART.** Was a strong hypothesis: `softSerial`
  bit-bangs at 4800 baud and busy-waits, so logging a ~50-char command blocks
  ~110 ms, during which ~1150 bytes can arrive at 115200 baud. The user tested
  with `debugMODE = false` and saw no change, so this is **not** the cause. The
  mitigations were kept anyway (they are correct regardless) — see below.
- **Leftover bytes from the previous command.** `clearSerialBuffer()` runs first
  in `fetchNetDate`, so `AT+PING`'s trailing `OK` is flushed before CIPSTART.
- **The 20-char "truncation" in the log.** Both long echoes cut at exactly 20
  chars while short ones (11, 13) arrived whole — that was the logger, not the
  module.

### Most likely cause: DNS / IPv6 on CIPSTART

`detectportal.firefox.com` resolves to **IPv6 first** (`2a04:4e42:...`, Fastly).
`AT+PING` succeeded because it falls back to IPv4, but several ESP-AT builds
stall with **no reply at all** on `CIPSTART` when a name resolves to IPv6 on
firmware without working IPv6, or when DNS is slow. That matches the trace
exactly: echo, then silence.

### Fix: shorter primary host + a bare-IP fallback

- Primary is now **`example.com`** (`/`): IANA-reserved, stable, and the AT line
  drops from 47 to 34 characters.
- Fallback is **`1.1.1.1`** (`/`) — a bare IPv4 literal, so `CIPSTART` performs
  **no DNS at all**. Verified it answers plain HTTP on port 80 with a valid
  `Date:` header (a 301 to HTTPS, which is fine: we only read the header and
  never follow the redirect).
- `fetchNetDate(host, path)` is now parameterised and tried twice.

### Kept from the debug investigation (correct regardless)

- **`serial.setRxBufferSize(254)` in `setupWifi`.** The pxt default is 64 bytes
  (~5.5 ms at 115200). `doApSetup` already did this; **station mode never did**,
  so any stall before a read could lose a reply. Real latent bug, now fixed.
- **Debug logging moved out of the hot path.** `sendAtCmd` no longer bit-bangs
  the echo inline; the command is stashed in `pendingCmd` and printed by
  `debugLog()` together with the reply, *after* the reply has been read. Also
  means the log now shows the full command instead of a 20-char stub, and a
  timeout is labelled `[TIMEOUT]`.

### Verification

Modelled a named host that echoes and then never answers (the exact reported
symptom): the IP fallback recovers it, two `CIPSTART`s are issued, and the time
parses. Also: only one `CIPSTART` when the primary works, `0` when both fail, no
`CIPSEND` when nothing connected, chunk sizes 1–25, caching, and 426 timezone
points. All pass.

**If it still fails on hardware**, the next data point needed is the trace with
the new build: whether `AT+CIPSTART="TCP","1.1.1.1",80` also gets no reply. If
even the bare IP is silent, the problem is below DNS (module state after
`AT+PING`, or `CWMODE`/DHCP), not name resolution.

## 2026-08-25 (seventh pass) — working; switched GET -> HEAD

User confirmed the bug is gone. The successful trace showed `CONNECT`, `SEND OK`
and an intact `Date: Tue, 25 Aug 2026 13:05:30 GMT`. Most likely the fix was
dropping the IPv6-first hostname (`detectportal.firefox.com` → `example.com`);
the `1.1.1.1` bare-IP fallback remains as backup if DNS misbehaves again.

### GET -> HEAD

The trace showed the reply was `+IPD,867:` — the full chunked HTML page of
`example.com`, of which only the `Date:` header (first ~40 bytes) is ever used.
The module had to funnel all of it over the UART and the read loop had to buffer
it, once per refresh.

`HEAD` returns byte-identical headers with no body. Measured live:

| request | reply size |
| --- | --- |
| `GET /` on example.com | 867 B |
| `HEAD /` on example.com | **269 B** (−69%) |
| `HEAD /` on 1.1.1.1 | 214 B |

Both hosts honour it (`example.com` even advertises `Allow: GET, HEAD`), and both
still return `Date:`. Only the time fetch changed — `adafruitIOGetValue` still
uses GET, as it must (it needs the body).

Verified by feeding a **live** `HEAD` reply (captured over netcat, wrapped in
`+IPD` framing) through the real parser: 13 UTC → 15 local CEST, 25/8/2026,
matching the system clock.

### Test-harness bug worth remembering

The first run after this change reported 10 failures. They were all the mock, not
the driver: the fake module only answered requests starting with `"GET "`, so it
never replied to a HEAD. Fixed the mock and added assertions that the request line
**is** HEAD and that no GET is issued. A harness that hardcodes what it expects
the code to send will "fail" on any correct change to that request.

### Note

User asked that this project never be committed. Nothing has been.

## 2026-08-25 (eighth pass) — 1.1.1.1 is now the primary host

User's call: default to `1.1.1.1` instead of `example.com`.

Worth recording: in the trace accompanying the request, `example.com` **did**
answer correctly (`+IPD,269:` with `Date: Tue, 25 Aug 2026 13:21:36 GMT`). But the
user has the field evidence across many attempts, and the IP is the more robust
default on its own merits — `CIPSTART` to a literal does no DNS at all, and DNS
was the one part of the path that kept failing.

- `TIME_HOST` = `1.1.1.1` (no DNS)
- `TIME_HOST2` = `example.com` (fallback, in case a network blocks 1.1.1.1 — some
  routers and ISPs do, since it is also a public resolver)

### Side effect on "Internet OK?"

It pings `TIME_HOST`, so it now pings an IP. Faster (no lookup), but it no longer
proves DNS works: a network with dead DNS will report internet OK. That is
arguably the more honest test of raw reachability, and it now matches what the
time fetch actually does. Noted in case DNS-awareness is wanted later.

### Verification

Live `HEAD /` against 1.1.1.1 captured over netcat (213 B), wrapped in `+IPD`
framing, parsed by the real driver functions: **15:23 25/8/2026 local**, matching
the system clock. Note its `Date:` header comes *after* `Server:`, which the
line-anchored `findDateHeader` handles correctly.

Suite: primary is the IP and only one CIPSTART is issued; `internetOk` pings the
IP; falls back to example.com when 1.1.1.1 is blocked; chunk sizes 1–25; caching;
no CIPSEND when nothing connected. All pass.

## 2026-08-25 (ninth pass) — hosts swapped back; refresh window 10 min -> 30 s

Two user requests.

### 1. `example.com` is the primary again

Reverted the previous swap. `TIME_HOST` = `example.com`, `TIME_HOST2` = `1.1.1.1`.

Context from the same conversation: the user asked why the reply said
`Server: cloudflare`. Answer — `example.com` is genuinely served through
Cloudflare (it resolves to `104.20.23.154` / `172.66.147.243`, Cloudflare ranges),
so that header is expected and is *not* evidence of interception. The `CF-RAY`
suffix names the edge that answered (`-CDG` Paris, `-TXL` Berlin); different
requests hitting different edges is normal CDN behaviour.

Both defaults are therefore Cloudflare-fronted, so a Cloudflare-wide outage takes
out both. `deb.debian.org` (Fastly) was offered as a genuinely independent
fallback; the user did not take it. Noted in case it matters later.

### 2. "The internet time block should always refresh"

Implemented as a **30 s** cache rather than a literal fetch-per-call, after
laying out the cost:

- one fetch blocks **~1.4 s** on success, and up to **~50 s** if both hosts are
  unreachable (25 s worst case per host);
- `internetTime(Hour)` followed by `internetTime(Minute)` would be **two** fetches
  — ~3 s of blocking, and the two values can disagree if a minute rolls over in
  between.

The user chose the 30 s window. `TIME_REFRESH_MS` 600000 → 30000.

Verified: hour+minute back-to-back share one fetch (one consistent instant); a
re-fetch happens once the cache passes 30 s; no fetch within 30 s; a 1 s loop over
30 ticks performs ≤2 fetches rather than 30. Host order, chunked parsing and the
failure paths all still pass.
