# WiFi Hub driver (`wifihub.ts`)

A second, standalone driver: one Calliope + WiFi board acting **only** as a
collection point for other minis. No dashboard.

## 2026-08-25 — Why, and what the real limit is

User asked whether a "router" driver was feasible and how many devices it could
take, suspecting the dashboard's serial traffic was the constraint.

**"Router" is the wrong word — but the instinct was right.** In SoftAP mode
(`CWMODE=2`) the module has no uplink and no NAT, so nodes can reach the hub but
not each other and not the internet. What is feasible is a **data collector**.

**Two different ceilings, often conflated:**

| limit | value | what it governs |
| --- | --- | --- |
| `AT+CWSAP` `max_conn` | up to **10** (default **4**) | how many may *associate* |
| `AT+CIPSERVERMAXCONN` | **5** (link ids 0-4, AT max) | how many may hold a socket |
| practical | **3-5 nodes** | the single-fibre server |

**Bandwidth is not the bottleneck; the dashboard is.** At 115200 baud 8N1
(~11.5 KB/s):

- the ~9.3 KB dashboard page = **~0.8 s of exclusive UART time per load**;
- a `/push` request is ~60 B in, ~40 B out = **~9 ms**;
- 10 nodes polling every 2 s ≈ **9%** of UART capacity.

So the fix is not fewer nodes, it is dropping the page. The binding constraint
after that is architectural, not bandwidth: `handleRequests` serves one request
at a time through one shared `rxBuf`, and overlapping requests corrupt the parse
(the same failure that froze the dashboard when `/set` collided with `/data`).

## What was reused

The `/push` ingest path is taken **verbatim** from the multi-node work in commit
`7e14cb4` (`ingestPush`, `urlDecode`, `hexVal`) — code that already worked. The
AP bring-up keeps the hard-won fixes from `main.ts`: AT-answer wait before
configuring, `CWSAP` retry loop, `SYSSTORE=0`, `CIPAP` 4.3.2.1, `CIPMUX=1`,
`CIPSTO=10`, `CIPSERVERMAXCONN=5`, the `"ready"` self-heal, the re-firing idle
watchdog, and `drainIdle`'s yield.

Nodes are unchanged: they use `WiFi.pushToHub` / `WiFi.setHubAddress` from the
normal extension.

## What was dropped

The entire dashboard: `pageHtml`, the chart/table JS, `/data`, `/log.csv`,
`/controls`, the toggles and sliders, timestamp sync. 1825 lines → **407**.

Replies are tens of bytes, so there is no chunking and no possibility of the
large contiguous allocation that caused error 022.

## Risks and open questions

- **`CWSAP` with 5 parameters is untested on this hardware.** The docs
  (`AP_WEBSERVER_POC.md:72`) only ever verified the 4-parameter form, and a
  rejected `CWSAP` silently leaves the module on its default `ESP_xxxx` network —
  which presents as "the hub never appeared". Mitigated: if the 5-parameter form
  errors, it retries the 4-parameter form (capping associations at the default 4)
  rather than failing setup.
- **Heap pressure from connection churn** remains the likeliest failure under
  load, per the CHANGELOG's known issues. Lengthen the node push interval before
  reducing node count.
- **Not run on hardware.**

## Verification (host-side)

Mocked module traffic through the real functions: a normal push logs the right
columns and replies 200 then closes the socket; percent-decoding; unknown path →
404 and counted; `/favicon` → 204 and *not* counted; `/push` with no query logs
nothing; a **partial** request is not acted on until the line completes; a
`"ready"` banner re-runs setup; the idle watchdog issues `AT+CIPCLOSE=5`; five
sequential node pushes all ingest.

## 2026-08-25 (later) — node side added to the same file

The driver now carries **both halves**. Groups: *Hub*, *Node*, *Status*.

Node blocks:

- `join hub network` → `joinHub(tx, rx, ssid, passwd)` — `CWMODE=1` + retried
  `CWJAP`, returns whether it joined.
- `joined hub?`
- `push to hub as node $node $data1..$data5` → the `datalogger.log`-shaped block,
  same `createCV` slots.
- `hub address` (advanced) and `last push status` (advanced, 0/1/2/3).

`pushQuery` and `urlEncode` are reused **verbatim** from commit `7e14cb4`.

