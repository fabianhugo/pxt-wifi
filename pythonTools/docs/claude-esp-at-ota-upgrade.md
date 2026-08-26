# ESP-AT OTA upgrade over UART (ESP32-C3)

Working notes on upgrading AT firmware on an ESP32-C3 that is reachable only
through its two AT UART lines — no USB, no BOOT/EN control.

## Notes

### 2026-08-19 — Hardware access constraints

The C3 has two distinct UART pin pairs, and which one is exposed decides
everything:

- **AT command port**: TX:7 / RX:6 (CTS:5, RTS:4) for `MINI-1`, per
  `components/customized_partitions/raw_data/factory_param/factory_param_data.csv:9`.
- **ROM serial bootloader**: UART0 = GPIO21 (TX) / GPIO20 (RX), hardwired and
  not remappable. esptool needs *this* pair plus GPIO9 (BOOT) and EN to force
  download mode.

This setup has the **AT lines**, so esptool-style wired flashing is unavailable.
All upgrades must go over the air via AT commands.

`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=n` in
`module_config/module_esp32c3_default/sdkconfig.defaults:166-167` — USB-Serial-JTAG
console is disabled in this build anyway.

Quick pin identification: send `AT\r\n` at 115200. `OK` → AT pins (GPIO6/7).
Silence plus an `ESP-ROM:esp32c3-...` banner on reset → bootloader pins.

### 2026-08-19 — Version landscape (corrected twice; see Decisions)

Checked out tag is **v5.0.1.0**. What that tree says about released C3 firmware
(`docs/en/AT_Binary_Lists/esp_at_binaries.rst:169-171`):

```
- v4.1.1.0 ESP32-C3-MINI-1-AT-V4.1.1.0.zip  (Recommended)
- v4.1.0.0 ESP32-C3-MINI-1-AT-V4.1.0.0.zip
- v3.3.0.0 ESP32-C3-MINI-1-AT-V3.3.0.0.zip
```

**v5.0.1.0 is not a released C3 firmware.** The v5.0.x entries in that file sit
under `.. only:: esp32c5` and `.. only:: esp32c61` (lines 194-195, 218-219) — the
C5/C61 4MB series, and those are application-form gated rather than direct
downloads. The repo tag version and per-chip binary availability are independent.

C3 binaries at v4.1.1.0 and below are plain `dl.espressif.com` zips (no form).

ECO compatibility: v3.3.0.0 through v4.1.1.0 cover ECO0 (Rev v0.0) – ECO7
(Rev v1.1). Pre-3.3.0.0 stops at ECO4.

### 2026-08-19 — Partition table and IDF stability

C3 partition table is **byte-identical** across v3.3.0.0, v4.1.0.0, v4.2.0.0 and
v5.0.1.0 (verified with `diff` on `partitions_at.csv`):

```
otadata      data ota   0xd000   0x2000
phy_init     data phy   0xf000   0x1000
nvs          data nvs   0x10000  0xE000
at_customize 0x40 0     0x1E000  0x42000
ota_0        app  ota_0 0x60000  0x1d0000
ota_1        app  ota_1 0x230000 0x1d0000
```

This removes the layout-mismatch brick risk for OTA in either direction — OTA
cannot rewrite the bootloader or partition table, so a changed layout would have
been disqualifying.

IDF versions (`module_config/module_esp32c3_default/IDF_VERSION`):

- v3.3.0.0 → `release/v5.0` @ `bcca6898`
- v4.1.0.0 → `release/v5.4` @ `8ad0d3d8`
- v5.0.1.0 → `release/v5.4` @ `8ad0d3d8` (identical to 4.1.0.0/4.2.0.0)

So for the C3, moving the checkout from v4.2.0.0 to v5.0.1.0 buys nothing at the
platform level. The 5.0 work went into newer targets (C5, C61, expanded C2
module variants).

### 2026-08-19 — Why upgrade 3.3.0.0 → 4.1.x

From 350 commits between the tags, filtered to C3-relevant:

1. **ESP-IDF v5.0 → v5.4** — four minor releases of Wi-Fi/BLE, lwIP, mbedTLS
   fixes, including security patches that never surface as ESP-AT commits.
2. **OTA reliability** — `f1ca7891` second OTA would fail; `be1eb1b7` OTA
   automatic rollback; `a7164994`/`fc649b18` app rollback + `AT+SYSROLLBACK`.
3. **Light-sleep / UART electrical** — `11827027` reboot when UART1 RX floats
   after light-sleep; `95c66734`, `f9e99ef9` UART voltage fluctuation;
   `1ff6888b` GPIO voltage fluctuation.
