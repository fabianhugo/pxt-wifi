#!/usr/bin/env python3
"""Upgrade, pin, or roll back ESP-AT firmware over the air via AT commands.

Intended for an ESP32-C3 reachable only through its two AT UART lines (TX:7 /
RX:6 on ESP32-C3-MINI-1 per factory_param_data.csv) with no USB and no BOOT/EN
control.

Three OTA paths:

  --url URL     AT+USEROTA against a URL you control. Pins the exact binary.
  --serve BIN   Same, but serves BIN from a local HTTP server and derives the
                URL automatically. For C3 the image is build/esp-at.bin.
  (default)     AT+CIUPDATE against Espressif's official cloud. Gives you
                whatever the server considers latest -- NOT pinnable, and it
                only serves official Espressif builds, not self-compiled ones.

Downgrade paths:

  --rollback    AT+SYSROLLBACK: switch to the image already in the other OTA
                partition. No network needed. The vendor advises against
                downgrading in general; see the notes in the AT docs.
  --url/--serve to an older binary also works (anti-rollback is disabled in
                module_esp32c3_default: CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=n).

Usage:
    # Pin to a specific binary served from this machine
    ./at_ota_upgrade.py -p /dev/ttyUSB0 -s SSID -k PW --serve build/esp-at.bin

    # Pin to a binary on an existing server
    ./at_ota_upgrade.py -p /dev/ttyUSB0 -s SSID -k PW \
        --url http://192.168.1.10:8000/esp-at.bin

    # Undo: back to whatever is in the other OTA slot
    ./at_ota_upgrade.py -p /dev/ttyUSB0 --rollback

    # Look, don't touch
    ./at_ota_upgrade.py -p /dev/ttyUSB0 -s SSID -k PW --dry-run
"""

import argparse
import functools
import http.server
import os
import re
import socket
import socketserver
import sys
import threading
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial is required: pip install pyserial")

# AT+CIUPDATE <state> codes.
OTA_STATES = {
    1: "server found",
    2: "connected to server",
    3: "got the upgrade version",
    4: "upgrade done",
    -1: "OTA failed (non-blocking mode)",
}

# The docs put the OTA process timeout at 3 minutes; allow headroom for a slow link.
OTA_TIMEOUT = 240
# AT+USEROTA has no documented timeout; downloading a ~2MB image over a weak
# link plus flash erase/write can take a while.
USEROTA_TIMEOUT = 300
# Joining an AP can take a while on a busy channel.
JOIN_TIMEOUT = 30
# AT+USEROTA caps the URL at 8192 bytes.
MAX_URL_LEN = 8192


class ATError(RuntimeError):
    pass


