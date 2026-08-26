# Dashboard: page size, and serving it in station mode

## 2026-08-25 — measured the page before touching it

| part | bytes | share |
| --- | --- | --- |
| JS | 5304 | 56% |
| CSS | 2304 | 24% |
| HTML | 1747 | 18% |
| **total** | **9355** | 0.81 s of UART per load at 115200 |

User chose **minify, keep every feature** (over dropping the charts).

### What actually saved bytes

Identifier renaming was measured first and rejected: only ~224 B across the whole
script, because the JS was already terse. The real wins were structural:

1. **The custom toggle switch → a native checkbox.** Eight `.switch*` CSS rules
   (719 B) plus a `<label class="switch">…<span class="slider">` wrapper on each
   of three rows. Replaced by one rule using `accent-color`, which gives a
   coloured checkbox in every current browser. **−960 B of source.**
2. **`document.getElementById` → `E()`.** Appeared 15×; a 47-byte helper replaced
   345 B of calls. **−355 B** together with `rgba(66,201,201,1)` → `#42c9c9` (4×).
3. **The per-poll `console.log`** removed (it ran every 2 s and cost ~120 B); the
   reset warning was kept but shortened. **−175 B.**

**9355 → 8072 B, −14%**, 0.81 s → 0.70 s of UART per load. Charts, table,
toggles, sliders, CSV download and the packet counter are all still there.

### Verified by running the page, not just parsing it

`node --check` only proves syntax. A minimal DOM/fetch stub was written so the
dashboard JS could actually execute against a fake `/data` response:

```
cols          : temp,light
rows buffered : 6
value cell 0  : 23      value cell 1  : 120
chart svg len : 1621
packets       : 42
status        : aktualisiert
toggle query  : &tA=0&tB=0&tC=0&sA=0&sB=0&sC=0
```

Worth keeping: the first run of that harness showed empty `cols`, which looked
like a regression but was a missing `.json()` in the stub's fetch mock.

## 2026-08-25 — serving the dashboard on an existing network

New block **`serve dashboard on WiFi`** (`startWebServerOnWifi`), chosen over
extending the AP block so the working AP path is untouched.

It joins the named network (`CWMODE=1` + retried `CWJAP`), reads back the address
the router assigned, advertises **`calliope.local`** via mDNS, then starts the
*same* server (`CIPMUX=1`, `CIPSTO=10`, `CIPSERVERMAXCONN=5`, `CIPSERVER=1,80`)
and the same background loop. `serverStationMode` is remembered so the `"ready"`
self-heal re-runs the right setup after a module reboot.

**mDNS matters more here than in AP mode.** In AP mode the address is fixed and
printable; on a home network the router chooses it, so without a name the user
has nothing to type. `AT+MDNS` was already in the AP path and is reused verbatim.

**Android still cannot resolve `.local`.** So a second block, **`WiFi IP
address`**, returns the numeric address for display on the LEDs. Its parser
handles both `+CIPSTA:ip:"…"` and the older `+CIPSTA_CUR:ip:"…"`, and returns ""
on ERROR — tested against all four shapes.

**Unverified on hardware.** Two things to watch: whether this firmware's `AT+MDNS`
actually answers OK in station mode (it is ignored if not), and whether the
browser reaches `http://calliope.local` or needs the IP.

## 2026-08-25 — hardware log: mDNS is not in 3.3.0.0, and a real ordering bug

First station-mode run produced three findings.

### 1. `calliope.local` does not work — on either mode

```
>>AT+MDNS=1,"calliope","_http",80
<<...ERROR
```

mDNS is **not compiled into firmware 3.3.0.0**, the build the device was
downgraded to earlier. So the answer to "does it still not work in AP mode?" is:
it never worked in *either* mode on this firmware, and that is a firmware
limitation, not a mode difference. The command is harmless (ignored on ERROR).

Consequences:
- The comment in `doApSetup` claiming iOS/macOS/Windows can use the name was
  misleading on this build; both call sites now record the result.
- New block **`calliope.local available?`** (`mdnsAvailable`, advanced) reports
  what the module actually said, instead of the code implying a name that does
  not resolve.
- **`WiFi IP address` is the reliable route** on 3.3.0.0. Upgrading to 4.x would
  restore mDNS — the same trade-off already recorded for the boot-race fix.

### 2. Real bug: `AT+CIPSERVERMAXCONN=5` returned ERROR

```
>>AT+CIPSERVERMAXCONN=5
<<...ERROR
>>AT+CIPSERVER=1,80
<<...OK
```

The server still started, but on the firmware default connection limit rather
than 5. Cause: **`AT+CIPSERVERMAXCONN` is rejected while a TCP server already
exists**, and `AT+SYSSTORE=0` does not tear one down — so a server left running
from a previous run silently blocked the setting.