4. **Crash fixes** — `371b9fc4` crash if AT command arrives before AT is ready
   (classic host-MCU boot race); `1e83847c` 32-byte `AT+CWHOSTNAME`;
   `4695db03` webserver; `23922ed6` debug-log path; `9fdd183f` websocket.
5. **TLS cert config for HTTP/WebSocket** — `04b6f63e`, `18255f6b`.
6. **New log system** — `ef405e75`, documented in `9f434179`.

Caveat: a four-release IDF jump can shift Wi-Fi/BLE behaviour and timing subtly.
Re-test host MCU command sequencing rather than assuming drop-in.

### 2026-08-19 — OTA command mechanics

**`AT+CIUPDATE` (cloud)** — `docs/en/AT_Command_Set/TCP-IP_AT_Commands.rst`:

- `AT+CIUPDATE=<ota mode>[,<"version">][,<"firmware name">][,<nonblocking>]`
- mode 0 = HTTP, 1 = HTTPS (needs `OTA based upon ssl` in menuconfig)
- States: 1 server found, 2 connected, 3 got version, 4 done, -1 failed
- Blocking mode is preferable: the docs warn that in non-blocking mode `OK`
  "does not necessarily come before" the `+CIPUPDATE:<state>` lines.
- Process timeout is **3 minutes**.
- **Only serves official Espressif binaries** — a self-compiled build is
  rejected. And the `<version>` parameter is for compatibility matching, not
  target selection, so **the version cannot be pinned**.

**`AT+USEROTA` (pinned)** — `docs/en/AT_Command_Set/user_at_commands.rst:111`:

- Two-step: `AT+USEROTA=<url len>` → `OK` + `>` prompt → send raw URL bytes →
  `Recv <n> bytes` → `OK`
- After the `>` prompt the URL needs **no escaping** and must **not** end with
  CR-LF (line 185).
- Max URL length 8192 bytes.
- For C3 the image is `build/esp-at.bin` (line 174). C2-2MB and C5/C61 use the
  compressed `esp-at.bin.xz.packed` instead.
- HTTPS works, but SSL verification is "not recommended" without provisioning
  your own PKI files — plain HTTP is simplest on a LAN.

**`AT+SYSROLLBACK`** — `docs/en/AT_Command_Set/Basic_AT_Commands.rst:1827`:

- `AT+SYSROLLBACK?` → `+SYSROLLBACK:<run_addr>,"<run_ver>",<rb_addr>,"<rb_ver>"`
- Execute form switches to the image in the other OTA partition. "This command
  will not upgrade via OTA" (line 1874) — no network required.
- Query command added in v4.x (ESPAT-2222), so it may be absent on 3.3.0.0.

### 2026-08-19 — Downgrade feasibility

Possible. `module_config/module_esp32c3_default/sdkconfig.defaults:13-14`:

```
CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y
CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n
```

Anti-rollback **disabled** → no secure-version counter blocks older images.
Rollback protection **enabled** → a new image must confirm itself valid or the
bootloader reverts automatically. That is a safety net, not an obstacle.

Vendor caveat appears identically in both OTA command docs: downgrading "is not
recommended due to potential compatibility issues and the risk of operational
failure." The real hazard is **persistent state** — newer firmware may write NVS
or `at_customize` structures an older build cannot parse. Hence `AT+RESTORE`
after any version change, and close to mandatory on a downgrade. Note
`AT+RESTORE` clears saved Wi-Fi credentials, so plan to re-provision.

`AT+SYSROLLBACK` is the safer downgrade route — it returns to an image that
previously ran on this exact device.

### 2026-08-19 — Gotchas found while writing the tooling

- **Flow control**: ESP-AT ships `CONFIG_AT_UART_DEFAULT_FLOW_CONTROL=1` (RTS
  enabled). On a TX/RX-only harness the module can stall waiting on CTS. First
  thing to suspect when bare `AT` gets no answer.
- **`AT+GMR` version parsing**: the version is followed by a parenthesised
  commit/target/date — `AT version:4.1.1.0(abc - ESP32C3 - Jan 1 2025)`. A naive
  `\S+` regex captures `4.1.1.0(abc`, which breaks before/after comparison. Stop
  at the paren.
- **`AT version` vs `Bin version`**: `AT version` is the closed-source core
  library version and tracks the `x.x.x.x` release numbering. `Bin version` is
  the freely-editable project version from menuconfig and may not match any
  official release. The docs' own example shows them disagreeing (2.2.0.0-dev vs
  2.1.0). Read the release version off `AT version`.

### 2026-08-19 — Live upgrade result: 3.3.0.0 -> 4.2.0.0 (succeeded)