class ATDevice:
    def __init__(self, port, baudrate=115200, verbose=True, lines="auto"):
        self.verbose = verbose
        self.ser = serial.Serial(port, baudrate, timeout=0.2)

        # DTR/RTS handling differs by adapter, and getting it wrong looks
        # exactly like a wiring fault:
        #
        #  - USB-serial bridges (CP210x/FTDI/CH340) wired to an ESP boot
        #    circuit use DTR/RTS as EN/BOOT. Deasserting keeps the chip
        #    running normally.
        #  - USB CDC-ACM adapters (Raspberry Pi Debug Probe, ESP USB-JTAG,
        #    many debug probes) often gate transmission on DTR as a
        #    "host present" signal. Deasserting DTR silences the link.
        #
        # 'auto' asserts both for CDC-ACM ports and deasserts for the rest.
        if lines == "auto":
            lines = "assert" if "ACM" in port.upper() else "deassert"
        self.line_mode = lines

        if lines != "leave":
            state = (lines == "assert")
            try:
                self.ser.setDTR(state)
                self.ser.setRTS(state)
            except (OSError, serial.SerialException) as e:
                print(f"  note: could not set DTR/RTS ({e}); continuing")
        if self.verbose:
            print(f"      DTR/RTS: {lines}")
        time.sleep(0.1)
        self.ser.reset_input_buffer()

    def close(self):
        self.ser.close()

    def _log(self, prefix, text):
        if self.verbose:
            for line in text.splitlines():
                if line.strip():
                    print(f"  {prefix} {line.strip()}")

    def send(self, cmd, timeout=5, expect_ok=True):
        """Send one AT command and collect the response up to OK/ERROR."""
        self.ser.reset_input_buffer()
        if self.verbose:
            print(f"  >> {cmd}")
        self.ser.write((cmd + "\r\n").encode())
        self.ser.flush()

        buf = ""
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self.ser.read(4096).decode("utf-8", errors="replace")
            if chunk:
                buf += chunk
                # Terminal responses. Match at line starts to avoid tripping on
                # payload text that merely contains these words.
                if re.search(r"^(OK|ERROR|FAIL)\s*$", buf, re.MULTILINE):
                    break
        self._log("<<", buf)

        if expect_ok and not re.search(r"^OK\s*$", buf, re.MULTILINE):
            raise ATError(f"{cmd!r} did not return OK. Got:\n{buf.strip()}")
        return buf

    def _probe(self, timeout=2):
        """Send bare AT once. Return the raw bytes seen (may be empty)."""
        self.ser.reset_input_buffer()
        self.ser.write(b"AT\r\n")
        self.ser.flush()
        buf = ""
        deadline = time.time() + timeout
        while time.time() < deadline:
            chunk = self.ser.read(256).decode("utf-8", errors="replace")
            if chunk:
                buf += chunk
                if re.search(r"^(OK|ERROR)\s*$", buf, re.MULTILINE):
                    break
        return buf

    def wait_ready(self, attempts=3):
        """Confirm the AT interface is alive, retrying the opposite DTR/RTS state.

        A dead link is usually one of: wrong DTR/RTS polarity for the adapter
        type, wrong baud, or wrong pins. Distinguishing "no bytes at all" from
        "bytes but not OK" narrows it down a lot, so report which we saw.
        """
        saw_any = False
        for attempt in range(attempts):
            buf = self._probe()
            if buf.strip():
                saw_any = True
                self._log("<<", buf)
            if re.search(r"^OK\s*$", buf, re.MULTILINE):
                if self.verbose:
                    print("  >> AT -> OK")
                return

            # Second attempt: flip DTR/RTS, since that is the most common
            # cause and it is free to test.
            if attempt == 0 and self.line_mode != "leave":
                flipped = not (self.line_mode == "assert")
                try:
                    self.ser.setDTR(flipped)
                    self.ser.setRTS(flipped)
                    self.line_mode = "assert" if flipped else "deassert"
                    print(f"      no reply; retrying with DTR/RTS "
                          f"{'asserted' if flipped else 'deasserted'}")
                    time.sleep(0.3)
                except (OSError, serial.SerialException):
                    pass
            else:
                time.sleep(0.5)

        if saw_any:
            raise ATError(
                "The port returns data but never a clean 'OK'. That usually "
                "means a baud mismatch (try -b 460800 or -b 74880) or the "
                "bytes are boot-log noise rather than AT responses.\n"
                "Try --raw to watch what the device is actually sending."
            )
        raise ATError(
            "No bytes at all from the device.\n"
            "  - If another tool works on this port, the difference is likely "
            "DTR/RTS: try --lines assert, --lines deassert, or --lines leave.\n"
            "  - ESP-AT ships with RTS/CTS flow control enabled "
            "(CONFIG_AT_UART_DEFAULT_FLOW_CONTROL=1); if CTS is unwired the "
            "module can stall. --lines leave keeps the host from touching them.\n"
            "  - Otherwise check baud (-b), that TX/RX are crossed, and ground.\n"
            "  - Use --raw to dump anything the device sends unprompted."
        )

    def raw_monitor(self, seconds=8):
        """Dump whatever the device sends, then try one AT. Diagnostic aid."""
        print(f"      listening for {seconds}s (reset the board to see its banner)")
        deadline = time.time() + seconds
        got = b""
        while time.time() < deadline:
            chunk = self.ser.read(4096)
            if chunk:
                got += chunk
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
        print(f"\n      [{len(got)} bytes received unprompted]")
        print("      now sending a single 'AT'")
        buf = self._probe(timeout=3)
        print(f"      [reply: {buf.strip()!r}]" if buf.strip() else "      [no reply]")
        return got, buf

    def version(self):
        """Return (at_version, sdk_version, bin_version) from AT+GMR."""
        out = self.send("AT+GMR", timeout=5)
        get = lambda pat: (re.search(pat, out).group(1).strip()
                           if re.search(pat, out) else None)
        # AT+GMR decorates the version with a parenthesised commit/target/date,
        # e.g. 'AT version:4.1.1.0(abc - ESP32C3 - Jan 1 2025)', and Bin version
        # with '(MINI-1)'. Stop at the paren so before/after comparisons match.
        return (get(r"AT version:([^(\r\n]+)"),
                get(r"SDK version:([^\r\n]+)"),
                get(r"Bin version:([^(\r\n]+)"))

    def rollback_info(self):
        """Return (running_addr, running_ver, rollback_addr, rollback_ver) or None.

        AT+SYSROLLBACK? is only present in firmware that supports it (added in
        v4.x via ESPAT-2222), so a missing response is informative, not fatal.
        """
        out = self.send("AT+SYSROLLBACK?", timeout=5, expect_ok=False)
        m = re.search(r'\+SYSROLLBACK:(\S+),"([^"]*)",(\S+),"([^"]*)"', out)
        return m.groups() if m else None


