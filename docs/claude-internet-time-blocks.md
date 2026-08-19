# Internet connectivity & clock blocks

Notes for the `WiFi.internetOk` / `WiFi.internetTimestamp` / `WiFi.internetTime`
blocks (station-mode client features, group *UartWiFi*).

## 2026-08-19 — "internet ok" block

`internetOk()` / `internetOkHost(host)`. Tries `AT+PING` first; on ERROR falls
back to a TCP connect to port 80.

**Why the fallback:** ESP-AT builds differ and not all ship `AT+PING`, so an
ERROR is ambiguous between "no such command" and "host unreachable". A completed
TCP handshake proves DNS *and* routing, which is what the block claims.

Default host `example.com`, not `8.8.8.8`: exercising DNS matters (an IP-only
ping passes on a network with broken DNS), and the domain is IANA-reserved for
exactly this use. Forces `CIPMUX=0` first because a program that ran the AP
server leaves the module in `CIPMUX=1`, which rejects single-connection commands.
Always closes its socket so it can't hold one of the server's slots.

## 2026-08-19 — internet clock blocks

Two blocks, as requested:

- `internet time (Unix s)` → `internetTimestamp()`: Unix seconds (UTC).
- `internet time <unit>` → `internetTime(TimeUnit)`: year / month / day / hour /
  minute / second, via the `TimeUnit` enum.

### Decision: read the HTTP `Date:` header, don't parse a JSON time API

Time source is `http://www.google.com/generate_204`. Every HTTP server stamps
replies with `Date:` in the fixed RFC 7231 format
(`Date: Wed, 19 Aug 2026 15:43:39 GMT`), so the clock can be read with fixed
substring offsets — no JSON parser, no API key, no TLS.

Alternatives rejected:
- **worldtimeapi.org / JSON APIs** — returned nothing when probed on 2026-08-19;
  a JSON parser plus a third-party uptime dependency on a memory-constrained
  module is a bad trade for six integers.
- **NTP (`AT+CIPSNTPTIME`)** — firmware-dependent like `AT+PING`, and would need
  the same HTTP fallback anyway.
- `generate_204` chosen over a normal page because the reply is headers only
  (empty body), so nothing large lands in the module's RX buffer.

### Caching (important)

The blocks do **not** hit the network on every call. A successful fetch stores
`netEpochSec` + `netDeviceMs`, and subsequent calls advance the clock locally
from `input.runningTime()`. Re-fetch happens only after `TIME_REFRESH_MS`
(10 min). Failures back off for 10 s so a dead uplink can't be hammered — this
matters because these are value blocks a user may drop inside `forever`.

Time is **UTC**, no timezone/DST handling. `Math.floor` is used rather than
`Math.idiv` purely to match the existing idiom in the file.

### Verification (host-side, not on hardware)

Extracted the pure functions, type-stripped them, and ran them under node:

- **613 date cases / ~3,700 assertions** against Python's `datetime` — leap
  years (2000, 2024), century non-leap (2100), month-end and year-end rollovers,
  the 1970 epoch, 2038, plus 600 random dates in 1971–2099. All fields
  (year/month/day/hour/minute/second) checked per case.
- Malformed input returns 0, never a bogus time: truncated header, missing
  header, bad month name, garbled digits, impossible hour, day zero.
- Fetch path with a stubbed AT module: cache hit (one fetch, then local advance),
  refresh after the window, correct field extraction, `0` + **no AT traffic** when
  WiFi was never joined, `0` on connect failure, 10 s failure backoff, and
  `CIPCLOSE` on every exit path.

**Not tested on hardware.** The assumption to confirm on-device is that the
module forwards the response headers as `+IPD` data that `serial.readString()`
returns — and the real `AT+PING` reply format for `internetOk`.

### File sync gotcha

`main.ts` and `testprj/wifi.ts` had already diverged before this change (the
user added `weight=` ordering, renamed the block to "Internet OK?", and moved
`toggle`/`slider` to the *Access Point* group in `main.ts` only). So the time
code was ported into `wifi.ts` surgically instead of copying the whole file —
`main.ts` is the authoritative copy for those differences. `diff main.ts
testprj/wifi.ts` should show *only* those pre-existing items.