Ran the cloud path (`AT+CIUPDATE`, HTTPS, blocking) on real hardware over
`/dev/ttyACM0`. States 1-4 progressed normally; upgrade completed and rebooted.

Post-upgrade `AT+GMR`:

```
AT version:4.2.0.0(9b8caf0 - ESP32C3 - Aug  7 2026 06:52:24)
SDK version:v5.4.4
compile time(8a803bdb):Aug  7 2026 12:16:00
Bin version:v4.2.0.0(MINI-1)
```

`compile time(8a803bdb)` matches the IDF commit in
`module_config/module_esp32c3_default/IDF_VERSION` — the official binary was
built against the same IDF tree this checkout pins.

**Finding: the OTA server ships v4.2.0.0 for C3 even though the v5.0.1.0 tag's
binary list stops at v4.1.1.0** (marked "Recommended"). The docs' Recommended
marker lags what the cloud actually serves. So a v4.2.0.0 official C3 binary
does exist; it is simply absent from that tag's `esp_at_binaries.rst`. Do not
treat the binary list as authoritative for what OTA will deliver.

**Finding: `AT+SYSROLLBACK?` version strings are `git describe` output from
build time and can look alarming while being stock.**

`AT+SYSROLLBACK?` after the upgrade reports:

```
+SYSROLLBACK:0x230000,"v4.2.0.0",0x60000,"v2.4.0.0-649-gbe332568-dirty"
```

The rollback slot's `v2.4.0.0-649-gbe332568-dirty` initially read as a
self-compiled developer build. It is **stock, official v3.3.0.0**:

```
$ git describe --tags be332568
v3.3.0.0
$ git log -1 be332568
be3325688ac20b36022c1041d9bc6018e124137b (tag: v3.3.0.0)
Wed May 8 16:20:17 2024 +0800
Merge branch 'feature/update_at_version' into 'master'
```

Why the string is misleading:

- `AT+SYSROLLBACK?` reports the **app-descriptor** (`esp_app_desc_t`) version
  from each partition's image, which ESP-AT fills from the *project* version
  (menuconfig `Application manager` → `Project version`), not the closed-source
  AT core version. Hence `AT version:3.3.0.0` alongside a `2.4.0.0-...`
  descriptor — the same core-vs-project independence noted above.
- `-649-g<sha>` is a `git describe` fallback: at build time the newest
  *reachable* tag was v2.4.0.0, 649 commits back, because the `v3.3.0.0` tag had
  not been created yet. A local repo that now has the tag resolves it cleanly.
- `-dirty` is expected for vendor release builds, which inject module config
  (`sdkconfig`, factory params, module selection) as working-tree edits.

Consequences:

1. **Rollback returns to stock 3.3.0.0** and is fully reproducible from tag
   `v3.3.0.0` in this repo.
2. **No cloud-OTA anomaly.** An earlier note here claimed the server had served
   a self-compiled device, contradicting the docs. It had not — the device was
   running official firmware, so the documented "official binaries only"
   restriction held. Do not assume leniency there.

Rule: before concluding a partition holds a custom build, run
`git describe --tags <sha>` on the embedded hash. Bare ESP32-C3 silicon ships
with only the ROM bootloader and blank flash, so an AT image in flash always
came from someone's flashing step — manufacturer or otherwise — never from the
chip vendor.

Running from `ota_1` (0x230000) with the previous image in `ota_0` (0x60000),
matching `partitions_at.csv` exactly. `AT+SYSROLLBACK?` errored before the
upgrade (absent in 3.3.0.0-era firmware, added v4.x via ESPAT-2222) and works
after — so the rollback escape hatch only exists post-upgrade.

### 2026-08-19 — DTR/RTS on CDC-ACM adapters (cost one failed attempt)

First real-hardware run hung at `>> AT` with no reply, despite another serial
monitor working on the same port. Cause was in the script, not the wiring:

```python
self.ser.setDTR(False)   # wrong for CDC-ACM
self.ser.setRTS(False)
```

The port was `/dev/ttyACM0` — a **Raspberry Pi Debug Probe (CMSIS-DAP)**,
`2e8a:000c`. CDC-ACM devices commonly treat **DTR as a "host present" signal**
and will not transmit when it is deasserted. The original deassert was written
for CP210x/FTDI bridges wired to an ESP boot circuit, where DTR/RTS drive
EN/BOOT and deasserting is correct.

Fix in `tools/at_ota_upgrade.py`: `--lines {auto,assert,deassert,leave}`, where
`auto` asserts for `ttyACM*` ports and deasserts otherwise. `wait_ready()` also
flips the polarity and retries once before failing, and now distinguishes "no
bytes at all" from "bytes but never a clean OK" (baud mismatch / boot-log noise).
Added `--raw` to dump unprompted device output for diagnosis.