**This fixed a real defect in the previous version of this file.** Its header told
node programs to call `WiFi.setupWifi` / `WiFi.setHubAddress` / `WiFi.pushToHub`,
but the multi-node blocks were reverted out of `main.ts` long ago — those blocks
do not exist. The instructions pointed at nothing. Both halves now live here, and
the header example was rewritten to match.

**Hub and node cannot coexist on one board** — the hub needs `CWMODE=2` (SoftAP),
a node needs `CWMODE=1` (station). Stated in the file header and in the Node
section comment; `startHub` and `joinHub` must not both be called in a program.

### Test-harness bug worth remembering (again)

The node tests first failed with empty values: `temp=&light=`. That was the mock,
not the driver. The real `datalogger.ColumnValue` coerces in its constructor —
`libs/datalogger/datalogger.ts:47-55`:

```ts
export class ColumnValue {
    public value: string;
    constructor(public column: string, value: any) { this.value = "" + value; }
}
```

so `value` is **always a string** on hardware, and `urlEncode`'s `charAt` loop is
correct. The mock had stored a raw JS number, which has no `.charAt`, yielding
"". Fixed the mock to coerce like the real class. Second time a harness that
modelled the platform loosely produced a false failure — worth checking the real
type before "fixing" driver code.

### Verification

Node: join sets `CWMODE=1` and joins once; a push sends
`GET /push?node=B&temp=21.4&light=120`, forces `CIPMUX=0`, and closes its socket
so it never holds one of the hub's five slots; status codes 1/2/3 on the three
failure paths.

**Round trip:** the exact request the node produced is fed into the hub's own
`ingestPush`, and the logged columns come back identical to the input —
including `"Raum A"` and `"t&x"="1=2"`, which exercise the percent-encode /
percent-decode pair end to end.

Hub-side suite re-run unchanged: all pass. **Still not run on hardware.**

## 2026-08-25 (later still) — softserial debugging on P2

Mirrors the pattern in `main.ts`, which already logs on P2 at 4800 baud.

```ts
let debugHUB = true
let debugHUBPIN = DigitalPin.P2
let debugHUBBAUD = softSerial.BaudRate.Baud4800
```

Wire a USB-TTL adapter's **RX to P2**, open at **4800 baud**. `debugHUB = false`
silences everything (verified by test: no output, rows still ingested).

### The timing rule, carried over deliberately

`sendAtCmd` does **not** print the command inline. softSerial bit-bangs and
busy-waits: ~110 ms for a ~50 character line, during which the module can deliver
~1150 bytes at 115200 baud — far more than the 254-byte RX buffer holds. Logging
before a reply arrives *eats the reply*. This was the bug that made `AT+CIPSTART`
look unanswered in `main.ts`, and the comment is repeated here so it is not
"simplified" away later.

So: the command is stashed in `pendingCmd`, and `waitAtResponse` prints `>>cmd`
and `<<reply` together once the reply is safely read. Timeouts print
`<< ... [TIMEOUT]`.

### What the hub reports

- `hub up: <ssid> on 4.3.2.1`, or `hub FAILED to start (CWSAP never accepted)` —
  distinguishes "no network appeared" from "network up, nodes not pushing".
- `row <n>: node=B temp=21.4 light=120` per ingested push.
- `404 <path>` for anything that is not `/push`.
- `module rebooted -- re-running setup`.
- `idle: closed all sockets` when the watchdog fires.

Placement was checked explicitly: inside `handleRequests` the only `debugNote` is
on the reboot path, after `rxBuf` is consumed and before a 500 ms pause. Row
logging happens after the request is fully parsed and before the reply is sent.
Nothing blocks between a read and the bytes it is waiting for.

### Verification

Mock charges realistic blocking time (~2.2 ms/byte at 4800 baud) so the tests
would expose a log that stalls the request path. Hub suite, node suite and new
debug checks all pass: the ingested row, the AT exchange and the 404 path are
logged; `debugHUB = false` produces no output while still ingesting.

## 2026-08-25 (final) — nodes log their own side too

The user asked whether hub *clients* show debug output. Partly: nodes already got
the AT-level `>>cmd` / `<<reply` lines, because they share `waitAtResponse` — but
every `debugNote` (the human-readable events) was hub-only. A node therefore
showed raw AT traffic with no statement of whether it had joined or pushed.

