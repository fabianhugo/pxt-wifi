#!/usr/bin/env python3
"""
AP + live-updating web page PoC for the ESP-AT WiFi module (stock firmware).

Over a direct USB-serial link to the module, this:
  1. Brings the module up as its own WiFi access point (SoftAP).
  2. Starts a TCP server on port 80 (AT+CIPSERVER).
  3. Acts as the "web server brain":
       GET /            -> a themed HTML page (served once)
       GET /data        -> a tiny JSON blob of the current sensor readings
       GET /favicon.ico -> 204 No Content (keeps traffic low)
  4. The page polls /data every 2 s and updates the table, so the display
     refreshes automatically -- the browser does the polling; the hub just
     always answers with the latest values.

This models the planned Calliope "sensor hub": here the PC fakes the sensor
values; on the real device they'd come from the hub's own sensors, from other
minis over radio, and/or over WiFi. The serve loop here is exactly what the
MakeCode startWebServer / onRequest blocks will do.

Stock firmware only -- no reflash. The module is a dumb relay: it forwards the
browser's request as +IPD and we must send the reply (AT+CIPSEND).

Requires: pip install pyserial

Examples:
    ./ap_webserver_poc.py --port /dev/ttyACM1 --open
    ./ap_webserver_poc.py --port /dev/ttyACM1 --ssid SensorHub --password hub12345
"""

import argparse
import math
import re
import sys
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("pyserial is required:  pip install pyserial")