Rule of thumb: **`ttyUSB*` → deassert DTR/RTS; `ttyACM*` → assert.** When a
different tool works on the same port and yours does not, suspect DTR first.

### 2026-08-19 — No stock path updates AT firmware without Wi-Fi

Confirmed limitation. Every stock update path needs either the network or the
ROM bootloader:

- `AT+CIUPDATE`, `AT+USEROTA` — reach `ota_0`/`ota_1`, but download over Wi-Fi.
- `AT+SYSFLASH` — streams binary over the **AT UART** (length, `>` prompt, raw
  bytes, same idiom as `AT+USEROTA`) but is restricted to **user partitions**
  declared in `at_customize.csv` (`mfg_nvs`, `fatfs`). Cannot write app
  partitions. `AT+SYSFLASH?` enumerates what is writable.
  Docs: `docs/en/AT_Command_Set/Basic_AT_Commands.rst:1330`.
- esptool — needs UART0 (GPIO20/21), not accessible on this hardware.

So with only the AT pins exposed, updating AT firmware **requires Wi-Fi**.

`--serve` narrows the requirement usefully though: the module only needs to reach
a local HTTP server, not the internet. An isolated AP with no uplink suffices,
which also removes the Espressif-cloud dependency and pins the version.

A custom AT command could close the gap entirely — `AT+SYSFLASH` proves the
transport works, it just points at the wrong partitions. Design sketch in
[claude-uart-ota-custom-command.md](claude-uart-ota-custom-command.md).
Bootstrap catch: that firmware is self-compiled, so it must be installed once via
Wi-Fi OTA, and self-compiled builds forfeit `AT+CIUPDATE` (cloud) thereafter.

### 2026-08-19 — BOOT pin alone does not enable wired flashing

Hardware has a BOOT pin (pulls GPIO9 low) but only the AT UART pins broken out.
That combination does **not** enable esptool:

Download mode listens on **UART0 = GPIO20/21 only**. Holding GPIO9 low at reset
enters download mode, but with nothing on 20/21 there is no one to talk to — and
the AT firmware is not running, so GPIO6/7 go silent. Result is a chip waiting
for esptool on unreachable pins, recoverable only by power-cycling.

BOOT pin and bootloader UART pins must come as a pair. The BOOT pin is still
worth having as a **recovery** aid: it guarantees a bricked module can be revived
by anyone able to get probes onto the GPIO20/21 pads.

Corrects an earlier overstatement in this session that flashing over the AT lines
was "impossible" — the AT pin assignment is software-defined (stored in
`mfg_nvs`, from `factory_param_data.csv`) and the C3 GPIO matrix can route UART0
almost anywhere, so remapping the AT port onto 20/21 is technically possible.
Rejected as a working approach: it destroys the recovery path (no strap to retry
with if a write fails) to solve a problem that does not exist here, since the
partition table needs no changes.

## Decisions

### 2026-08-19 — Tooling: single script, three OTA paths

Wrote `tools/at_ota_upgrade.py` (pyserial). Modes:

- `--serve BIN` — spin up a local HTTP server, auto-derive the URL from the
  route back to the device, `AT+USEROTA` to it. **Recommended for pinning.**
- `--url URL` — `AT+USEROTA` to an existing server.
- default — cloud `AT+CIUPDATE`; warns that it cannot be pinned.
- `--rollback` — `AT+SYSROLLBACK`, no network.
- `--dry-run` — reachability + version report, stops before touching flash.
- `--restore` — opt-in `AT+RESTORE`. Not default: it wipes Wi-Fi credentials,
  which on a UART-only board means re-provisioning.

Chose **blocking mode** for `AT+CIUPDATE` to avoid the documented `OK`/state
ordering race. Chose **`--restore` opt-in** rather than following the docs'
blanket recommendation, because credential loss is a real cost here and the
partition table stability makes state corruption less likely on an upgrade.

Verified without hardware: compile, arg validation, mutual exclusion, HTTP
server byte-exactness, port auto-selection, route-based IP detection, the
`AT+USEROTA` handshake against a fake serial device (length prefix, `>` prompt,
no-CR-LF payload, `Recv`/`OK`), rejected-command and oversize-URL error paths,
and `AT+GMR` parsing across three output styles. **Serial interaction against a
real device is untested.**

### 2026-08-19 — Recommend v4.1.1.0, not v5.0.1.0, for this chip

v4.1.1.0 is the vendor-recommended C3 release, is a direct download, and shares
the v5.4 IDF with everything newer. Building the v5.0.1.0 checkout for C3 would
produce a self-compiled binary with no matching official release, off the
supported path, and ineligible for cloud OTA — for no measured gain.