def connect_wifi(dev, ssid, password):
    print("\n[2/5] Connecting to Wi-Fi")
    dev.send("AT+CWMODE=1")
    # Escape the AT string-literal specials: backslash, quote, comma.
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"').replace(",", "\\,")
    dev.send(f'AT+CWJAP="{esc(ssid)}","{esc(password)}"', timeout=JOIN_TIMEOUT)
    return device_ip(dev)


def device_ip(dev):
    out = dev.send("AT+CIPSTA?", timeout=5)
    m = re.search(r'\+CIPSTA:ip:"([^"]+)"', out)
    if not m or m.group(1) == "0.0.0.0":
        raise ATError("Associated but no IP address was assigned.")
    print(f"      got IP {m.group(1)}")
    return m.group(1)


def run_ciupdate(dev, use_https, timeout=OTA_TIMEOUT):
    """Run AT+CIUPDATE in blocking mode, narrating +CIPUPDATE progress."""
    mode = 1 if use_https else 0
    scheme = "HTTPS" if use_https else "HTTP"
    print(f"\n[4/5] Starting cloud OTA via {scheme} (blocking, up to {timeout}s)")
    print("      Do not power-cycle the device until this completes.")

    dev.ser.reset_input_buffer()
    dev.ser.write(f"AT+CIUPDATE={mode}\r\n".encode())
    dev.ser.flush()

    buf, seen = "", set()
    deadline = time.time() + timeout
    while time.time() < deadline:
        chunk = dev.ser.read(4096).decode("utf-8", errors="replace")
        if not chunk:
            continue
        buf += chunk
        for m in re.finditer(r"\+CIPUPDATE:(-?\d+)", buf):
            state = int(m.group(1))
            if state not in seen:
                seen.add(state)
                print(f"      +CIPUPDATE:{state} - {OTA_STATES.get(state, 'unknown')}")
        if re.search(r"^OK\s*$", buf, re.MULTILINE) and 4 in seen:
            print("      OTA reported success.")
            return
        if re.search(r"^(ERROR|FAIL)\s*$", buf, re.MULTILINE):
            raise ATError(
                "Cloud OTA failed. The docs advise waiting before retrying if "
                "this was caused by network conditions. Note the cloud server "
                "only serves official Espressif binaries - a self-compiled "
                "build will be rejected; use --url or --serve instead.\n"
                f"Device said:\n{buf.strip()}"
            )
    raise ATError(f"Cloud OTA timed out after {timeout}s. Output:\n{buf.strip()}")


