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