Alternatives rejected:
- **v4.2.0.0** — not listed as a released C3 binary in the v5.0.1.0 tree.
- **v5.0.1.0** — C5/C61 only; see above.
- **Staying on 3.3.0.0** — forgoes the IDF v5.0→v5.4 jump and the OTA/crash
  fixes listed above.

### 2026-08-19 — Corrections to earlier claims in this session

Two statements made earlier were wrong and are retracted here for the record:

1. Claimed "there is no ESP-AT v4.2 for the ESP32-C3" — that was based on a
   stale `master` checkout showing v3.3.0.0 as newest.
2. Claimed "v4.2.0.0 is the recommended C3 release and is application-form
   gated" — the v5.0.1.0 tree does not support this; v4.1.1.0 is recommended and
   the form gating applies to C5/C61 v5.0.x entries.

Follow-up (same day): correction 1 was itself partly wrong. The live OTA
delivered an official **v4.2.0.0** C3 binary, so a v4.2 for this chip does exist
— it is simply missing from the v5.0.1.0 tag's binary list. Lesson stands but
inverts: the binary list is not authoritative in *either* direction. It can omit
versions the OTA server will happily serve. Verify against the device, not only
the docs.

Third correction (same day): also claimed the pre-upgrade image was a
self-compiled build and that the rollback slot was unreproducible. Both wrong —
`be332568` is tag `v3.3.0.0`, i.e. stock firmware. See the
`AT+SYSROLLBACK?`/`git describe` note above. Root cause: read a
`git describe`-style version string as evidence of provenance without resolving
the embedded commit hash against the repo. One command (`git describe --tags
<sha>`) would have settled it immediately.

Root cause both times: reading version claims without pinning which tag the
working tree was on. **Check `git describe --tags` before quoting the binary
list.** The docs are `.. only::`-scoped per chip, so a grep hit for a version
string says nothing about which chip's section it belongs to — always confirm the
enclosing `.. only::` directive.

### 2026-08-25 — OTA exposed as MakeCode blocks (main.ts)

Added two blocks to the WiFi extension (`main.ts`, group *UartWiFi*, all
`advanced=true`), following `at_ota_upgrade.py`:

- **`upgrade WiFi firmware (OTA)`** → `upgradeFirmware()` — `AT+CIUPDATE=1`
  (HTTPS, **blocking**), narrating nothing but tracking the `+CIPUPDATE:<state>`
  codes. Returns true only when state **4** *and* a final `OK` are seen.
- **`restore previous WiFi firmware`** → `restoreFirmware()` — `AT+SYSROLLBACK`,
  no network.
- **`firmware upgrade state`** → `upgradeState()` — last `+CIPUPDATE` code
  (0/1/2/3/4/-1) for diagnosing a failure.

Decisions, all inherited from the script and the notes above:

- **Blocking mode** (`AT+CIUPDATE=1`, no trailing `,1`). Non-blocking is unusable
  here: the docs warn `OK` "does not necessarily come before" the `+CIPUPDATE`
  lines, so a boolean return could not be trusted.
- **`OK` alone is not success.** The reply must reach state 4 first — there is an
  explicit regression test for an `OK` that never reached state 4 returning
  `false`.
- **240 s timeout**, matching `OTA_TIMEOUT` in the script (docs say 3 min).
- **`isWifiConnected = false`** after either operation: the module restarts and
  credentials do not survive, so `wifiOK()` must not keep claiming a connection.
  8 s pause then `clearSerialBuffer()` before returning, mirroring the script.
- No `AT+USEROTA` block. It needs a URL the user must host, plus a two-step
  `>`-prompt upload — the wrong shape for a block, and the cloud path is what
  "upgrade via Espressif server" asked for.
- No `AT+RESTORE`. It wipes Wi-Fi credentials to factory defaults, which is a
  much bigger hammer than "reset to the old firmware".

**Caveat carried into the block comment:** per the 2026-08-19 finding above,
`AT+SYSROLLBACK` only works *after* an upgrade — a module still on its original
firmware has no second image, and pre-v4.x firmware lacks the command entirely.
The block returns `false` in both cases rather than pretending.

Verified host-side against a mocked module: success path (states 1→2→3→4 + OK),
`+CIPUPDATE:-1`, bare `ERROR`, `OK`-without-state-4, and a total stall (waits the
full 240 s then fails); rollback OK and rollback ERROR. Existing time blocks
re-checked for regressions. **Not run on hardware** — and unlike the time blocks,
a bad OTA has real consequences, so the first hardware run should be attended.

### 2026-08-25 (later) — logging bug, version block, on-screen progress

