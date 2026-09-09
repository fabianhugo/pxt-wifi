# UART concurrency in the WiFi extension

## 2026-09-09: LED flashing at ~5Hz / corrupted AT command stream

**Symptom:** with `program.ts` running two `loops.everyInterval` loops — one at 1000ms
calling `WiFi.adafruitIOGetValue(...)` to drive the RGB LED, one at 10000ms calling
`WiFi.adafruitIOPost(...)` twice — the RGB LED flashed on/off at roughly 5Hz instead of
tracking the Adafruit IO "button" feed. The softSerial debug log (`log.txt`) showed a
repeating, malformed pattern:

```
>>AT+CIPSEND=142
<<AT+CIPSEND=142 / OK
>>AT+CIPSTART="TCP","io.adafruit.com",80
<<AT+CIPSTART="TCP","iCONNECT / OK
```

i.e. a `CIPSEND` immediately followed by a *fresh* `CIPSTART` with no `SEND OK`, no HTTP
response body, and no `CIPCLOSE` — and truncated echoes like `AT+CIPSTART="TCP","i`
followed directly by `CONNECT`.

**Root cause:** `loops.everyInterval` runs its body via `control.runInParallel`, i.e. in a
separate fiber (confirmed in `pxt-calliope/libs/core/loops.ts:13-22`). The two loops
therefore call into the `WiFi` namespace concurrently. Every block in the namespace drives
the *same* single UART to the ESP32 through shared module-level helpers (`sendAtCmd`,
`waitAtResponse`, bare `serial.readString()`), with no mutual exclusion. PXT's scheduler
switches fibers cooperatively at every `basic.pause()` — and `waitAtResponse` calls
`basic.pause(100)` inside its poll loop. So fiber A would block in `waitAtResponse`, fiber
B would wake up and write its own AT command into the middle of A's exchange, and each
fiber would then consume bytes of the other's reply. The truncated `"i` + `CONNECT` echoes
are exactly this: one fiber's `readString()` swallowing part of the other's response.

The 5Hz LED flicker was a downstream effect, not a separate bug: `adafruitIOGetValue`
almost never got a clean response, so its `== "ON"` comparison returned false ~randomly and
the 1-second loop toggled the LED essentially every tick.

**Decision:** added a single-flight lock inside the `WiFi` namespace (`main.ts`) rather than
restructuring `program.ts` into one fiber. Chosen because it fixes the extension for *any*
user program regardless of how the blocks are arranged — a MakeCode user putting two WiFi
blocks in two `every interval` loops is a completely natural thing to do and must not
corrupt the AT stream. Restructuring `program.ts` alone would have left the extension unsafe
for everyone else.

Implementation (`main.ts`, near the top of the namespace):

```ts
let busy = false
function acquire() { while (busy) basic.pause(10); busy = true }
function release() { busy = false }
```

`acquire()`/`release()` wrap every block that touches the UART: `setupWifi`,
`sendToThingSpeak`, `sendToIFTTT`, `sendToThingsboard`, `sendMessage`,
`adafruitIOGetValue`, `adafruitIOPost`. `adafruitIOGetValue` has four exit paths (two early
`return ""`, an early `return found`, and the fall-through) and releases on each.

Deliberately **not** locked: `wifiOK()`, `setThingsboardServer()`, `extractAioValue()` —
these touch no serial state. Locking `wifiOK()` in particular would be harmful: a 10-second
`adafruitIOPost` would then block a status check that only reads a boolean.

**Caveat / known limitation:** this is a cooperative busy-wait lock, correct only because
PXT fibers are cooperatively scheduled (no preemption between the `while (busy)` check and
`busy = true`, since neither statement yields). It is *not* safe against true preemption or
interrupts. Also note the lock makes a slow call block a fast one: with the program above,
a 10s post loop can delay the 1s LED loop by up to several seconds. If the LED needs to
stay responsive, restructure `program.ts` into a single fiber (post every 10th pass of a 1s
loop) so the two never contend.

**Verification:** type-checked `main.ts` clean (0 errors) with `tsc --noEmit` against stubbed
PXT target globals, and audited every `acquire()` for a matching `release()` on all control
flow paths including `break`/early return. NOT yet verified on hardware — the flashing
symptom should be confirmed gone on-device.

**Build tooling note:** `mkc build` in this repo currently fails for unrelated reasons —
`pxt.json` has an unstaged `"core": "file:../core"` dependency pointing at a directory that
does not exist, `softSerial` (used by the debug logging) is not declared as a dependency at
all, and bare `mkc build` defaults to the **micro:bit** target, which lacks `SerialPin.C17`/
`C16`. Add an `mkc.json` with the Calliope `targetWebsite` and declare the softserial
dependency before relying on a local build.