# ---------------------------------------------------------------------------
# The display page. Themed after the micro:bit/Calliope data-logger UI
# (logfs/dl.css): green->blue header strip, teal accent, striped table.
# It loads once, then polls /data every 2 s and rebuilds the table -- so the
# repeated requests are tiny and reliable, and the heavy HTML is sent rarely.
# ---------------------------------------------------------------------------
_LOGO_SVG = (
    '<svg role="img" aria-labelledby="calliope-logo" xmlns="http://www.w3.org/2000/svg"'
    ' xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" viewBox="0 0 525.216 126.9">'
    '<path fill="#4a5261" d="M223.716 88.8h.2l5.6 17-11.1.1 5.3-17.1zm-4.9-11.1-14.3 42.2-3.5.5.1 5.8'
    ' 16.5-.1-.1-5.8-3.4-.6 2.1-6.7 15.7-.1 2.2 6.6-3.3.6v5.8l16.5-.2v-5.8l-3.5-.5-15-41.9-10 .2zm38.1 6.1'
    ' 5.1.9.4 34.7-5.2 1.1.1 5.8 36.4-.3-.2-13.6-7.4.1-.4 6.1-13.6.1-.4-34.1 5.2-1v-5.9l-5.2.1-9.7.1h-5.2zm46.7 0'
    ' 5.1.9.3 34.7-5.1 1.1.1 5.8 36.4-.3-.2-13.6-7.4.1-.4 6.1-13.7.1-.3-34.1 5.2-1v-5.9l-5.2.1-9.7.1h-5.2zm67 36.5'
    '-5.2-.9-.3-34.8 5.2-1-.1-5.9-20 .2v5.9l5.2.9.3 34.7-5.1 1.1.1 5.8 20.1-.2zm154.3-29.5-.2-13.2-33 .3h-5.2l.1'
    ' 5.9 5.1.9.3 34.7-5.1 1.1.1 5.8 38.2-.3-.1-13.3-7.4.1-.3 5.8-15.7.1-.1-13.8 16.4-.2-.1-7.4-16.4.1-.1-12.1'
    ' 15.5-.2.5 5.8z"/><g transform="translate(-183.184 -204.1)"><title id="calliope-logo">calliope mini logo'
    '</title><defs><path id="a" d="M133.2 204.1h234.3v188.7H133.2z"/></defs><clipPath id="b">'
    '<use xlink:href="#a" width="100%" height="100%" overflow="visible"/></clipPath>'
    '<path fill="#4a5261" d="M312.3 246.7H277v-33.8c0-3.4 2.8-6.2 6.2-6.2h22.9c3.4 0 6.2 2.8 6.2 6.2v33.8z"'
    ' clip-path="url(#b)"/></g><path fill="#8096a1" d="M98.616 10.7h25.8v31.8h-25.8z"/>'
    '<path fill="#855c33" d="M41.716 26v44.9l52.3.2V26.2c0-14.4-11.8-26.2-26.2-26.2-14.4 0-26.1 11.6-26.1 26"/>'
    '<path fill="#26a6ab" d="M111.516 126.9h-84.1c-26.2 0-37.4-33.3-16.6-49.2l47-35.2h71.3v66.8c0 9.8-7.9 17.6-17.6 17.6"/>'
    '<path fill="#42c9c9" d="m17.816 72.5 44.6-33.3-8 30.5z"/>'
    '<path fill="#f7f5e8" d="m62.416 39.2 6.1 19.4h-15.8zm12.1 0 9.7 19.4h-15.7z"/>'
    '<path fill="#bdd1cf" d="m84.216 58.6-1.7 11.1h-28.1l-1.7-11.1z"/>'
    '<path fill="#f7f5e8" d="M102.816 126.9c-2.6-19.3-7.8-42.7-20.1-57.2h-28.2c-12.3 14.5-17.6 37.9-20.1 57.2h68.4z"/>'
    '<path fill="#fc9" d="M70.716 39.7h-4.5c-4.7 0-8.5-3.8-8.5-8.5V16.7h21.5v14.5c0 4.7-3.8 8.5-8.5 8.5"/>'
    '<path fill="#bdd1cf" d="M55.116 126.9V69.7c9.1 21.4 20.4 47.3 34.2 57.2h-34.2z"/>'
    '<path fill="#fc9" d="m68.516 58.6 6-19.4h-12.1z"/>'
    '<path fill="#42c9c9" d="M129.116 42.6v39.2l-30.5-39.2z"/>'
    '<path fill="#4a5261" d="m190.016 93.4-7.2.1-1.1-6.4c-1-.9-2.2-1.7-3.6-2.2-1.5-.5-3.2-.8-5.1-.8-4.2 0-7.4 1.6'
    '-9.7 4.7-2.2 3.1-3.3 7.1-3.3 12v1.7c0 4.9 1.2 8.9 3.5 12 2.3 3.1 5.5 4.6 9.6 4.5 1.9 0 3.7-.3 5.2-.9 1.6-.6'
    ' 2.8-1.3 3.7-2.3l.9-6.5 7.2-.1.1 9.6c-1.9 2.3-4.4 4.1-7.4 5.5-3 1.4-6.4 2.1-10.1 2.1-6.5.1-11.8-2.1-16-6.6'
    '-4.2-4.5-6.3-10.2-6.4-17.3v-1.6c-.1-7 1.9-12.8 6-17.4 4.1-4.6 9.4-6.9 15.9-6.9 3.7 0 7.1.6 10.2 2 3 1.3 5.5'
    ' 3.1 7.5 5.3l.1 9.5zm225.5 7.5c0-5-1.1-9.1-3.2-12.2-2.1-3.1-5.2-4.6-9.3-4.6-4.1 0-7.1 1.6-9.1 4.7s-2.9 7.2'
    '-2.9 12.3v.8c0 5.1 1.1 9.2 3.2 12.3 2.1 3.1 5.1 4.6 9.2 4.6s7.2-1.6 9.2-4.8c2-3.1 3-7.2 3-12.3l-.1-.8zm9.7.7'
    'c.1 7.1-1.9 13-5.9 17.6-4 4.7-9.3 7-15.9 7.1-6.5.1-11.8-2.2-15.9-6.8s-6.1-10.4-6.2-17.5v-.7c-.1-7 1.9-12.9'
    ' 5.9-17.6 4-4.7 9.2-7.1 15.8-7.1 6.6-.1 11.9 2.2 16 6.8s6.2 10.4 6.3 17.5l-.1.7zm25.5-.5 8.2-.1c2.7 0 4.7-.8'
    ' 6.1-2.3 1.4-1.5 2-3.4 2-5.7 0-2.3-.7-4.2-2.1-5.7-1.4-1.5-3.5-2.2-6.2-2.2l-8.2.1.2 15.9zm8-23.4c5.5 0 9.9 1.3'
    ' 13.2 4.1 3.2 2.8 4.9 6.5 4.9 11.1s-1.5 8.4-4.7 11.2c-3.2 2.8-7.5 4.3-13.1 4.3l-8.2.1.1 10.7 5.2.9v5.8l-20'
    ' .2-.1-5.8 5.1-1-.3-34.7-5.2-1-.1-5.9h23.2z"/></svg>'
)

PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calliope mini WiFi Log</title>
<style>
 body{font-family:"Roboto",Helvetica,Arial,sans-serif;margin:0;color:#222}
 .header-strip{height:10px;background-image:linear-gradient(90deg,#00c800,#3eb6fd)}
 .header-contents{height:62px;background:#f3f3f3;display:flex;align-items:center}
 .header-contents a{display:flex;align-items:center}
 .header-contents svg{width:167px;height:40px;padding:10px 15px}
 .header-contents h1{font-size:18px;margin:0;font-weight:700;color:#4a5261}
 main{margin:1em}
 table{border-collapse:collapse;margin-top:1em;width:100%;max-width:32em}
 th,td{border:1px solid #ddd;padding:8px}
 th{background:#f3f3f3;text-align:left}
 td.v{text-align:right;font-variant-numeric:tabular-nums}
 tr:nth-child(even){background:#f2f2f2}
 #last{color:#555;font-size:13px;margin:.75em 0}
 #status{color:#888;font-size:13px}
 #charts{display:flex;flex-wrap:wrap;gap:1em;margin-top:1em}
 .chart{border:1px solid #eee;border-radius:6px;width:420px;max-width:100%}
 button{cursor:pointer;border-radius:23px;min-height:40px;font-weight:700;font-size:14px;padding:0 18px;border:none;background:rgba(66,201,201,1);color:#fff;margin:.5em 0}
 footer{margin:1em;color:#888;font-size:13px}
</style>
</head>
<body>
<header>
 <div class="header-strip"></div>
 <div class="header-contents"><a href="https://calliope.cc">__LOGO__</a><h1>Calliope mini WiFi Log</h1></div>
</header>
<main>
 <table id="t"><tr><th>Sensor</th><th>Value</th></tr></table>
 <div id="last">Last update: never</div>
 <button onclick="dlCsv()">Download as CSV</button>
 <div id="charts"></div>
 <div id="status">connecting...</div>
</main>
<footer>Auto-updating every 2&nbsp;s &middot; served live from the WiFi module</footer>
<script>
 var s=document.getElementById('status'),tbl=document.getElementById('t'),
     last=document.getElementById('last'),charts=document.getElementById('charts');
 var samples=[],rows={},noPlot={'served.requests':1};
 function vals(k){var a=[],n=samples.length,st=n>60?n-60:0,i;
  for(i=st;i<n;i++){var v=samples[i].d[k];if(v!==undefined){var f=parseFloat(v);a.push(isNaN(f)?0:f);}}
  return a;}
 function dlCsv(){var keys=[],i,k;
  for(i=0;i<samples.length;i++)for(k in samples[i].d)if(keys.indexOf(k)<0)keys.push(k);
  var csv='time;'+keys.join(';')+'\\n';
  for(i=0;i<samples.length;i++){var r=samples[i],row=r.t,j;
   for(j=0;j<keys.length;j++){var v=r.d[keys[j]];row+=';'+(v===undefined?'':v);}
   csv+=row+'\\n';}
  var a=document.createElement('a');a.download='calliope-log.csv';
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.click();}
 function svg(title,a){
  var W=420,H=200,pl=46,pr=10,pt=20,pb=22,gw=W-pl-pr,gh=H-pt-pb,i,j;
  var s='<svg viewBox="0 0 '+W+' '+H+'" width="100%" style="display:block">';
  s+='<text x="'+pl+'" y="13" fill="#4a5261" font-family="sans-serif" font-size="12" font-weight="bold">'+title+'</text>';
  if(a.length<2)return s+'<text x="'+pl+'" y="'+(H/2)+'" fill="#aaa" font-family="sans-serif" font-size="11">collecting...</text></svg>';
  var mn=Math.min.apply(null,a),mx=Math.max.apply(null,a);if(mn==mx){mn-=1;mx+=1;}
  function yf(v){return (pt+gh-((v-mn)/(mx-mn))*gh).toFixed(1);}
  function xf(q){return (pl+q/(a.length-1)*gw).toFixed(1);}
  s+='<path d="M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'" fill="none" stroke="#ccc"/>';
  var yl=[mx,(mx+mn)/2,mn];
  for(j=0;j<3;j++){var yy=yf(yl[j]);
   s+='<line x1="'+pl+'" y1="'+yy+'" x2="'+(pl+gw)+'" y2="'+yy+'" stroke="#eee"/>';
   s+='<text x="2" y="'+(+yy+3)+'" fill="#888" font-family="sans-serif" font-size="10">'+yl[j].toFixed(1)+'</text>';}
  var p='';for(i=0;i<a.length;i++)p+=xf(i)+','+yf(a[i])+' ';
  s+='<polyline fill="none" stroke="rgba(66,201,201,1)" stroke-width="2" points="'+p+'"/>';
  var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(a.length-1)*2);
   s+='<line x1="'+xx+'" y1="'+(pt+gh)+'" x2="'+xx+'" y2="'+(pt+gh+3)+'" stroke="#ccc"/>';
   s+='<text x="'+xx+'" y="'+(H-6)+'" fill="#888" font-family="sans-serif" font-size="9" text-anchor="'+(i==0?'start':i==tk?'end':'middle')+'">'+(ago?'-'+ago+'s':'now')+'</text>';}
  return s+'</svg>';
 }
 async function tick(){
  try{
   var resp=await fetch('/data',{cache:'no-store'});var d=await resp.json(),k;
   var now=new Date().toLocaleString();
   samples.push({t:now,d:d});if(samples.length>5000)samples.shift();
   for(k in d){
    if(!rows[k]){
     var tr=tbl.insertRow();tr.insertCell().textContent=k;
     var vc=tr.insertCell();vc.className='v';
     var bx=null;
     if(!noPlot[k]){bx=document.createElement('div');bx.className='chart';charts.appendChild(bx);}
     rows[k]={v:vc,b:bx};
    }
    rows[k].v.textContent=d[k];
    if(rows[k].b)rows[k].b.innerHTML=svg(k,vals(k));
   }
   last.textContent='Last update: '+now;
   s.textContent='updated';
  }catch(e){s.textContent='(waiting for data...)';}
 }
 setInterval(tick,2000); tick();
</script>
</body>
</html>
""".replace("__LOGO__", _LOGO_SVG)


# ---------------------------------------------------------------------------
# Fake "sensor" data for the PoC. On the real hub this is replaced by the
# in-memory table fed from own sensors / radio / WiFi.
# ---------------------------------------------------------------------------
_request_count = 0


def data_json() -> str:
    """Current readings as compact JSON. Values wiggle so updates are visible."""
    global _request_count
    _request_count += 1
    t = time.time()
    temp = 22.0 + 2.0 * math.sin(t / 5.0)
    light = int(120 + 60 * math.sin(t / 3.0))
    remote = 19.0 + 1.5 * math.sin(t / 7.0)
    return (
        "{"
        f'"hub.temperature":"{temp:.1f} C",'
        f'"hub.light":"{light}",'
        f'"radio.miniB.temp":"{remote:.1f} C",'
        f'"served.requests":"{_request_count}"'
        "}"
    )


def http_response(status: str, content_type: str, body: str) -> bytes:
    """Minimal HTTP/1.1 response with a correct, auto-computed length.

    Content-Length marks where the response ends, and Connection: keep-alive
    tells the browser to REUSE the same socket for every poll instead of
    reconnecting each time. That avoids the per-request open/close churn that
    fragments the module's heap and eventually reboots it.
    """
    body_bytes = body.encode("utf-8")
    headers = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {content_type}; charset=utf-8\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: keep-alive\r\n"
        "\r\n"
    )
    return headers.encode("ascii") + body_bytes


def route(path: str) -> bytes:
    """Map a request path to a response. Garbled paths fall through to the page."""
    if path.startswith("/data"):
        return http_response("200 OK", "application/json", data_json())
    if path.startswith("/favicon"):
        return http_response("204 No Content", "text/plain", "")
    return http_response("200 OK", "text/html", PAGE_HTML)


def log(msg: str) -> None:
    print(f"[poc] {msg}", flush=True)


def read_until(ser, tokens, timeout: float):
    """Read & echo from serial until one of `tokens` appears or timeout."""
    deadline = time.time() + timeout
    buf = ""
    while time.time() < deadline:
        n = ser.in_waiting
        chunk = ser.read(n if n else 1)
        if chunk:
            text = chunk.decode("latin-1", "replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            buf += text
            for t in tokens:
                if t in buf:
                    return t
    return None


def drain_idle(ser, idle: float = 0.15, maxwait: float = 1.5):
    """Read & echo until the link is quiet for `idle` s (or maxwait elapses).

    Lets the module finish forwarding the inbound request before we reply, so
    AT+CIPSEND isn't issued mid-stream (which makes it return 'busy').
    """
    last = time.time()
    start = last
    while time.time() - start < maxwait:
        n = ser.in_waiting
        chunk = ser.read(n if n else 1)
        if chunk:
            sys.stdout.write(chunk.decode("latin-1", "replace"))
            sys.stdout.flush()
            last = time.time()
        elif time.time() - last >= idle:
            return


def send_cmd(ser, cmd: str, expect=("OK", "ERROR"), timeout: float = 5.0):
    ser.write((cmd + "\r\n").encode("ascii"))
    got = read_until(ser, list(expect), timeout)
    if got is None:
        log(f"WARNING: no response to: {cmd}")
    elif got == "ERROR":
        log(f"WARNING: ERROR from: {cmd}")
    return got


def setup_access_point(ser, ssid: str, password: str, channel: int, open_net: bool):
    log("Checking link to module ...")
    if send_cmd(ser, "AT", timeout=2) != "OK":
        log("No 'OK' from module. Check wiring (TX/RX/GND) and baud rate.")

    # Configure in RAM only -- never write WiFi config to the module's flash.
    # (ESP-AT defaults to SYSSTORE=1, which is what persisted "CalliopeTest".)
    # Must be set before CWMODE/CWSAP. It resets to default on reboot, so we
    # re-send it here every setup (initial and reboot-recovery).
    send_cmd(ser, "AT+SYSSTORE=0")

    log("Switching to SoftAP mode ...")
    send_cmd(ser, "AT+CWMODE=2")

    log(f"Creating WiFi network '{ssid}' ...")
    if open_net:
        send_cmd(ser, f'AT+CWSAP="{ssid}","",{channel},0')       # 0 = OPEN
    else:
        send_cmd(ser, f'AT+CWSAP="{ssid}","{password}",{channel},3')  # 3 = WPA2_PSK

    log("Enabling multiple connections ...")
    send_cmd(ser, "AT+CIPMUX=1")

    # Keep-alive sockets are polled every ~2 s so they're never idle; this reaps
    # a socket the browser abandoned (tab closed / switched WiFi). Kept short so a
    # half-open connection frees the single slot quickly (the watchdog also helps).
    send_cmd(ser, "AT+CIPSTO=10")

    # Effectively one viewer, but allow 2 connections: browsers (notably Firefox)
    # open a 2nd/backup socket while the slow multi-chunk page is still loading,
    # and a single slot refuses it -> intermittent load failures. Two slots give
    # that headroom; keep-alive still means no per-poll churn. (Must be set before
    # the server is created.)
    send_cmd(ser, "AT+CIPSERVERMAXCONN=2")

    log("Starting TCP server on port 80 ...")
    send_cmd(ser, "AT+CIPSERVER=1,80")

    log("")
    log("=" * 60)
    log(f"AP is up.  Join WiFi '{ssid}' and open  http://192.168.4.1")
    log("Page polls /data every 2 s -- values should update live.")
    log("Ctrl+C to stop.")
    log("=" * 60)


# Max bytes per AT+CIPSEND. Stay well under the firmware's per-send cap so a
# multi-KB page (logo included) is sent as several sends on the same socket.
CHUNK = 1024

# If no request arrives for this long, assume the viewer vanished (e.g. switched
# WiFi) leaving a half-open socket that holds the single connection slot. We then
# close all sockets so a fresh browser can connect again. Must be well above the
# 2 s poll interval so an active dashboard never triggers it.
IDLE_RECOVER = 8.0


def _send_chunk(ser, link_id: str, piece: bytes) -> bool:
    """Send one <=CHUNK piece via AT+CIPSEND. Returns True on SEND OK."""
    for attempt in range(2):
        ser.write(f"AT+CIPSEND={link_id},{len(piece)}\r\n".encode("ascii"))
        tok = read_until(ser, [">", "ERROR", "busy", "link is not valid"], timeout=3)
        if tok == ">":
            ser.write(piece)
            return read_until(ser, ["SEND OK", "ERROR"], timeout=5) == "SEND OK"
        if tok in ("ERROR", "link is not valid"):
            return False        # connection already gone
        drain_idle(ser, idle=0.15, maxwait=1.0)   # 'busy': settle and retry once
    return False


def serve(ser, link_id: str, response: bytes):
    """Send the response in <=CHUNK pieces. We do NOT close the connection --
    Connection: keep-alive means the browser reuses this one socket for every
    subsequent poll, so there is no open/close churn to fragment the module's
    heap. An idle/abandoned socket is reaped by AT+CIPSTO."""
    for i in range(0, len(response), CHUNK):
        if not _send_chunk(ser, link_id, response[i:i + CHUNK]):
            log(f"    aborted serving connection {link_id} (closed/busy)")
            break
        time.sleep(0.02)   # small breather so we don't overrun the module


# A request forwarded by the module looks like:  +IPD,<id>,<len>:GET <path> HTTP/...
# Require the SPACE after the path so we only match a COMPLETE request line --
# otherwise a half-received "GET /da" matches as path "/da" and we mis-route
# (serving the whole page instead of the tiny /data JSON).
REQUEST_RE = re.compile(r"\+IPD,(\d+),\d+:GET (\S+) ")


def serve_forever(ser, reinit):
    buf = ""
    last_request = time.time()
    recovered = False
    while True:
        n = ser.in_waiting
        chunk = ser.read(n if n else 1)
        if not chunk:
            # Watchdog: a viewer that switched WiFi leaves a half-open socket
            # occupying the single connection slot, so new browsers get refused.
            # After an idle gap, close all sockets to free the slot. Fires once
            # per idle episode (reset when the next real request arrives).
            if not recovered and time.time() - last_request > IDLE_RECOVER:
                ser.write(b"AT+CIPCLOSE=5\r\n")   # link id 5 = all connections
                if read_until(ser, ["CLOSED"], 1.0):
                    log("idle: cleared a stale connection")
                recovered = True
                last_request = time.time()
            continue
        text = chunk.decode("latin-1", "replace")
        sys.stdout.write(text)
        sys.stdout.flush()
        buf += text

        # Self-heal: the module prints "ready" when it (re)boots. Since we use
        # AT+SYSSTORE=0, a reboot wipes the AP/server config -- so re-run setup,
        # otherwise the dashboard dies permanently (no data, reloads fail).
        if "ready" in buf:
            log("module rebooted -- re-initialising access point ...")
            buf = ""
            time.sleep(0.5)                 # let the boot output settle
            try:
                ser.reset_input_buffer()
            except Exception:
                pass
            reinit()
            last_request = time.time()
            recovered = False
            continue

        m = REQUEST_RE.search(buf)
        if m:
            link_id, path = m.group(1), m.group(2)
            buf = ""                       # rest of the request is drained below
            drain_idle(ser)                # let the module finish forwarding it
            label = path if path else "/"
            log(f"--> {label}  (connection {link_id})")
            serve(ser, link_id, route(path))
            last_request = time.time()
            recovered = False
        elif len(buf) > 4096:
            buf = buf[-512:]               # don't let partial data accumulate


def main():
    p = argparse.ArgumentParser(description="ESP-AT SoftAP live web-page PoC")
    p.add_argument("--port", required=True, help="serial device, e.g. /dev/ttyACM1")
    p.add_argument("--baud", type=int, default=115200, help="baud rate (default 115200)")
    p.add_argument("--ssid", default="CalliopeTest", help="WiFi network name to create")
    p.add_argument("--password", default="calliope123",
                   help="WiFi password (8-63 chars; ignored with --open)")
    p.add_argument("--channel", type=int, default=5, help="WiFi channel (default 5)")
    p.add_argument("--open", action="store_true",
                   help="create an open network with no password")
    p.add_argument("--no-dtr", action="store_true",
                   help="hold DTR/RTS low (for USB-UART bridges like CP2102/CH340 "
                        "that auto-reset the ESP via those lines). Default asserts "
                        "them, which native USB /dev/ttyACM* devices need.")
    p.add_argument("--reset", action="store_true",
                   help="factory-reset the module (AT+RESTORE) before setup, clearing "
                        "any WiFi config a previous run persisted to flash.")
    args = p.parse_args()

    log(f"Opening {args.port} @ {args.baud} ...")
    ser = serial.Serial(args.port, args.baud, timeout=0.1)
    try:
        ser.dtr = not args.no_dtr
        ser.rts = not args.no_dtr
    except Exception:
        pass
    time.sleep(0.3)
    ser.reset_input_buffer()

    def reinit():
        setup_access_point(ser, args.ssid, args.password, args.channel, args.open)

    if args.reset:
        log("Factory-resetting module (AT+RESTORE) to clear persisted config ...")
        ser.write(b"AT+RESTORE\r\n")
        read_until(ser, ["ready"], 6.0)      # module wipes flash and reboots
        time.sleep(0.5)
        ser.reset_input_buffer()

    try:
        reinit()                       # initial setup
        serve_forever(ser, reinit)     # serves, and re-runs setup after a reboot
    except KeyboardInterrupt:
        log("\nStopping: shutting the server down ...")
        send_cmd(ser, "AT+CIPSERVER=0", timeout=2)
    finally:
        ser.close()


if __name__ == "__main__":
    main()