**Bug: `>>AT+CIUPDATE=1` never appeared in the debug UART.** `sendAtCmd` only
stashes the command in `pendingCmd`; `debugLog()` prints it together with the
reply. That deferral exists so the slow bit-banged logger cannot eat a reply that
is about to arrive — but for OTA the reply is *minutes* away, so the command line
only appeared after the upgrade finished, or never if the device was reset first.

Added `debugLogCmd()`, which flushes just the `>>command` line, and called it
right after `sendAtCmd("AT+CIUPDATE=1")`. Safe precisely because the module
cannot answer for several seconds. Regression test asserts the line is the
**first** thing logged.

**Is there progress? Partly.** The module emits only the four `+CIPUPDATE`
states (server found / connected / got version / done) — there is no byte or
percentage feedback during the download, which is the long part. So a true
percentage bar is not possible.

**On-screen display during the upgrade** (`otaAnimate`, called from the existing
wait loop):

- **bottom row** = state gauge, one LED per completed `+CIPUPDATE` state — real
  progress, 0–4;
- **top row** = a dot chasing left→right each frame, so a state that takes a long
  time still looks alive rather than frozen.

Driven from inside the read loop (~every 100 ms), using only `led.plot`/`unplot`.
Deliberately **not** `basic.showAnimation` or a second fiber: those pause
internally, which would stall the read loop and lose the module's output — the
same class of bug as the softSerial blocking issue. `basic.clearScreen()` on exit.

**New block: `WiFi firmware version`** → `AT+GMR`, returning e.g. `"4.1.1.0"`.
Parses the `AT version:` line and stops at `(`, dropping the
`(commit - target - date)` decoration exactly as `at_ota_upgrade.py:230` does, so
before/after comparisons match as plain strings. Empty string if the module does
not answer. Reads the whole reply rather than waiting on `OK`, because `AT+GMR`
prints several lines and the wanted one comes first.

Verified: version parsing with and without the paren decoration and on `ERROR`;
the command-logged-first assertion; gauge reflects the state; chase dot advances
and erases the previous LED; screen cleared afterwards.

### 2026-08-25 (UI pass) — display changes and AT+RESTORE after rollback

**Display, per user feedback:**

- `basic.clearScreen()` now runs at the **start** of `upgradeFirmware()`, before
  any waiting, so the OTA begins on a blank screen.
