# Sketch: UART-only firmware update via a custom AT command

Design sketch for `AT+UARTOTA` — a user-defined AT command that receives an app
image in chunks over the AT UART and writes it into the inactive OTA partition,
with **no Wi-Fi involved**.

Status: **design sketch, not built or tested.** Written 2026-08-19. See
[claude-esp-at-ota-upgrade.md](claude-esp-at-ota-upgrade.md) for the hardware
context (ESP32-C3, only AT UART pins TX:7/RX:6 accessible, no bootloader UART).

## Why this exists

Every stock update path needs either Wi-Fi or the ROM bootloader:

| Path | Transport | Reaches app partition? |
|---|---|---|
| `AT+CIUPDATE` | Wi-Fi (Espressif cloud) | yes |
| `AT+USEROTA` | Wi-Fi (any URL) | yes |
| `AT+SYSFLASH` | **AT UART** | **no — user partitions only** |
| esptool | UART0 GPIO20/21 + BOOT | yes |

`AT+SYSFLASH` proves the transport works — it already streams binary data over
the AT UART into flash — but it is restricted to user partitions declared in
`at_customize.csv` (`mfg_nvs`, `fatfs`). It cannot touch `ota_0`/`ota_1`.

This command fills that cell: AT UART transport, app partition destination.

## Bootstrap constraint (important)

This is self-compiled firmware, so:

1. It must be flashed **once** by a path that already works — for this hardware
   that means one Wi-Fi OTA (`AT+USEROTA` with a locally built image).
2. From then on, every subsequent update can go over pure UART.
3. Self-compiled firmware **cannot use Espressif cloud OTA**
   (`AT+CIUPDATE`) — the server only serves official binaries. `AT+USEROTA` and
   this command remain available.

One network-dependent step buys permanent network independence. If that trade is
not worth it, stop here and keep using `--serve` on an isolated LAN AP instead.

## Protocol

Mirrors the `AT+SYSFLASH` / `AT+USEROTA` idiom: announce a length, get a `>`
prompt, send raw bytes.

```
AT+UARTOTA=<total_size>          -> +UARTOTA:READY,<chunk_max>
                                    OK
AT+UARTOTA_DATA=<chunk_len>      -> >
<chunk_len raw bytes>            -> +UARTOTA:RECV,<cumulative>,<remaining>
                                    OK
   ... repeat until cumulative == total_size ...
AT+UARTOTA_DONE                  -> +UARTOTA:VALID
                                    OK          (boot partition set)
AT+UARTOTA_ABORT                 -> OK          (discard, keep running image)
AT+UARTOTA?                       -> +UARTOTA:<state>,<received>,<total>
```

Chunked rather than one 2MB transfer because the docs' own `AT+SYSFLASH` note
says so: *"the MCU should write data in multiple chunks to avoid memory
exhaustion caused by writing too much data at once. For example, write 4 KB of
data each time."* A single `malloc(2MB)` will fail on a C3.

Suggested `chunk_max` = 4096. The command reports it so the host does not have
to guess.

## Firmware side

Lives in `examples/at_custom_cmd/`-style layout: a component with
`custom/at_custom_cmd.c` + `include/at_custom_cmd.h`. Its `CMakeLists.txt`
needs `app_update` added to `require_components` (for `esp_ota_*`) on top of the
example's `at freertos nvs_flash`, and must keep
`idf_component_set_property(${COMPONENT_NAME} WHOLE_ARCHIVE TRUE)`.

### Bulk receive pattern