Node events added:

- `node: joined <ssid>` / `node: could NOT join <ssid> (3 tries)`
- `node: module not answering AT` when the boot handshake never completes
- `push ok: node=B&temp=21.4`
- `push FAILED (<reason>): <query>` where reason is the `pushStage` code in
  words — *no connection to hub* / *no send prompt* / *not acknowledged* —
  via a new `pushFailReason()`. A number in a log is a lookup task; the words are
  the point of logging at all.

Placement follows the same rule as the hub: nothing is written between a read and
the bytes it waits for. `pushQuery` contains **no** `debugNote` — verified by
grep — so the summary is emitted only after the whole AT exchange finishes.

Both boards share `debugHUB` / `debugHUBPIN` / `debugHUBBAUD`, so P2 at 4800 baud
works the same whichever program is flashed. Header comment updated to say the
logging covers both sides.

Verified: successful and failed joins each log; a successful push logs its query;
all three failure modes name their reason; `debugHUB = false` silences the node
as well. Hub suite re-run unchanged.

## 2026-08-25 — every push after the first cost two connect attempts

Hardware log showed pushes succeeding, but with a wasted cycle each time:

```
>>AT+CIPSTART="TCP","4.3.2.1",80
<<...CONNECT  OK                  <- connected
>>AT+CIPSEND=76
<<CLOSED  AT+CIPSEND=76  ERROR    <- refused; socket already gone
>>AT+CIPCLOSE            -> ERROR
>>AT+CIPSTART            -> CONNECT OK
>>AT+CIPSEND=76          -> OK  >     <- second attempt works
```

**Cause: the previous connection's teardown had not finished.** `pushQuery` sent
`AT+CIPCLOSE` and returned immediately, so the *next* push issued `CIPSTART`
while the old socket was still closing. The module accepted it (`CONNECT`/`OK`)
and then tore the new socket down as the old close completed — hence the stale
`CLOSED` arriving just before the `CIPSEND` echo, and the genuine `ERROR`.

Fix: after `AT+CIPCLOSE`, `basic.pause(200)` and one `serial.readString()` to
consume the late `CLOSED` notice, so the next push starts from a settled module.
The two-attempt retry loop is kept as a safety net.

### Correction to my own first diagnosis

I initially read this as a **parsing** bug — that `waitAtResponse(">", "ERROR",
...)` was matching a stale `ERROR` before the prompt arrived — and added a
`waitForPrompt()` that waits only for `>`. That reading was wrong: the log shows
the module answering `ERROR` to `CIPSEND` outright, not sending a prompt we
mis-read. The socket really was gone.

`waitForPrompt()` was kept anyway (matching `ERROR` from the command echo is a
real hazard, and it is the same class of bug fixed earlier in `main.ts`), but it
is **not** what fixes this. The `basic.pause(200)` is.

Worth recording how the error surfaced: my first mock injected the stale `CLOSED`
*into the CIPSEND reply*, which made the parsing theory look correct. A second,
more faithful mock — unsolicited `CLOSED` as its own line — reproduced neither
the bug nor a difference between old and new code, which is what exposed the
theory as wrong. **A mock built to match a hypothesis will confirm it.** Both
mocks are in the scratchpad; neither reproduces the hardware timing, so this fix
rests on reading the log, not on a passing test.

**Unverified on hardware.** The check is simple: each push should show exactly
one `AT+CIPSTART` and one `AT+CIPSEND`. If two still appear, raise the 200 ms.

## 2026-08-25 — hub log with 2 nodes: every reply failed

Hardware log with two nodes pushing showed rows 33-40 all ingesting correctly
(both node names, sane values) but **every reply failing**:

```
>>AT+CIPSEND=0,85
<<0,CLOSED  AT+CIPSEND=0,85    ERROR
>>AT+CIPSEND=0,85          <- pointless retry
<<AT+CIPSEND=0,85    ERROR
>>AT+CIPCLOSE=0            <- pointless close
<<AT+CIPCLOSE=0    ERROR
row 33: node=puzuz licht=139
```

Three failing AT commands per row, on every row.