def run_userota(dev, url, timeout=USEROTA_TIMEOUT):
    """Run AT+USEROTA=<len> then send the raw URL bytes.

    Per the docs: after the '>' prompt the URL needs no escaping and must NOT
    be terminated with CR-LF.
    """
    url_bytes = url.encode()
    if len(url_bytes) > MAX_URL_LEN:
        raise ATError(f"URL is {len(url_bytes)} bytes; the limit is {MAX_URL_LEN}.")

    print(f"\n[4/5] Starting pinned OTA via AT+USEROTA (up to {timeout}s)")
    print(f"      URL: {url}")
    print("      Do not power-cycle the device until this completes.")

    dev.ser.reset_input_buffer()
    dev.ser.write(f"AT+USEROTA={len(url_bytes)}\r\n".encode())
    dev.ser.flush()

    # Wait for the '>' prompt before sending the URL.
    buf = ""
    deadline = time.time() + 10
    while time.time() < deadline:
        buf += dev.ser.read(256).decode("utf-8", errors="replace")
        if ">" in buf:
            break
        if re.search(r"^(ERROR|FAIL)\s*$", buf, re.MULTILINE):
            raise ATError(
                "AT+USEROTA was rejected. This command lives in the 'user' "
                "command set - confirm your firmware includes it.\n"
                f"Device said:\n{buf.strip()}"
            )
    else:
        raise ATError(f"No '>' prompt from AT+USEROTA. Got:\n{buf.strip()}")

    if dev.verbose:
        print(f"  >> (url payload, {len(url_bytes)} bytes, no CR-LF)")
    dev.ser.write(url_bytes)
    dev.ser.flush()

    buf = ""
    deadline = time.time() + timeout
    saw_recv = False
    while time.time() < deadline:
        chunk = dev.ser.read(4096).decode("utf-8", errors="replace")
        if not chunk:
            continue
        buf += chunk
        if not saw_recv and re.search(r"Recv \d+ bytes", buf):
            saw_recv = True
            print("      URL accepted; download and flash in progress...")
        if re.search(r"^OK\s*$", buf, re.MULTILINE) and saw_recv:
            print("      OTA reported success.")
            return
        if re.search(r"^(ERROR|FAIL)\s*$", buf, re.MULTILINE):
            raise ATError(
                "Pinned OTA failed. Check that the URL is reachable from the "
                "device's network, that it serves the right image for this "
                "target (build/esp-at.bin for C3), and -- if HTTPS -- that "
                "SSL verification is not the blocker (the docs suggest plain "
                "HTTP or provisioned PKI files).\n"
                f"Device said:\n{buf.strip()}"
            )
    raise ATError(f"Pinned OTA timed out after {timeout}s. Output:\n{buf.strip()}")


def do_rollback(dev):
    """Switch to the image in the other OTA partition."""
    print("\n[*] Rolling back to the other OTA partition")
    info = dev.rollback_info()
    if info:
        run_addr, run_ver, rb_addr, rb_ver = info
        print(f"      running:  {run_addr} \"{run_ver}\"")
        print(f"      rollback: {rb_addr} \"{rb_ver}\"")
        if rb_ver == "":
            print("      WARNING: the rollback slot reports an empty version. "
                  "It may not hold a valid image.")
    else:
        print("      AT+SYSROLLBACK? gave no parseable answer; this firmware "
              "may predate the query command (added in v4.x). Proceeding.")

    dev.send("AT+SYSROLLBACK", timeout=10, expect_ok=False)
    print("      Rollback issued; device is restarting.")
    time.sleep(8)
    dev.ser.reset_input_buffer()
    dev.wait_ready()
    print(f"      now running AT version: {dev.version()[0]}")


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        print(f"      http: {fmt % a}")