Fix: `AT+CIPSERVER=0` before configuring, in **both** `doStationSetup` and
`doApSetup`. Order verified in both: `MDNS → CIPSERVER=0 → CIPMUX=1 → CIPSTO=10
→ CIPSERVERMAXCONN=5 → CIPSERVER=1,80`.

This was latent in the AP path too; it only surfaced now because station mode was
started on a module that had already been serving.

### 3. Unresolved: `AT+GMR` returned no data, then repeated watchdog closes

```
>>AT+GMR
<<[no data]
>>AT+CIPCLOSE=5
<< [TIMEOUT] ... AT+CIPCLOSE=5  OK  [TIMEOUT]
```

The module went quiet, then the idle watchdog began re-firing — meaning no
browser reached the dashboard during that window. Expected if nothing connected
(the watchdog is designed to re-fire), but `AT+GMR` returning nothing at all is
not explained by that. Left open; the next log should show whether it recurs once
`CIPSERVERMAXCONN` is actually applied.

**To retest:** `WiFi.wifiIpAddress()` on the display, then browse to that IP.
Expect `calliope.local available?` to read false on 3.3.0.0.

## 2026-08-25 (correction) — mDNS IS supported on 3.3.0.0

**I was wrong in the previous entry.** The user reports `calliope.local` working
on their 3.3 board, which contradicts my conclusion that mDNS is absent from that
firmware. Their observation is right and my inference was not.

Checked against the esp-at source in `/home/hugo/fw/WiFi/esp-at`:

- `main/Kconfig:101` — `config AT_MDNS_COMMAND_SUPPORT ... default "y"`.
- The modules that disable it (`CONFIG_AT_MDNS_COMMAND_SUPPORT=n`) are
  `esp32c2-2mb-ble*`, `esp32c3_rainmaker`, `wrover-32` and the override example.
  **`module_esp32c3_default` is not among them.**
- The command syntax we send matches the documented example exactly
  (`AT+MDNS=1,"espressif","_iot",8080`).

So mDNS is compiled in, and the `ERROR` in the log means something else.

**Most likely cause: `AT+MDNS=1` is refused when mDNS is already enabled.** The
setup can easily run twice — the `"ready"` self-heal re-runs it after any module
reboot — and the second call then errors while the name keeps working from the
first. That fits the evidence exactly: an ERROR in the log *and* a resolving
hostname.

Fix: send `AT+MDNS=0` before `AT+MDNS=1` in **both** `doStationSetup` and
`doApSetup`, making the call idempotent. Order now:
`MDNS=0 → MDNS=1 → CIPSERVER=0 → CIPMUX=1 → CIPSTO=10 → CIPSERVERMAXCONN=5 →
CIPSERVER=1,80`.

The `calliope.local available?` block and its doc comment were corrected: it
reports what the module answered, with no claim about specific firmware versions.
The remaining real caveat is Android, which does not resolve `.local` regardless.

**Lesson for these notes:** "command returned ERROR" is not the same as "feature
unsupported". I asserted the stronger claim from the weaker evidence, and the
source was available locally the whole time to check.

## 2026-08-25 — does calliope.local work in AP mode?

Checked the esp-at source rather than inferring this time.

**The command is mode-agnostic.** Nothing in `AT+MDNS`'s spec
(`docs/en/AT_Command_Set/TCP-IP_AT_Commands.rst:2559+`) or in `main/Kconfig`
restricts it to station mode, so the module does advertise `calliope.local` on
its SoftAP. With the `AT+MDNS=0` reset added earlier it should now answer OK in
both paths.

**Whether it RESOLVES is a client question, and AP mode is the harder case:**

| client | station mode | AP mode |
| --- | --- | --- |
| macOS / iOS | yes (Bonjour) | usually |
| Windows | yes | usually |
| Android | **no** | **no** |

Two things make AP mode weaker, neither of them firmware:

- Android does not resolve `.local` at all, in either mode.
- On a network with no internet, phones often keep mobile data as the default
  route and never send the mDNS query to the Calliope's network.

Worth noting the official example (`TCP-IP_AT_Examples.rst:1869`) demonstrates
mDNS in **station mode** only — it is not evidence against AP mode, but it is
what the vendor exercises.

So: the name is worth advertising in AP mode, and `10.0.0.1` remains the answer
that always works.

Tidy-ups while here:

- The AP comment no longer claims the firmware might lack mDNS (that was the
  incorrect inference corrected above); it now separates "the module announces
  the name" from "the client resolves it".
- **`WiFi IP address` now works in AP mode too**, returning the access point
  address instead of an empty string. Previously it was only populated by
  station mode, which made it useless in exactly the mode where a user is most
  likely to need a number to type.
- The AP address is now a single `AP_IP` constant used by both `AT+CIPAP` and
  `wifiIpAddress()`, so the pinned address and the reported one cannot drift.
