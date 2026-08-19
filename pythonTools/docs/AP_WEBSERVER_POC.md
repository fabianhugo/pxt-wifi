# Proof of Concept: SoftAP + Web Page over direct UART

Goal: make the ESP-AT WiFi module create its own WiFi network (SoftAP / "AP
mode") and serve a tiny web page to a phone or laptop that joins it. This
bypasses the MakeCode driver entirely — you type AT commands straight into the
module over a USB-serial adapter.

This is the manual version of what would later become new driver blocks
(`startAccessPoint`, `startWebServer`, `onRequest`).

---

## 0. What you need

- The WiFi module powered (3.3V).
- A USB-to-serial (TTL, 3.3V) adapter wired to the module's AT UART pins:
  - adapter **TX  -> module RX**
  - adapter **RX  -> module TX**
  - **GND -> GND** (common ground is required)
- A serial terminal program. Examples: `picocom`, `minicom`, `screen`,
  PuTTY, or the Arduino IDE serial monitor.

### Serial settings (important)
- **Baud: 115200**  (firmware default, from `factory_param_data.csv`)
- 8 data bits, no parity, 1 stop bit (8N1)
- **Line ending: CR+LF (`\r\n`)** — AT commands MUST end with both. Set your
  terminal to send "CRLF" on Enter, or the module will ignore your commands.

Quick start with picocom (Linux), adjust the device path:
```
picocom -b 115200 --omap crcrlf /dev/ttyUSB0
```
(In picocom, type the command then press Enter; `--omap crcrlf` makes Enter
send CR+LF.)

---

## 1. Sanity check the link

Type:
```
AT
```
Expected reply:
```
OK
```
If you get nothing or garbage, the wiring or baud rate is wrong. Try swapping
TX/RX, confirm common ground, confirm 115200.

Optional — see the firmware version:
```
AT+GMR
```

---

## 2. Switch the module into AP (SoftAP) mode

```
AT+CWMODE=2
```
Expected: `OK`

(`1` = station/client, `2` = AP only, `3` = AP + station at the same time.
For the simplest test use `2`.)

---

## 3. Create the WiFi network

Format: `AT+CWSAP="<ssid>","<password>",<channel>,<encryption>`
- encryption: `0`=open, `2`=WPA_PSK, `3`=WPA2_PSK, `4`=WPA_WPA2_PSK
- password must be **8–63 characters** for WPA2 (or use encryption `0` and an
  empty password for an open network).

```
AT+CWSAP="CalliopeTest","calliope123",5,3
```
Expected: `OK`

You can also cap how many clients may join (1–10) by adding a 5th parameter,
e.g. `...,5,3,4` allows 4 clients. Default is fine for the POC.

Now grab your phone, open WiFi settings, and you should see **CalliopeTest** in
the list. Join it with password `calliope123`. (Don't open the browser yet.)

---

## 4. Start the TCP server (the "web server")

Multiple connections must be enabled before starting a server:
```
AT+CIPMUX=1
```
Expected: `OK`

Start listening on port 80 (HTTP):
```
AT+CIPSERVER=1,80
```
Expected: `OK`

The module's address on its own network is **192.168.4.1** (the default
SoftAP gateway).

---

## 5. Trigger a request and watch it arrive

On the phone (still joined to CalliopeTest), open a browser and go to:
```
http://192.168.4.1
```

In your serial terminal you'll see an incoming connection and the browser's
HTTP request, something like:
```
0,CONNECT

+IPD,0,xxx:GET / HTTP/1.1
Host: 192.168.4.1
...
```
The `0` is the **link id** of that client connection. Note it — you reply on
the same id. (It is usually `0` for the first client.)

---

## 6. Send the web page back

Tell the module how many bytes you're about to send on link 0, then send
exactly that many bytes. We'll send a minimal HTTP response:

```
HTTP/1.1 200 OK\r\n
Content-Type: text/html\r\n
\r\n
<h1>Hi from Calliope</h1>
```

That payload is **exactly 69 bytes** counting each `\r\n` as 2 bytes:
- `HTTP/1.1 200 OK` + CRLF      = 17
- `Content-Type: text/html` + CRLF = 25
- (blank line) CRLF            = 2
- `<h1>Hi from Calliope</h1>`   = 25
- total = **69**

Command:
```
AT+CIPSEND=0,69
```
The module replies with a `>` prompt. Now send the 69-byte payload. Easiest is
to **paste** these exact 4 lines (with your terminal set to CRLF), pressing
Enter after the first three lines and **NOT after the last line**:
```
HTTP/1.1 200 OK
Content-Type: text/html

<h1>Hi from Calliope</h1>
```
Expected: `Recv 69 bytes` then `SEND OK`.

> Byte-count tip: the number after `CIPSEND` must match the bytes you send
> exactly. If you press Enter after the final line, that's 2 extra bytes —
> then use `AT+CIPSEND=0,71` and add a blank line. Mismatched counts are the
> #1 reason this step "hangs" (the module waits for more bytes).

---

## 7. Close the connection so the browser renders

```
AT+CIPCLOSE=0
```
Expected: `0,CLOSED`

The phone's browser should now display: **Hi from Calliope**

Refresh the page to repeat from step 5 (the link id may change each time).

---

## Full command sequence (cheat sheet)

```
AT
AT+CWMODE=2
AT+CWSAP="CalliopeTest","calliope123",5,3
AT+CIPMUX=1
AT+CIPSERVER=1,80
        <- now join the WiFi on your phone and browse to http://192.168.4.1
        <- watch for "+IPD,0,...:GET / HTTP/1.1" in the terminal
AT+CIPSEND=0,69
        <- send the 69-byte HTTP response shown in step 6
AT+CIPCLOSE=0
```

To shut the server down again:
```
AT+CIPSERVER=0
```

---

## Troubleshooting

- **No `OK` to `AT`** — wiring (TX/RX swapped, no common GND) or wrong baud.
- **`AT+CWSAP` returns ERROR** — password too short (<8) for WPA2, or bad
  parameter order. Try an open net: `AT+CWSAP="CalliopeTest","",5,0`.
- **`AT+CIPSERVER` returns ERROR** — you forgot `AT+CIPMUX=1` first.
- **`CIPSEND` seems stuck after `>`** — your byte count doesn't match what you
  typed. Reset with the Enter key a few times, or power-cycle, and recount.
- **Browser spins / blank page** — you didn't `AT+CIPCLOSE` (browser waits for
  the connection to end), or the byte count was off so the response was
  truncated.
- **Phone won't get an IP** — give it a few seconds; some phones warn about
  "no internet" on this network, which is expected (it's a local-only AP).