## 2026-09-09 (follow-up): AT protocol bugs exposed once the lock was in

**Context:** with the lock in place the interleaving stopped and the log became readable
for the first time — each exchange was coherent and the server actually answered
(`+IPD,1218:HTTP/1.1...`). That exposed three protocol bugs that the earlier corruption
had been masking.

### 1. Every POST was sent twice (duplicate data points in the feeds)

The log showed the temperature POST, a real server response, a `[TIMEOUT]`, and then the
*identical* POST again. Cause: `waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)`
never matched. After a payload the ESP-AT firmware here answers `busy p...` → `Recv` →
`+IPD,<n>:<response>` and never emits the literal string `SEND OK`. So `result` stayed 0,
`if (result == 1) break` never fired, and the `retry = 2` loop posted a second time.

**Decision:** added `waitSendResult(timeout)` which treats `SEND OK` **or** `+IPD` **or**
`Recv` as success (return 1), and `SEND FAIL`/`ERROR` as failure (return 2). All five send
sites now use it. Chosen over simply setting `retry = 1`, which would have stopped the
duplicates but also removed genuine retry on a dropped connection.

### 2. `adafruitIOGetValue` never worked at all

Log showed `CIPSEND=142` → `OK` → `AT+CIPCLOSE` → `ERROR`, with no `+IPD` ever. Two causes,
both in the GET path:

- **Byte-count mismatch.** It announced `AT+CIPSEND=req.length` but then wrote
  `serial.writeString(req + "\r\n")` — 2 bytes *more* than announced. The module counts
  the bytes it was promised, so it kept waiting, the request was never dispatched, and the
  following `CIPCLOSE` errored.
- **Premature payload write.** `waitAtResponse(">", "OK", "ERROR", 2000)` listed `OK` as an
  accepted answer, but the module echoes `AT+CIPSEND=142\r\n\r\nOK` *before* it prints the
  `>` prompt. `buffer.includes("OK")` matched that echo and returned 2, so the payload went
  out before the module was ready to receive it.

**Decision:** write exactly `req.length` bytes (`serial.writeString(req)`, no added CRLF),
and wait strictly for `>` — the prompt matcher is now
`waitAtResponse(">", "ERROR", "SEND FAIL", 2000)` with `if (result != 1) ...` at all six
send sites. `OK` is no longer accepted as a substitute for the prompt anywhere.

### 3. CIPSEND length vs bytes actually written — full audit

`sendAtCmd()` appends CRLF (2 bytes); `serial.writeString()` does not. Audited every site:

| site | was | now |
|---|---|---|
| ThingSpeak (137/140) | `len+2`, `sendAtCmd` | correct already |
| IFTTT (189/192) | `len+2`, `sendAtCmd` | correct already |
| Thingsboard (249/253) | `len`, `sendAtCmd` → **2 short** | `len+2` |
| sendMessage (311/316) | `len`, `writeString` | correct already |
| Adafruit GET (422/426) | `len`, `writeString(req+CRLF)` → **2 over** | writes `req` exactly |
| Adafruit POST (526/530) | `len`, `sendAtCmd` → **2 short** | `len+2` |

Also removed a doubled CRLF in the two Thingsboard `sendAtCmd(\`...\r\n\`)` calls —
`sendAtCmd` already appends one.

### 4. Thingsboard timeouts restored

Those calls had been cut to 200ms (the `//vorher 2000` / `//vorher 5000` comments record
the originals). 200ms is far too short for a TCP connect or a server reply. Restored to
3000ms for connect, 2000ms for the prompt, 5000ms for the send result.

**Verification:** `tsc --noEmit` clean against stubbed target globals. NOT hardware-verified
— the things to confirm on-device are that each feed now receives **one** point per cycle
rather than two, and that `adafruitIOGetValue` returns a value at all (it never has).

## 2026-09-09 (correction): the strict ">" prompt change was wrong — reverted

**This corrects section 2 of the previous entry.** Do not trust the claim there that
accepting `"OK"` as a send prompt was a bug; it is required.

**What happened:** after changing all six send sites to wait strictly for `>`
(`waitAtResponse(">", "ERROR", "SEND FAIL", 2000)` + `if (result != 1) continue`), the
extension stopped working entirely. The log showed:

```
>>AT+CIPSEND=142
<<AT+CIPSEND=142

OK [TIMEOUT]
>>AT+CIPCLOSE
<< [TIMEOUT]
```

The module answered `OK` and **no `>` ever appeared in the buffer**, so the wait timed out,
`if (result != 1) continue` skipped the payload write, and every subsequent command timed
out against a module still waiting for data it was promised.