def start_file_server(bin_path, bind_ip, port):
    """Serve the directory containing bin_path; return (url, shutdown_callable)."""
    bin_path = os.path.abspath(bin_path)
    if not os.path.isfile(bin_path):
        raise ATError(f"No such file: {bin_path}")

    directory = os.path.dirname(bin_path)
    handler = functools.partial(_QuietHandler, directory=directory)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    httpd = Server(("0.0.0.0", port), handler)
    actual_port = httpd.socket.getsockname()[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    size = os.path.getsize(bin_path)
    url = f"http://{bind_ip}:{actual_port}/{os.path.basename(bin_path)}"
    print(f"      serving {bin_path} ({size:,} bytes)")
    print(f"      at {url}")
    return url, httpd.shutdown


def guess_local_ip(device_ip_addr):
    """Find the local address the device would route back to."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are sent; this just picks the outbound interface.
        s.connect((device_ip_addr, 9))
        return s.getsockname()[0]
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--port", required=True, help="serial port, e.g. /dev/ttyUSB0")
    ap.add_argument("-b", "--baud", type=int, default=115200, help="baud rate (default 115200)")
    ap.add_argument("-s", "--ssid", help="Wi-Fi SSID")
    ap.add_argument("-k", "--password", default="", help="Wi-Fi password")

    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--url", help="AT+USEROTA to this exact URL (pins the version)")
    mode.add_argument("--serve", metavar="BIN",
                      help="serve this local .bin over HTTP and AT+USEROTA to it "
                           "(for C3: build/esp-at.bin)")
    mode.add_argument("--rollback", action="store_true",
                      help="AT+SYSROLLBACK to the other OTA partition; no network used")

    ap.add_argument("--serve-port", type=int, default=8000,
                    help="port for --serve (default 8000; 0 picks a free one)")
    ap.add_argument("--serve-ip",
                    help="address to advertise to the device for --serve "
                         "(default: auto-detected from the route to the device)")
    ap.add_argument("--http", action="store_true",
                    help="cloud OTA only: use plain HTTP (mode 0) instead of HTTPS")
    ap.add_argument("--skip-wifi", action="store_true",
                    help="assume the device is already associated")
    ap.add_argument("--restore", action="store_true",
                    help="issue AT+RESTORE after a successful OTA (recommended by "
                         "the docs, and close to mandatory on a downgrade; this "
                         "erases saved Wi-Fi credentials)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report versions and connectivity, then stop before OTA")
    ap.add_argument("--lines", choices=["auto", "assert", "deassert", "leave"],
                    default="auto",
                    help="DTR/RTS handling. 'auto' (default) asserts on CDC-ACM "
                         "ports (/dev/ttyACM*, debug probes) and deasserts on "
                         "USB-serial bridges. Use 'leave' to not touch them at all")
    ap.add_argument("--raw", action="store_true",
                    help="dump whatever the device sends, then send one AT, and exit "
                         "(use when the link seems dead)")
    ap.add_argument("-q", "--quiet", action="store_true", help="hide the AT traffic")
    args = ap.parse_args()

    needs_wifi = not args.rollback and not args.skip_wifi
    if needs_wifi and not args.ssid:
        ap.error("--ssid is required unless --skip-wifi or --rollback is given")

    print(f"[1/5] Opening {args.port} at {args.baud} baud")
    dev = ATDevice(args.port, args.baud, verbose=not args.quiet, lines=args.lines)
    stop_server = None
    try:
        if args.raw:
            dev.raw_monitor()
            return 0

        dev.wait_ready()

        before = dev.version()
        print(f"      running AT version: {before[0]}")
        print(f"      SDK: {before[1]}   Bin: {before[2]}")

        if args.rollback:
            if args.dry_run:
                info = dev.rollback_info()
                print(f"\nDry run: AT+SYSROLLBACK? -> {info}")
                return 0
            do_rollback(dev)
            if args.restore:
                print("\nIssuing AT+RESTORE (factory defaults; Wi-Fi cleared)")
                dev.send("AT+RESTORE", timeout=10, expect_ok=False)
                time.sleep(6)
            return 0

        if not args.skip_wifi:
            ip = connect_wifi(dev, args.ssid, args.password)
        else:
            print("\n[2/5] Skipping Wi-Fi setup (--skip-wifi)")
            ip = device_ip(dev)

        print("\n[3/5] Pre-flight")
        info = dev.rollback_info()
        if info:
            print(f"      OTA slots: running {info[0]} \"{info[1]}\" / "
                  f"other {info[2]} \"{info[3]}\"")
            print("      (AT+SYSROLLBACK can return you to the other slot)")

        url = args.url
        if args.serve:
            serve_ip = args.serve_ip or guess_local_ip(ip)
            url, stop_server = start_file_server(args.serve, serve_ip, args.serve_port)

        if args.dry_run:
            if url:
                print(f"\nDry run: would AT+USEROTA to {url}")
            else:
                print("\nDry run: would run cloud AT+CIUPDATE (version not pinnable)")
            return 0

        if url:
            run_userota(dev, url)
        else:
            print("\n      NOTE: cloud OTA cannot be pinned to a version. Use "
                  "--url or --serve for an exact binary.")
            run_ciupdate(dev, use_https=not args.http)

        print("\n[5/5] Restarting to boot the new image")
        dev.send("AT+RST", timeout=5, expect_ok=False)
        time.sleep(6)
        dev.ser.reset_input_buffer()
        dev.wait_ready()

        after = dev.version()
        print(f"\n      AT version before: {before[0]}")
        print(f"      AT version after:  {after[0]}")
        if before[0] == after[0]:
            print("\nWARNING: the version did not change. Either the server had "
                  "nothing new, or the image failed validation and the "
                  "bootloader rolled back (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y).")
        else:
            print("\nUpgrade confirmed.")

        if args.restore:
            print("\nIssuing AT+RESTORE (factory defaults; Wi-Fi cleared)")
            dev.send("AT+RESTORE", timeout=10, expect_ok=False)
            time.sleep(6)

        return 0

    except (ATError, serial.SerialException, OSError) as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted. If an OTA was in flight the device may still be "
              "writing flash; let it finish before power-cycling.", file=sys.stderr)
        return 130
    finally:
        if stop_server:
            stop_server()
        dev.close()


if __name__ == "__main__":
    sys.exit(main())