ESP-AT's documented way to read a known number of bytes from the AT port
(`How_to_add_user-defined_AT_commands.rst`, "Access Input Data from AT Command
Port"):

- `esp_at_port_enter_specific(cb)` — install a callback the port calls on RX
- `esp_at_port_read_data(buf, len)` — drain into your buffer
- `esp_at_port_exit_specific()` — uninstall
- signal between them with a binary semaphore

### Sketch

```c
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_at.h"
#include "esp_ota_ops.h"
#include "esp_log.h"

#define TAG            "uart_ota"
#define CHUNK_MAX      4096

typedef enum { IDLE = 0, RECEIVING, COMPLETE } ota_state_t;

static struct {
    ota_state_t state;
    esp_ota_handle_t handle;
    const esp_partition_t *part;
    uint32_t total;
    uint32_t received;
} s_ota;

static SemaphoreHandle_t s_sync;
static uint8_t *s_buf;

static void wait_data_callback(void) { xSemaphoreGive(s_sync); }

/* --- AT+UARTOTA=<total_size> : begin --------------------------------- */
static uint8_t at_setup_uartota(uint8_t para_num)
{
    int32_t total = 0;
    uint8_t out[64];

    if (para_num != 1) return ESP_AT_RESULT_CODE_ERROR;
    if (esp_at_get_para_as_digit(0, &total) != ESP_AT_PARA_PARSE_RESULT_OK)
        return ESP_AT_RESULT_CODE_ERROR;

    /* Target the partition we are NOT running from. */
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *target  = esp_ota_get_next_update_partition(running);
    if (!target) return ESP_AT_RESULT_CODE_ERROR;

    if (total <= 0 || (uint32_t)total > target->size) {
        ESP_LOGE(TAG, "size %d exceeds partition %u", (int)total, target->size);
        return ESP_AT_RESULT_CODE_ERROR;
    }

    /* Passing the real size (not OTA_SIZE_UNKNOWN) lets esp_ota_begin erase
       exactly what is needed, which is faster and safer. */
    if (esp_ota_begin(target, total, &s_ota.handle) != ESP_OK)
        return ESP_AT_RESULT_CODE_ERROR;

    if (!s_sync) { s_sync = xSemaphoreCreateBinary(); assert(s_sync); }
    if (!s_buf)  { s_buf = malloc(CHUNK_MAX); if (!s_buf) return ESP_AT_RESULT_CODE_ERROR; }

    s_ota.part = target; s_ota.total = total;
    s_ota.received = 0;  s_ota.state = RECEIVING;

    snprintf((char *)out, sizeof(out), "+UARTOTA:READY,%d\r\n", CHUNK_MAX);
    esp_at_port_write_data(out, strlen((char *)out));
    return ESP_AT_RESULT_CODE_OK;
}

/* --- AT+UARTOTA_DATA=<len> : one chunk ------------------------------- */
static uint8_t at_setup_uartota_data(uint8_t para_num)
{
    int32_t len = 0, got = 0;
    uint8_t out[64];

    if (s_ota.state != RECEIVING) return ESP_AT_RESULT_CODE_ERROR;
    if (para_num != 1) return ESP_AT_RESULT_CODE_ERROR;
    if (esp_at_get_para_as_digit(0, &len) != ESP_AT_PARA_PARSE_RESULT_OK)
        return ESP_AT_RESULT_CODE_ERROR;
    if (len <= 0 || len > CHUNK_MAX) return ESP_AT_RESULT_CODE_ERROR;
    if (s_ota.received + len > s_ota.total) return ESP_AT_RESULT_CODE_ERROR;

    esp_at_port_write_data((uint8_t *)">", 1);
    esp_at_port_enter_specific(wait_data_callback);

    while (xSemaphoreTake(s_sync, portMAX_DELAY)) {
        got += esp_at_port_read_data(s_buf + got, len - got);
        if (got >= len) { esp_at_port_exit_specific(); break; }
    }

    if (esp_ota_write(s_ota.handle, s_buf, len) != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_write failed at %u", s_ota.received);
        esp_ota_abort(s_ota.handle);
        s_ota.state = IDLE;
        return ESP_AT_RESULT_CODE_ERROR;
    }
    s_ota.received += len;

    snprintf((char *)out, sizeof(out), "+UARTOTA:RECV,%u,%u\r\n",
             s_ota.received, s_ota.total - s_ota.received);
    esp_at_port_write_data(out, strlen((char *)out));
    return ESP_AT_RESULT_CODE_OK;
}

/* --- AT+UARTOTA_DONE : validate + set boot partition ----------------- */
static uint8_t at_exe_uartota_done(uint8_t *cmd_name)
{
    if (s_ota.state != RECEIVING || s_ota.received != s_ota.total)
        return ESP_AT_RESULT_CODE_ERROR;

    /* esp_ota_end verifies the image (magic byte, SHA256 if built with it). */
    if (esp_ota_end(s_ota.handle) != ESP_OK) {
        ESP_LOGE(TAG, "image validation failed");
        s_ota.state = IDLE;
        return ESP_AT_RESULT_CODE_ERROR;
    }
    if (esp_ota_set_boot_partition(s_ota.part) != ESP_OK) {
        s_ota.state = IDLE;
        return ESP_AT_RESULT_CODE_ERROR;
    }
    s_ota.state = COMPLETE;
    esp_at_port_write_data((uint8_t *)"+UARTOTA:VALID\r\n", 16);
    return ESP_AT_RESULT_CODE_OK;   /* host then sends AT+RST */
}

/* --- AT+UARTOTA_ABORT ------------------------------------------------ */
static uint8_t at_exe_uartota_abort(uint8_t *cmd_name)
{
    if (s_ota.state == RECEIVING) esp_ota_abort(s_ota.handle);
    s_ota.state = IDLE; s_ota.received = 0;
    return ESP_AT_RESULT_CODE_OK;
}

/* --- AT+UARTOTA? ----------------------------------------------------- */
static uint8_t at_query_uartota(uint8_t *cmd_name)
{
    uint8_t out[80];
    snprintf((char *)out, sizeof(out), "+UARTOTA:%d,%u,%u\r\n",
             s_ota.state, s_ota.received, s_ota.total);
    esp_at_port_write_data(out, strlen((char *)out));
    return ESP_AT_RESULT_CODE_OK;
}

static const esp_at_cmd_struct at_uart_ota_cmd[] = {
    {"+UARTOTA",       NULL, at_query_uartota, at_setup_uartota,      NULL},
    {"+UARTOTA_DATA",  NULL, NULL,             at_setup_uartota_data, NULL},
    {"+UARTOTA_DONE",  NULL, NULL,             NULL, at_exe_uartota_done},
    {"+UARTOTA_ABORT", NULL, NULL,             NULL, at_exe_uartota_abort},
};

bool esp_at_uart_ota_cmd_regist(void)
{
    return esp_at_custom_cmd_array_regist(
        at_uart_ota_cmd, sizeof(at_uart_ota_cmd) / sizeof(at_uart_ota_cmd[0]));
}
```

Register from the component's init path the same way
`examples/at_custom_cmd` does (see its README for the
`ESP_AT_CMD_SET_INIT_FN` / init hook wiring and the `set-component-env` step).

## Host side

Extend `tools/at_ota_upgrade.py` with a `--uart-bin BIN` mode:

```python
def run_uart_ota(dev, bin_path, chunk=4096):
    """Push an app image over the AT UART. No network involved."""
    size = os.path.getsize(bin_path)
    out = dev.send(f"AT+UARTOTA={size}", timeout=60)   # includes flash erase
    m = re.search(r"\+UARTOTA:READY,(\d+)", out)
    if not m:
        raise ATError("Device did not accept the transfer. Is AT+UARTOTA built in?")
    chunk = min(chunk, int(m.group(1)))

    sent = 0
    with open(bin_path, "rb") as f:
        while True:
            data = f.read(chunk)
            if not data:
                break
            dev.ser.reset_input_buffer()
            dev.ser.write(f"AT+UARTOTA_DATA={len(data)}\r\n".encode())
            dev.ser.flush()
            _await_prompt(dev)              # same '>' wait as run_userota
            dev.ser.write(data)             # raw bytes, no CR-LF
            dev.ser.flush()
            _await_ok(dev, timeout=15)      # +UARTOTA:RECV then OK
            sent += len(data)
            pct = 100 * sent // size
            print(f"\r      {sent:,}/{size:,} bytes ({pct}%)", end="", flush=True)

    print()
    dev.send("AT+UARTOTA_DONE", timeout=30)
    print("      image validated; boot partition set")
```

Reuse the existing `>`-prompt and OK-wait helpers from `run_userota()` — the
framing is identical, only the payload differs.

At 115200 baud a ~2 MB image is roughly **3 minutes** of pure line time
(115200/10 ≈ 11.5 kB/s), plus per-chunk overhead. Raising the AT port baud first
with `AT+UART_CUR=921600,8,1,0,3` cuts that to well under a minute; it is not
saved to flash, so a reset restores 115200. Worth doing — and worth reverting
before `AT+RST` so the post-reboot version check still finds the port at the
expected rate.

## Safety properties

Good:

- `esp_ota_get_next_update_partition()` always targets the slot you are **not**
  running from, so a failed transfer cannot damage the running image.
- `esp_ota_end()` validates the image before `esp_ota_set_boot_partition()`, so
  a truncated or corrupt transfer is rejected rather than booted.
- `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` (C3 default) means even a validated
  image that fails to confirm itself gets rolled back by the bootloader.
- `AT+UARTOTA_ABORT` and any error path call `esp_ota_abort()`, leaving the
  running image untouched.
- Partition table and bootloader are never written — same guarantee as stock OTA.

Watch out for:

- **Flow control.** `CONFIG_AT_UART_DEFAULT_FLOW_CONTROL=1` (RTS enabled) by
  default. Streaming megabytes with no CTS wired risks overrun. Either wire
  RTS/CTS or keep chunks small and confirm each one before sending the next —
  the protocol above does the latter deliberately.
- **No integrity check of our own.** UART has no checksum. `esp_ota_end()`
  catches corruption, but only after the whole transfer. Adding a per-chunk CRC32
  in the `AT+UARTOTA_DATA` response would fail fast instead of at the end.
  Recommended if the link is long or noisy.
- **`esp_at_port_read_data` may return short.** The loop above re-takes the
  semaphore until `got >= len`; do not assume one callback delivers everything.
- **No timeout on the receive loop.** `portMAX_DELAY` blocks forever if the host
  dies mid-chunk. Production code should use a finite tick timeout and abort.

## Open questions before building

1. Does `esp_at_port_enter_specific` interact badly with RTS/CTS at high baud
   and 4 KB chunks? Needs measurement.
2. Is `app_update` sufficient in `require_components`, or does the AT lib pull
   its own OTA symbols? Check for link conflicts with `at_ota_cmd.c`.
3. Should this coexist with `AT+USEROTA` or replace it? Coexisting costs flash
   but keeps the Wi-Fi path as a fallback — probably worth it.
4. Worth adding `AT+UARTOTA` support to the `at.py` build tooling so the custom
   image is reproducible? See `docs/en/Compile_and_Develop/tools_at_py.rst`.

## Effort estimate

- Firmware: ~250 lines including error handling, plus component wiring. The APIs
  are all documented and `at_ota_cmd.c` is a working reference for the OTA call
  sequence (`esp_ota_begin` → `esp_ota_write` → `esp_ota_end` →
  `esp_ota_set_boot_partition`, lines 416-598).
- Host: ~60 lines in `at_ota_upgrade.py`, reusing existing helpers.
- The real cost is **testing**, and it must be on hardware where BOOT + UART0 are
  reachable for recovery. Do not debug this on a module you cannot re-flash.