**Corrected understanding:** the earlier reasoning — that `OK` was a spurious command echo
matching before the real prompt — was wrong. On this firmware/baud/polling combination the
`>` prompt is frequently not observed at all (it may be consumed by an earlier read, or
never emitted as a separate readable chunk given `waitAtResponse`'s 100 ms poll and the
blocking softSerial debug logging). `OK` is in practice the only reliable ready-signal.

**Decision:** replaced the strict matcher with `waitSendPrompt(timeout)`, which accepts
either `>` **or** `OK` as ready (return 1), and checks `ERROR`/`SEND FAIL` **first** as
failure (return 2) so a failure is never masked. All six send sites use it.

**Kept from the previous entry** (these were correct and are unchanged):
- `waitSendResult()` accepting `SEND OK` / `+IPD` / `Recv` — fixes the duplicate posts.
- The CIPSEND byte-count corrections, including writing `req` with no added CRLF in the GET.
- The restored Thingsboard timeouts.

**Also added:** `adafruitIOPost` now drains the serial buffer (`serial.readString()`) at the
top of each retry iteration. The log showed a `+IPD,207:` response from a previous attempt
arriving while waiting for the *next* `AT+CIPSTART` reply, and a leading
`AT+CIPCLOSE` → `ERROR` from the same cause. `adafruitIOGetValue` already drains via
`clearSerialBuffer()` on entry.

**Lesson for next time:** this module's responses vary enough that tightening a matcher on
reasoning alone is risky — the previous "obviously correct" narrowing broke everything. Widen
on evidence, narrow only with a log that proves the stricter token actually arrives.

**Verification:** `tsc --noEmit` clean. NOT hardware-verified.

## 2026-09-09 (follow-up): POSTs healthy; GET still returns nothing → LEDs blank

**Good news from this log:** every POST is now a clean single exchange —
`CIPSTART` → `CONNECT/OK` → `CIPSEND=232` → `OK` → body → `Recv 232 bytes`. No duplicates,
no interleaving. The lock, `waitSendResult`, and `waitSendPrompt` are all behaving.

**Remaining symptom:** "LEDs sometimes go out for no reason." Cause is visible in the log:
every `CIPSEND=142` exchange (that is the GET) dead-ends —

```
>>AT+CIPSEND=142
<<AT+CIPSEND=142

OK
>>AT+CIPCLOSE          <- next call; no body, no +IPD, no Recv
```

No `+IPD` response ever comes back for a GET, so `adafruitIOGetValue` returns `""`,
`"" == "ON"` is false, and `program.ts` drives the LED to `0x000000`.

**A wrong theory, corrected before acting on it:** the first guess was another CIPSEND byte
mismatch. Checked arithmetically — it is not. The old form
(`req` ending `\r\n\r\n`, announced `req.length`, written with `serial.writeString(req)`)
sends exactly 142 bytes, and the new form (`req` ending `\r\n`, announced `req.length + 2`,
written with `sendAtCmd(req)`) also sends exactly 142 bytes, byte-for-byte identical
content. The log's `142` matches both. **Length was never the GET's problem.**

**The actual difference between the working POST and the failing GET:** `sendAtCmd()` sets
`pendingCmd = cmd`, which is what causes a payload to be echoed into the debug log; a bare
`serial.writeString()` does not. That alone explains why every POST body appears in the log
and no GET body ever does. So the GET body may in fact have been transmitted all along and
was merely invisible — the absence in the log is *not* evidence it was never sent. The other
real difference is that after writing, the POST calls `waitSendResult()` (which reads,
drains and logs the module's answer) whereas the GET drops directly into its own bespoke
read loop, which had no logging at all.

**Decision:** made the GET use the same mechanism as the known-good POST path — build `req`
without the trailing blank line, announce `req.length + 2`, and write it with
`sendAtCmd(req)` so the CRLF that terminates the HTTP headers comes from `sendAtCmd`.
Verified the bytes on the wire are unchanged and the request still ends in a valid
`\r\n\r\n` header terminator. Added `debugLog` on both exits of the GET read loop
(`GET=<value>` on success, `GET no value in <n> bytes` on failure) so the next log shows
what the read loop actually received rather than nothing at all.

This is deliberately a diagnostic step as much as a fix: if the GET still fails, the new log
lines distinguish "no bytes arrived at all" from "bytes arrived but no `"value":"` in them".

**Deferred (user's call, 2026-09-09):** not touching `program.ts` yet. Note that even with a
working GET, one failed read returns `""` and blanks the LED, because the program treats any
non-`"ON"` value as OFF. If dropouts persist once the GET returns values, the fix is to leave
the LED unchanged when the result is `""` rather than treating it as OFF.

**Verification:** `tsc --noEmit` clean; byte counts checked arithmetically. NOT
hardware-verified.