**Cause: `drainIdle(150, 1500)` before replying.** The node sends
`Connection: close` and drops its socket the moment its own module reports
`SEND OK` (reinforced by the 200 ms teardown settle added earlier the same day).
The hub then waited for 150 ms of *silence* before answering — and with two nodes
pushing, silence never comes, so it often ran the full 1500 ms. By then the
socket was long gone.

**The deeper point: the hub does not need to reply at all.** The node waits for
`SEND OK` from its own module and closes; it never reads the HTTP response. The
reply is a courtesy, and a node having already closed is the *normal* case.

Changes:

1. **Reply immediately** — `drainIdle` removed from the request path (and the
   function deleted, it had no other caller). The request line is already fully
   parsed by the time we get there; waiting bought nothing.
2. **`sendChunk` no longer retries.** A refused `CIPSEND` means the node closed,
   which is expected. Retrying spent two extra failing commands per row.
3. **`CIPCLOSE` only after a reply that actually went out.** Closing a socket the
   node already closed just added a third failing command.

Result in the harness (two nodes alternating, each closing immediately, 20 rows):
`AT+CIPSEND` **2 → 1** per row, `AT+CIPCLOSE` **1 → 0**, all 20 rows ingested
10/10 across both nodes. When a node *does* stay open the hub still replies 200
and closes its end.

### Note on the earlier "teardown settle" fix

The node-side `basic.pause(200)` after `AT+CIPCLOSE` makes the node close even
more promptly relative to the hub, so it slightly worsened this hub-side symptom
while fixing the node-side double-connect. Both fixes are correct; they were just
pulling in opposite directions on the same race.

**Unverified on hardware.** The check: each `row N:` line should be preceded by
at most one `AT+CIPSEND`, and `AT+CIPCLOSE=<link>` should appear only when that
send succeeded.

## 2026-08-25 — 10 Hz stress test: SEND FAIL, and a dropped-request bug

User ran two nodes at **10 Hz** (deliberate stress; ~20 connect/close cycles a
second on a 5-socket module). Retries were gone — one `AT+CIPSEND` per row — but
every reply now ended `SEND FAIL`, and `+IPD` lines appeared cut mid-path
(`TTP/1.1  Host: 4.3.2.1...`).

**`SEND FAIL` is a step forward from the previous `ERROR`:** the prompt is now
granted (`OK  >`) and the 85 bytes are written (`Recv 85 bytes`) — the transmit
only fails because the node closed during it. At this rate that is unavoidable:
the node closes the instant its own module reports SEND OK.

### Fix 1: replies are now optional, and off by default

`replyToPushes = false`, with a `reply to pushes` block (advanced) to switch it
on. The node never reads the response, so the round trip — `CIPSEND`, prompt, 85
bytes, then a wait of up to 2 s for SEND OK/FAIL — was pure cost at exactly the
moment the hub needed to be reading the next request. Rows are logged first
regardless; the reply was always the optional part.

Turn it on to poke the hub from a browser or curl.

### Fix 2: a real bug — buffered requests were being thrown away

After parsing a request, `handleRequests` did `rxBuf = ""`. If a second node's
request had already arrived behind the first, **it was discarded**. At speed that
is constant, and it is what the cut `+IPD` fragments in the log were showing.

Now `rxBuf = rxBuf.substr(pathEnd)` — consume only the request just handled and
keep the remainder for the next call. Verified: two requests delivered in one
read are both ingested, and a burst of ten interleaved requests yields ten rows.

This bug predates the stress test; it was simply invisible at 0.5 Hz.

### Not a hub problem: `pipig` always reads 0

Every `pipig` row in the log is `licht=0` while `puzuz` varies (105, 127, 136,
124, 145, 122, 134, 134). The hub is faithfully recording what it is sent, so
that is a node-side matter — sensor covered, or `input.lightLevel()` never being
read on that mini. Flagged to the user rather than "fixed" here.

### On 10 Hz

Worth stating plainly: 10 Hz per node is far above what this design targets. The
CHANGELOG's heap-pressure warning applies, and the single-fibre server has ~50 ms
per request at that rate. The fixes above make the hub degrade gracefully rather
than lose data, but ~0.5 Hz per node remains the sane operating point.

**Unverified on hardware.** With replies off, the log should now show only
`row N: ...` lines and no `AT+CIPSEND` between them.