- **Progress gauge removed.** The user observed it rises to 3 LEDs within seconds
  and then sits there for the whole download — because `+CIPUPDATE:3` ("got the
  upgrade version") arrives early and the long download that follows emits
  nothing. A gauge that freezes reads as a hang, so it was worse than no gauge.
- **Dots → columns.** `otaAnimate(frame)` now sweeps a full 5-LED vertical bar
  left to right; the whole screen moves, which is legible from across a room.
- **Slowed 100 ms → ~400 ms per step** (advance on every 4th loop tick). The read
  loop still ticks at 100 ms — only the animation is decimated, so nothing about
  the serial timing changed.

**`AT+RESTORE` after `AT+SYSROLLBACK` — the user was right.**

Per the vendor caveat recorded above, a downgrade's real hazard is persistent
state: newer firmware may write NVS / `at_customize` structures an older build
cannot parse. The notes call `AT+RESTORE` "close to mandatory on a downgrade",
and `at_ota_upgrade.py` offers it via `--restore`. Rollback *is* a downgrade, so
`restoreFirmware()` now issues `AT+RESTORE` after a successful rollback, waits
out the second restart, and returns.

Consequences handled:

- It **erases saved Wi-Fi credentials**, so the block is renamed
  **"restore previous WiFi firmware (clears WiFi settings)"** — a destructive
  side effect belongs in the block name, not only in a comment.
- `AT+RESTORE` runs **only if the rollback succeeded**. Wiping credentials after
  a rollback that never happened would be pure damage; there is a regression test
  asserting no `AT+RESTORE` on the `ERROR` path.

**Logging detail:** the two immediate `debugLogCmd()` calls initially added in
`restoreFirmware` were removed. `waitAtResponse` follows each command directly
and already prints `>>cmd` with the reply; flushing early blocks ~39 ms, which
exceeds what the 254-byte RX buffer holds at 115200 baud (~22 ms) and could
swallow the `OK`. `debugLogCmd()` remains correct **only** for `AT+CIUPDATE`,
whose reply is minutes away.

Verified: clear-at-start happens before any wait; a frame lights a full column of
5 and fully erases the previous one; the sweep covers all 5 columns; `AT+RESTORE`
is ordered after `AT+SYSROLLBACK`; and no `AT+RESTORE` when rollback fails.

### 2026-08-25 — "I upgraded, then power-cycled: did I lose the rollback?"

Almost certainly not. Reasoning from the facts already recorded above:

- **OTA writes to the *other* partition.** The hardware run showed the device
  running from `ota_1` (0x230000) with the previous image still in `ota_0`
  (0x60000). Nothing erases `ota_0`, and a power cycle does not alter flash
  contents.
- **`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`** means a new image must confirm
  itself valid or the bootloader reverts automatically. So either the new
  firmware booted and self-confirmed (both slots intact, rollback available), or
  it was broken and the bootloader already put the old one back. Neither outcome
  strands the device.
- **`CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n`** — no secure-version counter can
  refuse an older image.

The one genuine loss scenario is a power cut **during** the flash write, which
leaves the target partition incomplete — but then the bootloader keeps running
the *old* image, so the user would still be on their previous firmware, not
stuck on the new one.

Rather than reason at the user, added two **non-destructive** blocks so the
device can answer for itself:

- **`previous WiFi firmware available?`** → boolean.
- **`previous WiFi firmware version`** → the rollback slot's version string.

Both issue the **query** form `AT+SYSROLLBACK?` only. There is a regression test
asserting the executing form `AT+SYSROLLBACK` is never sent — getting that wrong
would roll the device back merely for asking a question.

Parser takes the text inside the *second* quoted pair of
`+SYSROLLBACK:<run_addr>,"<run_ver>",<rb_addr>,"<rb_ver>"`. Tested against the
exact hardware string recorded above
(`...,"v4.2.0.0",0x60000,"v2.4.0.0-649-gbe332568-dirty"`), a simple version, an
empty slot, and `ERROR` from pre-v4.x firmware.

Reminder from the earlier finding: an alarming-looking descriptor such as
`v2.4.0.0-649-gbe332568-dirty` is **stock v3.3.0.0** — it is `git describe`
output, not evidence of a custom build.

### 2026-08-25 — Both OTA slots now hold v4.2.0.0: the original is gone

User reported rollback not working and supplied:

```
+SYSROLLBACK:0x230000,"v4.2.0.0",0x60000,"v4.2.0.0"
```

Compare with the state recorded after the *first* upgrade (line ~199):

```
+SYSROLLBACK:0x230000,"v4.2.0.0",0x60000,"v2.4.0.0-649-gbe332568-dirty"
```

| | running (`ota_1`) | rollback slot (`ota_0`) |
| --- | --- | --- |
| after first OTA | v4.2.0.0 | `v2.4.0.0-649-g...` = stock **v3.3.0.0** |
| now | v4.2.0.0 | **v4.2.0.0** |

**Cause: the OTA was run more than once.** Each OTA writes to whichever
partition is *not* running, alternating. Upgrade #1 wrote v4.2.0.0 into `ota_1`
and left the factory v3.3.0.0 in `ota_0`. Upgrade #2, running from `ota_1`, wrote
v4.2.0.0 into `ota_0` — overwriting the only copy of the original image.

**The power cycle was not the cause.** Flash contents survive power loss, and the
partition layout above is unchanged. `AT+SYSROLLBACK` still "works" mechanically;
it just switches between two identical images, which looks like nothing
happening.

**Consequence for the blocks:** `previous WiFi firmware available?` returns true
here (the slot is populated and parseable) even though rolling back is pointless.
Comparing it against `WiFi firmware version` is the honest check — if the two
match, there is nothing to go back to. Worth considering a block that reports
this directly rather than leaving the user to compare strings.

**Recovery — the original is still obtainable.** `AT+CIUPDATE` cannot help (the
`<version>` parameter is compatibility matching, not target selection, so the
cloud only ever gives "latest"). But anti-rollback is disabled
(`CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n`), so flashing an older image directly
works, which is exactly what the script's own header documents:

1. Download `ESP32-C3-MINI-1-AT-V3.3.0.0.zip` — verified reachable 2026-08-25 at
   `https://dl.espressif.com/esp-at/firmwares/esp32c3/ESP32-C3-MINI-1-AT-V3.3.0.0.zip`
   (C3 binaries ≤ v4.1.1.0 are plain zips, no download form — see line ~45).
2. `./at_ota_upgrade.py --serve <path>/esp-at.bin --restore`
   (`--serve` runs a local HTTP server and drives `AT+USEROTA`; `--url` if hosting
   it elsewhere).
3. `--restore` matters here: this is a downgrade, so `AT+RESTORE` clears NVS /
   `at_customize` state the newer build may have written. It erases Wi-Fi
   credentials — re-provision afterwards.

Note this writes v3.3.0.0 into the *inactive* slot, so afterwards the rollback
slot holds v4.2.0.0 again — the escape hatch is restored in the other direction.

### 2026-08-25 — Recovery to 3.3.0.0 succeeded; AT+RST vs AT+RESTORE

The downgrade worked. Two notes from it.

**The `--serve` argument must be the unpacked image, not the zip.** First attempt
served `ESP32-C3-MINI-1-AT-V3.3.0.0.zip` directly and failed with
`ConnectionResetError` mid-download plus the generic "Pinned OTA failed" — the
device began fetching, found no valid image header, and dropped the connection.
`AT+USEROTA` wants the single OTA app image, for C3
`ESP32-C3-MINI-1-AT-V3.3.0.0/build/esp-at.bin`. Not the `factory/` image and not
the individual `bootloader.bin` / `partition-table.bin`, which are for wired
esptool flashing at fixed offsets. Sanity check: a valid image is ~1–2 MB and its
first byte is `0xE9`.

*Possible script improvement:* reject a file whose first byte is not `0xE9` (or
whose name ends `.zip`) before starting the server, instead of letting the device
discover it mid-flash.

**`AT+RST` is not a substitute for `AT+RESTORE` in the rollback block.** The user
saw `[5/5] Restarting to boot the new image → AT+RST` during the `--serve`
downgrade and asked whether the rollback block should use that instead. It should
not — they solve different problems, and the script itself uses both:

| command | role |
| --- | --- |
| `AT+RST` | plain reboot. Needed after `AT+USEROTA` / `AT+CIUPDATE`, which flash the image but do **not** restart. |
| `AT+RESTORE` | clears NVS / `at_customize` to factory defaults, then reboots. The downgrade-safety step. |

Decisive detail: `do_rollback()` issues **no `AT+RST` at all** — `AT+SYSROLLBACK`
restarts the device itself ("Rollback issued; device is restarting"). `--restore`
is then applied optionally, exactly as in the OTA path. So the `AT+RST` the user
saw belongs to the OTA path only.

Since rollback is *always* a downgrade, and the notes above call `AT+RESTORE`
"close to mandatory on a downgrade", swapping it for `AT+RST` would drop the one
protection that matters most there. `restoreFirmware()` already mirrors
`do_rollback()` exactly — `AT+SYSROLLBACK` → 8 s → `AT+RESTORE` → 6 s, no
`AT+RST` — and is left unchanged. Decision confirmed with the user.

### 2026-08-25 — Endless ">>AT / [TIMEOUT]" after hot-plugging the module

Symptom: rarely, when the WiFi board is connected to an **already-powered**
Calliope, `setupWifi` loops forever printing `>>AT` / `<< [TIMEOUT]`. Pressing
reset on the mini does **not** help; only repowering the module does.

**The user's guess was right: it is the boot race, and it crashes the module.**
This is esp-at commit `371b9fc4`, already listed at line ~90 of these notes:
*"crash if AT command arrives before AT is ready (classic host-MCU boot race)"*.

Two details make the diagnosis fit exactly:

- It is a **crash**, not a dropped command. A merely-slow module would answer on
  a later retry; a crashed one answers nothing, so the 20 s retry loop spins to
  no purpose.
- Resetting the **mini** cannot fix it. The mini reboots and starts probing
  again; the *module* is still crashed and still silent. Only module power does
  it — which matches the report precisely.

**And it is now more likely, not less:** `371b9fc4` is among the ~350 commits
between v3.3.0.0 and v4.1.x, so the fix is **absent** from the 3.3.0.0 the device
was just downgraded to. Worth stating plainly: staying on 4.2.0.0 would avoid
this failure mode; the downgrade re-introduced it.

**Mitigations added to `setupWifi` (helpful on any firmware version):**

1. **Wait before speaking.** Up to 1.5 s listening for the module's `ready`
   banner *before* the first `AT`, breaking the race instead of losing it. Capped,
   because a module that booted long ago will never print `ready` again — that
   path just falls through.
2. **`AT+RST` when it stays silent**, at retry 6 and again at 20. A reset is
   harmless if the module is merely slow and revives it if it is wedged, so the
   loop stops spending its whole 20 s budget on a module that will never answer.

Verified against a mocked module: healthy module needs no `AT+RST` and completes
in ≤2 probes; a wedged module that `AT+RST` revives recovers and continues within
the budget; a module that never returns is given up on after exactly two resets
in bounded time; the boot banner is consumed rather than mistaken for a reply.

**Unrelated trap noticed while reading `setupWifi`:** the block declares
`//% baudRate.defl=BaudRate.BaudRate9600`, but the code redirects at 115200 and
only reconfigures the module when the argument is *not* 115200. A user who leaves
the default gets a mismatch. Not the cause of this bug (the user passes 115200
explicitly) and not changed, but it should probably be `defl=BaudRate115200`.
