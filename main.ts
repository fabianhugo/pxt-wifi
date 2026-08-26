enum MessageType {
    UDP,
    TCP
}
// Selector for the web dashboard controls (toggles & sliders). Values are the
// array index used by the driver.
enum WebControl {
    //% block="A"
    A = 0,
    //% block="B"
    B = 1,
    //% block="C"
    C = 2
}
// Which part of the fetched wall-clock time "internet time" should return.
enum TimeUnit {
    //% block="year"
    Year = 0,
    //% block="month"
    Month = 1,
    //% block="day"
    Day = 2,
    //% block="hour"
    Hour = 3,
    //% block="minute"
    Minute = 4,
    //% block="second"
    Second = 5
}
let debugMODE = true
let debugTXPIN = DigitalPin.P2
let debugBAUD = softSerial.BaudRate.Baud4800 
/**
 * Functions to operate Grove module.
 */
//% weight=10 color=#9F79EE icon="\uf1b3" block="WiFi"
//% groups='["UartWiFi", "Access Point"]'
namespace WiFi {
    /**
     * 
     */

    let isWifiConnected = false;
    let wifiBaudRate = BaudRate.BaudRate115200;
    /**
     * Setup Grove - Uart WiFi V2 to connect to  Wi-Fi
     */
    //% block="Setup Wifi|TX %txPin|RX %rxPin|Baud rate %baudrate|SSID = %ssid|Password = %passwd"
    //% group="UartWiFi"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% baudRate.defl=BaudRate.BaudRate9600
    //% weight=90
    export function setupWifi(txPin: SerialPin, rxPin: SerialPin, baudRate: BaudRate, ssid: string, passwd: string) {
        let result = 0

        isWifiConnected = false
        wifiBaudRate = baudRate

        // Start with default ESP32 baud rate (115200)
        serial.redirect(
            txPin,
            rxPin,
            BaudRate.BaudRate115200
        )
        // The pxt default RX buffer is only 64 bytes. At 115200 baud that is
        // ~5.5 ms of data -- far too small if anything blocks before we read
        // (notably the debug logger, which bit-bangs at 4800 baud and can hold
        // the CPU for ~100 ms). The AP path already did this; station mode did
        // not, so replies to long commands like CIPSTART were silently lost.
        serial.setRxBufferSize(254)

        // Wait until the module actually answers AT before configuring. On a cold
        // boot the WiFi module powers up together with the Calliope and may still
        // be booting, so the first commands -- including the join -- get lost.
        // Retry for up to ~12 s; returns as soon as the module responds.
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAtResponse("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }

        sendAtCmd("AT+SYSSTORE=0")
        result = waitAtResponse("OK", "ERROR", "FAIL", 3000)

        // Convert BaudRate enum to number
        let baudNum = baudRate as number


        // If user wants different baud rate, configure ESP32
        if (baudNum != 115200) {
            // Set ESP32 baud rate: AT+UART_DEF=baudrate,databits,stopbits,parity,flow
            sendAtCmd("AT+UART_CUR=" + baudNum + ",8,1,0,0")
            basic.pause(100)

            // Switch Calliope to new baud rate
            serial.redirect(txPin, rxPin, baudRate)
            basic.pause(100)

            // Test new baud rate
            sendAtCmd("AT")
            result = waitAtResponse("OK", "ERROR", "None", 1000)
        }

        sendAtCmd("AT+CWMODE=1")
        result = waitAtResponse("OK", "ERROR", "None", 1000)

        // Join the network, retried -- right after boot the first attempt can fail
        // even though AT already answers.
        for (let attempt = 0; attempt < 3 && !isWifiConnected; attempt++) {
            sendAtCmd(`AT+CWJAP="${ssid}","${passwd}"`)
            if (waitAtResponse("WIFI GOT IP", "ERROR", "None", 20000) == 1) {
                isWifiConnected = true
            } else {
                basic.pause(500)
            }
        }
    }

    /**
     * Check if Grove - Uart WiFi V2 is connected to Wifi
     */
    //% block="Wifi OK?"
    //% group="UartWiFi"
    //% weight=85
    export function wifiOK() {
        return isWifiConnected
    }

    // =====================================================================
    // Internet clock
    //
    // One network operation for everything: fetch the "Date:" header from a
    // website. Every HTTP server sends it in the fixed RFC 7231 format
    // ("Date: Wed, 19 Aug 2026 15:43:39 GMT"), so no JSON, no API key, no TLS.
    //
    // The result is cached for TIME_REFRESH_MS (30 s): a block call older than
    // that re-fetches from the internet, otherwise the cached time is advanced
    // locally from input.runningTime(). That keeps the blocks live without a
    // network round trip -- and its ~1.4 s stall -- on every single call.
    // =====================================================================

    // Primary host. Short name, stable, IANA-reserved for exactly this kind of
    // use. (It is served via Cloudflare, hence "Server: cloudflare" in replies.)
    const TIME_HOST = "example.com"
    const TIME_PATH = "/"
    // Fallback: a bare IPv4 literal, so CIPSTART needs no DNS at all -- useful
    // when a name resolves to IPv6 first on firmware without it, or DNS is slow.
    // 1.1.1.1 answers plain HTTP on port 80 with a normal Date header (a 301 to
    // HTTPS, which is fine: we only read the header, never follow the redirect).
    const TIME_HOST2 = "1.1.1.1"
    const TIME_PATH2 = "/"
    // How stale the cached time may get before the next block call re-fetches it
    // from the internet. Short, so the blocks read as a live clock -- but not
    // zero: one fetch blocks ~1.4 s (and much longer if the host is unreachable),
    // so fetching on literally every call would stall a loop and make reading
    // hour and minute cost two round trips that could disagree.
    const TIME_REFRESH_MS = 30000         // re-fetch when older than 30 s
    const TIME_RETRY_MS = 15000           // after a failure, wait this long

    let netEpochSec = 0                   // Unix seconds at the moment of the fetch
    let netDeviceMs = 0                   // runningTime() at that same moment
    let netTimeOk = false                 // did the last fetch succeed?
    let netLastTry = 0                    // runningTime() of the last attempt
    let netBusy = false                   // a fetch is in progress (see below)

    /**
     * True if the internet can be reached: pings a website and waits for a reply.
     * Independent of the internet time blocks. Needs station mode ("Setup Wifi").
     */
    //% block="Internet OK?"
    //% group="UartWiFi"
    //% weight=80
    export function internetOk(): boolean {
        clearSerialBuffer()
        sendAtCmd("AT+PING=\"" + TIME_HOST + "\"")
        return waitAtResponse("+PING:", "ERROR", "timeout", 5000) == 1
    }

    /**
     * Current time from the internet as a Unix timestamp (seconds since
     * 1 Jan 1970, UTC). Returns 0 if it could not be fetched.
     * Needs station mode ("Setup Wifi").
     */
    //% block="internet time (Unix s)"
    //% group="UartWiFi"
    //% weight=78
    export function internetTimestamp(): number {
        refreshNetTime()
        if (!netTimeOk) return 0
        return netEpochSec + Math.floor((input.runningTime() - netDeviceMs) / 1000)
    }

    // UTC seconds -> local seconds, applying the Central European rule
    // (CET = UTC+1, CEST = UTC+2 between the last Sunday of March and the last
    // Sunday of October, both switching at 01:00 UTC).
    function toLocal(t: number): number {
        return t + (isSummerTime(t) ? 7200 : 3600)
    }

    function isSummerTime(t: number): boolean {
        let year = civilFromUnix(t, TimeUnit.Year)
        let start = lastSundayUtc(year, 3) + 3600      // 01:00 UTC, last Sun March
        let end = lastSundayUtc(year, 10) + 3600       // 01:00 UTC, last Sun October
        return t >= start && t < end
    }

    // Unix seconds for 00:00 UTC on the last Sunday of the given month.
    function lastSundayUtc(year: number, mon: number): number {
        let day = daysInMonth(year, mon)
        let t = unixFromCivil(year, mon, day, 0, 0, 0)
        // 1 Jan 1970 was a Thursday, so weekday = (days + 4) % 7, 0 = Sunday.
        let dow = (Math.floor(t / 86400) + 4) % 7
        return t - dow * 86400
    }

    /**
     * One part (year, month, day, hour, minute or second) of the current time
     * from the internet, in Central European time (CET/CEST, 24 h, with daylight
     * saving applied automatically). Returns 0 if it could not be fetched.
     */
    //% block="internet time %unit"
    //% group="UartWiFi"
    //% weight=77
    export function internetTime(unit: TimeUnit): number {
        let t = internetTimestamp()
        if (t == 0) return 0
        return civilFromUnix(toLocal(t), unit)
    }

    // Fetch only when we have nothing, or the cached time is stale. Everything
    // else is served from the cache, so putting these blocks in a 1 s loop costs
    // nothing.
    function refreshNetTime() {
        // Re-entry guard: fetchNetDate() yields (basic.pause), so a second fiber
        // could otherwise start issuing AT commands mid-conversation and corrupt
        // both replies.
        if (netBusy) return
        let now = input.runningTime()
        // Fresh enough, or we failed very recently -- a failed fetch takes several
        // seconds, so without the backoff a loop with no internet would retry
        // nonstop.
        let wait = netTimeOk ? TIME_REFRESH_MS : TIME_RETRY_MS
        if (netLastTry != 0 && (now - netLastTry) < wait) return
        netLastTry = now
        netBusy = true
        // Try the named host, then a bare IP. CIPSTART can hang with no reply at
        // all when DNS is slow or resolves to IPv6 on firmware without it -- the
        // IP fallback removes DNS from the path entirely.
        let epoch = fetchNetDate(TIME_HOST, TIME_PATH)
        if (epoch == 0) epoch = fetchNetDate(TIME_HOST2, TIME_PATH2)
        netTimeOk = epoch > 0
        if (netTimeOk) {
            netEpochSec = epoch
            netDeviceMs = input.runningTime()
        }
        netBusy = false
    }

    // Open a TCP connection, send a bare HTTP request, read the "Date:" header out
    // of the reply. Returns Unix seconds, or 0 on any failure.
    //
    // This deliberately mirrors adafruitIOGetValue(), which is the one function in
    // this driver that already reads a reply BODY successfully. The details that
    // matter (all learned from it):
    //   * clearSerialBuffer() first, so stale bytes can't corrupt the parse.
    //   * serial.writeString(req + "\r\n") with AT+CIPSEND=req.length -- NOT
    //     sendAtCmd(req), and no "+ 2" on the length.
    //   * a TIGHT read loop that only pauses after many empty reads. Pausing 50 ms
    //     every iteration (an earlier version of this code) is slow enough to miss
    //     the reply.
    //   * don't touch CIPMUX. The AP server needs CIPMUX=1 and adafruitIOGetValue
    //     works without changing it.
    // The reply is "+IPD,<len>:<data>" framed, but we don't parse that -- we just
    // scan the raw stream for the Date header.
    function fetchNetDate(host: string, path: string): number {
        clearSerialBuffer()

        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPSTART=\"TCP\",\"" + host + "\",80")
        // Only 1 or 2 mean we are connected. The old check bailed only on
        // "ERROR" (== 3), so a TIMEOUT (== 0) fell through and we sent a request
        // into a socket that was never opened -- the intermittent failure seen
        // in the UART log. DNS for a new host can take a while, hence 10 s.
        // ESP-AT answers "CONNECT" then "OK". Accept either, plus the
        // "ALREADY CONNECTED" case. (Matching "OK" is safe here because the echo
        // of AT+CIPSTART does not itself contain "OK" -- unlike AT+CIPSEND.)
        let conn = waitAtResponse("CONNECT", "ALREADY CONNECTED", "ERROR", 10000)
        if (conn == 3) return 0               // explicit ERROR
        if (conn == 0) {
            // Timed out waiting for CONNECT. Do NOT fall through as the previous
            // version did -- that sent a request into a socket that was never
            // opened, which is exactly the intermittent failure in the UART log.
            return 0
        }

        // HEAD, not GET: we only ever read the "Date:" response header, and HEAD
        // returns the identical headers with no body. example.com's GET reply is
        // ~867 bytes (chunked HTML) that the module would have to funnel through
        // the UART and this loop would have to buffer, for nothing.
        let req =
            "HEAD " + path + " HTTP/1.1\r\n" +
            "Host: " + host + "\r\n" +
            "Connection: close\r\n\r\n"

        sendAtCmd("AT+CIPSEND=" + req.length)
        // Wait for the ">" prompt ONLY. Passing "OK" as a target here matched the
        // module's echo of the command itself ("AT+CIPSEND=80 ... OK"), so this
        // succeeded even when no prompt ever came.
        if (waitAtResponse(">", "ERROR", "busy", 3000) != 1) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)
            return 0
        }

        serial.writeString(req + "\r\n")

        // Read incrementally and keep EVERYTHING: the module can deliver
        // "SEND OK", the "+IPD," framing and the headers in one read, so a
        // waitAtResponse() call here would throw the Date header away.
        let buf = ""
        let epoch = 0
        let start = input.runningTime()
        let lastData = start
        let emptyReads = 0

        while ((input.runningTime() - start) < 10000) {
            let chunk = serial.readString()
            if (chunk.length > 0) {
                buf += chunk
                lastData = input.runningTime()
                emptyReads = 0
                if (epoch == 0) epoch = parseHttpDate(buf)
                if (chunk.includes("CLOSED")) break
            } else {
                emptyReads++
                if (emptyReads > 150) {
                    basic.pause(5)
                    emptyReads = 0
                }
                // Got the date and the stream went quiet -- done.
                if (epoch > 0 && (input.runningTime() - lastData) > 500) break
                // Nothing new for 2 s -- give up on more data.
                if (buf.length > 100 && (input.runningTime() - lastData) > 2000) break
            }
        }

        // Safe to log now: the whole reply has already been read.
        debugLog(buf.length > 0 ? buf : "[no data]")

        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "None", 1000)
        return epoch
    }

    // Index just past a line-initial "Date: " header, or -1. Anchored to a line
    // start so headers like "X-Origin-Date:" can't be mistaken for the real one.
    function findDateHeader(resp: string): number {
        let from = 0
        while (true) {
            let i = resp.indexOf("Date: ", from)
            if (i < 0) {
                i = resp.indexOf("date: ", from)
                if (i < 0) return -1
            }
            if (i == 0 || resp.charAt(i - 1) == "\n") return i + 6
            from = i + 6
        }
    }

    // "Wed, 19 Aug 2026 15:43:39 GMT" -> Unix seconds. 0 if absent/incomplete.
    function parseHttpDate(resp: string): number {
        let i = findDateHeader(resp)          // already points past "Date: "
        if (i < 0) return 0
        let s = resp.substr(i, 26)            // "Wed, 19 Aug 2026 15:43:39 "
        if (s.length < 25) return 0           // header hasn't fully arrived yet
        // Fixed offsets after the 5-char weekday prefix ("Wed, ").
        let day = parseInt(s.substr(5, 2))
        let mon = monthFromName(s.substr(8, 3))
        let year = parseInt(s.substr(12, 4))
        let hour = parseInt(s.substr(17, 2))
        let min = parseInt(s.substr(20, 2))
        let sec = parseInt(s.substr(23, 2))
        // Validate rather than trust the offsets: a mangled or partially received
        // header must yield 0, never a bogus time.
        if (mon == 0 || isNaN(day) || isNaN(year) || isNaN(hour) || isNaN(min) || isNaN(sec)) return 0
        if (year < 1970 || day < 1 || day > 31) return 0
        if (hour > 23 || min > 59 || sec > 60) return 0
        return unixFromCivil(year, mon, day, hour, min, sec)
    }

    function monthFromName(m: string): number {
        if (m == "Jan") return 1
        if (m == "Feb") return 2
        if (m == "Mar") return 3
        if (m == "Apr") return 4
        if (m == "May") return 5
        if (m == "Jun") return 6
        if (m == "Jul") return 7
        if (m == "Aug") return 8
        if (m == "Sep") return 9
        if (m == "Oct") return 10
        if (m == "Nov") return 11
        if (m == "Dec") return 12
        return 0
    }

    function isLeap(y: number): boolean {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    }

    function daysInMonth(y: number, m: number): number {
        if (m == 2) return isLeap(y) ? 29 : 28
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30
        return 31
    }

    function unixFromCivil(year: number, mon: number, day: number, hour: number, min: number, sec: number): number {
        let days = 0
        for (let y = 1970; y < year; y++) days += isLeap(y) ? 366 : 365
        for (let m = 1; m < mon; m++) days += daysInMonth(year, m)
        days += day - 1
        return days * 86400 + hour * 3600 + min * 60 + sec
    }

    // Split Unix seconds back into the requested calendar field (UTC).
    function civilFromUnix(t: number, unit: TimeUnit): number {
        let days = Math.floor(t / 86400)
        let rem = t - days * 86400
        if (unit == TimeUnit.Hour) return Math.floor(rem / 3600)
        if (unit == TimeUnit.Minute) return Math.floor(rem / 60) % 60
        if (unit == TimeUnit.Second) return rem % 60
        let year = 1970
        while (true) {
            let dy = isLeap(year) ? 366 : 365
            if (days < dy) break
            days -= dy
            year++
        }
        if (unit == TimeUnit.Year) return year
        let mon = 1
        while (true) {
            let dm = daysInMonth(year, mon)
            if (days < dm) break
            days -= dm
            mon++
        }
        if (unit == TimeUnit.Month) return mon
        return days + 1                       // Day
    }

    /**
     * Send data to ThingSpeak
     */
    //% block="Send Data to your ThingSpeak Channel|Write API Key %apiKey|Field1 %field1|Field2 %field2||Field3 %field3|Field4 %field4|Field5 %field5|Field6 %field6|Field7 %field7|Field8 %field8"
    //% group="UartWiFi"
    //% expandableArgumentMode="enabled"
    //% apiKey.defl="your Write API Key"
    //% weight=60
    export function sendToThingSpeak(apiKey: string, field1: number = 0, field2: number = 0, field3: number = 0, field4: number = 0, field5: number = 0, field6: number = 0, field7: number = 0, field8: number = 0) {
        let result = 0
        let retry = 2

        // close the previous TCP connection
        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 2000)
        }

        while (isWifiConnected && retry > 0) {
            retry = retry - 1;
            // establish TCP connection
            sendAtCmd("AT+CIPSTART=\"TCP\",\"api.thingspeak.com\",80")
            result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 2000)
            if (result == 3) continue

            let data = "GET /update?api_key=" + apiKey
            if (!isNaN(field1)) data = data + "&field1=" + field1
            if (!isNaN(field2)) data = data + "&field2=" + field2
            if (!isNaN(field3)) data = data + "&field3=" + field3
            if (!isNaN(field4)) data = data + "&field4=" + field4
            if (!isNaN(field5)) data = data + "&field5=" + field5
            if (!isNaN(field6)) data = data + "&field6=" + field6
            if (!isNaN(field7)) data = data + "&field7=" + field7
            if (!isNaN(field8)) data = data + "&field8=" + field8

            sendAtCmd("AT+CIPSEND=" + (data.length + 2))
            result = waitAtResponse(">", "OK", "ERROR", 2000)
            if (result == 3) continue
            sendAtCmd(data)
            result = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
            if (result == 1) break
        }
    }

    /**
     * Send data to IFTTT
     */
    //% block="Send Data to your IFTTT Event|Event %event|Key %key|value1 %value1||value2 %value2|value3 %value3"
    //% group="UartWiFi"
    //% event.defl="your Event"
    //% key.defl="your Key"
    //% value1.defl="Hello"
    //% value2.defl="Calliope"
    //% value3.defl="mini"
    //% weight=50
    export function sendToIFTTT(event: string, key: string, value1: string, value2: string, value3: string) {
        let result = 0
        let retry = 2

        // close the previous TCP connection
        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 2000)
        }

        while (isWifiConnected && retry > 0) {
            retry = retry - 1;
            // establish TCP connection
            sendAtCmd("AT+CIPSTART=\"TCP\",\"maker.ifttt.com\",80")
            result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 2000)
            if (result == 3) continue

            let data = "GET /trigger/" + event + "/with/key/" + key
            data = data + "?value1=" + value1
            data = data + "&value2=" + value2
            data = data + "&value3=" + value3
            data = data + " HTTP/1.1"
            data = data + "\u000D\u000A"
            data = data + "User-Agent: curl/7.58.0"
            data = data + "\u000D\u000A"
            data = data + "Host: maker.ifttt.com"
            data = data + "\u000D\u000A"
            data = data + "Accept: */*"
            data = data + "\u000D\u000A"

            sendAtCmd("AT+CIPSEND=" + (data.length + 2))
            result = waitAtResponse(">", "OK", "ERROR", 2000)
            if (result == 3) continue
            sendAtCmd(data)
            result = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
            // close the TCP connection
            // sendAtCmd("AT+CIPCLOSE")
            // waitAtResponse("OK", "ERROR", "None", 2000)
            if (result == 1) break
        }
    }

    // =====================================================================
    // Firmware upgrade (OTA)
    //
    // Mirrors pythonTools/at_ota_upgrade.py, which was validated on real
    // hardware. Two operations:
    //   AT+CIUPDATE   - download and install from Espressif's cloud server
    //   AT+SYSROLLBACK - switch back to the image in the other OTA partition
    //
    // Both are slow and must not be interrupted, so they are plain blocking
    // calls that report success as a boolean rather than reporting progress.
    // =====================================================================

    // The docs put the OTA process timeout at 3 minutes; allow headroom for a
    // slow link (the Python tool uses 240 s for the same reason).
    const OTA_TIMEOUT_MS = 240000

    // Progress of the last upgrade, from the +CIPUPDATE:<state> lines:
    // 0 = not started, 1 = server found, 2 = connected, 3 = got version,
    // 4 = upgrade done, -1 = failed.
    let otaState = 0

    /**
     * Upgrade the WiFi module's firmware over the air from Espressif's official
     * server. Needs station mode ("Setup Wifi") and internet.
     *
     * Takes several minutes. DO NOT power off the Calliope or the module while
     * this runs. The module restarts itself afterwards, so set up WiFi again.
     * Returns true only if the upgrade completed.
     *
     * Note: the cloud server only serves official Espressif builds, and the
     * version cannot be chosen.
     */
    //% block="upgrade WiFi firmware (OTA)"
    //% group="UartWiFi"
    //% weight=20
    //% advanced=true
    export function upgradeFirmware(): boolean {
        otaState = 0
        basic.clearScreen()                   // start from a blank display
        clearSerialBuffer()

        // Blocking mode (no trailing ",1"). The docs warn that in non-blocking
        // mode the "OK" does not necessarily arrive before the +CIPUPDATE lines,
        // which would make the result impossible to read reliably.
        // Mode 1 = HTTPS. The Python tool defaults to this too.
        sendAtCmd("AT+CIUPDATE=1")
        // Print the command NOW rather than leaving it for debugLog at the end:
        // the reply is minutes away, so waiting would make the log look as
        // though nothing was ever sent. Safe here because the module cannot
        // answer for several seconds.
        debugLogCmd()

        // Collect until the module reports done, or fails, or we run out of
        // patience. We keep the whole buffer: the +CIPUPDATE:<state> lines and
        // the final OK/ERROR can arrive in the same read.
        let buf = ""
        let start = input.runningTime()
        let frame = 0
        while ((input.runningTime() - start) < OTA_TIMEOUT_MS) {
            buf += serial.readString()
            if (buf.includes("+CIPUPDATE:4")) otaState = 4
            else if (buf.includes("+CIPUPDATE:3")) otaState = 3
            else if (buf.includes("+CIPUPDATE:2")) otaState = 2
            else if (buf.includes("+CIPUPDATE:1")) otaState = 1
            if (buf.includes("+CIPUPDATE:-1")) { otaState = -1; break }
            // Success is state 4 AND a final OK -- OK alone is not enough.
            if (otaState == 4 && buf.includes("OK")) break
            if (buf.includes("ERROR") || buf.includes("FAIL")) break
            // Keep the buffer bounded without losing a partially received line.
            if (buf.length > 1024) buf = buf.substr(buf.length - 512)

            // Show that the upgrade is alive. There is no byte-level progress
            // from the module -- only the four +CIPUPDATE states -- so the
            // bottom row is a state gauge (one LED per completed state) and a
            // dot chases across the top row so a stalled state still looks
            // different from a frozen device.
            // The loop ticks every ~100 ms; advance the column every 4th tick
            // (~400 ms) so the sweep is calm rather than frantic.
            if (frame % 4 == 0) otaAnimate(Math.floor(frame / 4))
            frame++

            basic.pause(100)
        }
        basic.clearScreen()

        debugLog(buf.length > 0 ? buf : "[no data]")
        if (otaState != 4) return false

        // The module reboots into the new image; give it time before anyone
        // talks to it again.
        basic.pause(8000)
        clearSerialBuffer()
        isWifiConnected = false               // credentials do not survive
        return true
    }

    /**
     * Switch the WiFi module back to the firmware it had before the last
     * upgrade (the image in its other OTA slot). Uses no network.
     *
     * Also runs AT+RESTORE afterwards: going back to an older build can leave
     * settings it cannot read, so the module is reset to factory defaults. This
     * ERASES the saved WiFi settings -- run "Setup Wifi" again afterwards.
     *
     * Only works if an upgrade has actually been done before -- a module still
     * on its original firmware has no second image to go back to, and older
     * firmware may not support the command at all. Returns true if the rollback
     * was accepted.
     */
    //% block="restore previous WiFi firmware (clears WiFi settings)"
    //% group="UartWiFi"
    //% weight=19
    //% advanced=true
    export function restoreFirmware(): boolean {
        clearSerialBuffer()

        // AT+SYSROLLBACK returns OK and then restarts. Firmware that predates
        // the command (pre-v4.x) answers ERROR, which is the honest "no" here.
        // No debugLogCmd() here: waitAtResponse follows immediately and prints
        // ">>cmd" together with the reply. Flushing now would block ~39 ms --
        // longer than the 254-byte RX buffer holds at 115200 baud (~22 ms) --
        // and could swallow the OK. Only the OTA command, whose reply is minutes
        // away, is safe to log early.
        sendAtCmd("AT+SYSROLLBACK")
        let r = waitAtResponse("OK", "ERROR", "None", 10000)
        if (r != 1) return false

        basic.pause(8000)                     // let it come back up
        clearSerialBuffer()

        // Rollback is a DOWNGRADE, and the vendor docs warn that newer firmware
        // can leave NVS / at_customize structures the older build cannot parse.
        // AT+RESTORE resets that persistent state to factory defaults and is
        // "close to mandatory on a downgrade" (see
        // pythonTools/docs/claude-esp-at-ota-upgrade.md). It also erases the
        // saved WiFi credentials -- which is why this block's name says so, and
        // why setupWifi has to be run again afterwards.
        sendAtCmd("AT+RESTORE")
        waitAtResponse("OK", "ERROR", "ready", 10000)
        basic.pause(6000)                     // it restarts again after RESTORE
        clearSerialBuffer()

        isWifiConnected = false               // credentials are gone
        return true
    }

    /**
     * The WiFi module's firmware version, e.g. "4.1.1.0". Empty string if the
     * module does not answer. Useful to check before and after an upgrade.
     */
    //% block="WiFi firmware version"
    //% group="UartWiFi"
    //% weight=21
    //% advanced=true
    export function firmwareVersion(): string {
        clearSerialBuffer()
        sendAtCmd("AT+GMR")

        // Collect the whole reply: AT+GMR prints several lines (AT / SDK / compile
        // time / Bin version) and we want the first one, so waiting on "OK" with
        // waitAtResponse would discard it.
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < 3000) {
            buf += serial.readString()
            if (buf.includes("OK") && buf.includes("AT version:")) break
            if (buf.includes("ERROR")) break
            basic.pause(50)
        }
        debugLog(buf.length > 0 ? buf : "[no data]")

        // "AT version:4.1.1.0(abc - ESP32C3 - Jan 1 2025)" -> "4.1.1.0".
        // Stop at "(" so the commit/target/date decoration is dropped and two
        // versions can be compared as plain strings.
        let key = "AT version:"
        let i = buf.indexOf(key)
        if (i < 0) return ""
        let out = ""
        for (let j = i + key.length; j < buf.length; j++) {
            let c = buf.charAt(j)
            if (c == "(" || c == "\r" || c == "\n") break
            out += c
        }
        // Trim trailing spaces without relying on String.trim().
        while (out.length > 0 && out.charAt(out.length - 1) == " ") {
            out = out.substr(0, out.length - 1)
        }
        return out
    }

    /**
     * True if the module has a previous firmware to go back to, i.e. whether
     * "restore previous WiFi firmware" can work. Changes nothing.
     *
     * False means either the module has never been upgraded (so there is no
     * second image) or its firmware is too old to support the query.
     */
    //% block="previous WiFi firmware available?"
    //% group="UartWiFi"
    //% weight=17
    //% advanced=true
    export function previousFirmwareAvailable(): boolean {
        return rollbackSlotVersion().length > 0
    }

    /**
     * The version stored in the module's rollback slot -- the firmware that
     * "restore previous WiFi firmware" would go back to. Empty if there is none.
     *
     * Note this is the image's build descriptor, which can differ from the AT
     * version string (e.g. "v2.4.0.0-649-g..." is stock v3.3.0.0). Changes
     * nothing.
     */
    //% block="previous WiFi firmware version"
    //% group="UartWiFi"
    //% weight=16
    //% advanced=true
    export function rollbackSlotVersion(): string {
        clearSerialBuffer()
        // Query form only -- this does NOT roll anything back. Absent before
        // v4.x, which answers ERROR.
        sendAtCmd("AT+SYSROLLBACK?")

        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < 3000) {
            buf += serial.readString()
            if (buf.includes("+SYSROLLBACK:") && buf.includes("OK")) break
            if (buf.includes("ERROR")) break
            basic.pause(50)
        }
        debugLog(buf.length > 0 ? buf : "[no data]")

        // +SYSROLLBACK:<run_addr>,"<run_ver>",<rb_addr>,"<rb_ver>"
        // The rollback version is the text inside the SECOND pair of quotes.
        let i = buf.indexOf("+SYSROLLBACK:")
        if (i < 0) return ""
        let q = 0
        let out = ""
        let collecting = false
        for (let j = i; j < buf.length; j++) {
            let c = buf.charAt(j)
            if (c == "\r" || c == "\n") break
            if (c == "\"") {
                q++
                if (q == 3) collecting = true         // opening quote of rb_ver
                else if (q == 4) break                // closing quote
                continue
            }
            if (collecting) out += c
        }
        return out
    }

    /**
     * How far the last firmware upgrade got: 0 = not started, 1 = server found,
     * 2 = connected to server, 3 = got the new version, 4 = done, -1 = failed.
     */
    //% block="firmware upgrade state"
    //% group="UartWiFi"
    //% weight=18
    //% advanced=true
    export function upgradeState(): number {
        return otaState
    }

    // One frame of the upgrade display, called from the OTA wait loop. A full
    // column sweeps left to right, so the whole screen shows activity.
    //
    // No progress gauge: the module only reports four +CIPUPDATE states, and it
    // reaches state 3 within seconds and then sits there for the entire
    // download, so a gauge reads as "stuck" rather than as progress.
    //
    // Kept to plot/unplot so it never blocks. basic.showAnimation and friends
    // pause internally, which would stall the read loop and lose the module's
    // output.
    function otaAnimate(frame: number) {
        let col = frame % 5
        let prev = (frame + 4) % 5
        for (let y = 0; y < 5; y++) {
            led.unplot(prev, y)
            led.plot(col, y)
        }
    }

    /**
     * Send a raw message via TCP or UDP
     */
    //% block="Send Message|Type %type|Server %address|Port %port|Message %message"
    //% group="UartWiFi"
    //% weight=70
    //% advanced=true
    export function sendMessage(type: MessageType, address: string, port: number, message: string): void {
        let result = 0
        let retry = 2

        // Determine protocol type
        let protocol = (type == MessageType.TCP) ? "TCP" : "UDP"

        // Close any previous connection
        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)
        }

        while (isWifiConnected && retry > 0) {
            retry = retry - 1

            // Establish connection (TCP or UDP)
            sendAtCmd("AT+CIPSTART=\"" + protocol + "\",\"" + address + "\"," + port)
            result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 3000)
            if (result == 3) continue

            // Send data length
            sendAtCmd("AT+CIPSEND=" + message.length)
            result = waitAtResponse(">", "OK", "ERROR", 2000)
            if (result == 3) continue

            // Send actual message
            serial.writeString(message)
            result = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)

            // Close connection
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)

            if (result == 1) break
        }
    }

    function waitAtResponse(target1: string, target2: string, target3: string, timeout: number) {
        let buffer = ""
        let start = input.runningTime()

        while ((input.runningTime() - start) < timeout) {
            buffer += serial.readString()

            if (buffer.includes(target1)) { debugLog(buffer); return 1 }
            if (buffer.includes(target2)) { debugLog(buffer); return 2 }
            if (buffer.includes(target3)) { debugLog(buffer); return 3 }

            basic.pause(100)
        }

        debugLog(buffer + " [TIMEOUT]")
        return 0
    }

    // The last command sent, waiting to be printed by the debug logger.
    let pendingCmd = ""

    function sendAtCmd(cmd: string) {
        serial.writeString(cmd + "\u000D\u000A")
        // NOTE: the debug echo is deliberately NOT written here. softSerial
        // bit-bangs at 4800 baud and busy-waits: logging a ~50 char command
        // blocks for ~110 ms, during which the module's reply (up to ~1150 bytes
        // at 115200 baud) overruns the RX buffer and is lost. That made long
        // commands like CIPSTART appear to get no answer at all. The command is
        // instead recorded and flushed by waitAtResponse AFTER the reply has been
        // read.
        pendingCmd = cmd
    }


    // Print ">>command" on its own, for a command whose reply will not arrive for
    // a long time (OTA). Safe only when nothing is about to be received: the
    // bit-banged logging blocks for ~100 ms.
    function debugLogCmd() {
        if (!debugMODE) return
        if (pendingCmd.length > 0) {
            softSerial.writeLine(debugTXPIN, debugBAUD, ">>" + pendingCmd)
            pendingCmd = ""
        }
    }

    // Print ">>command" then "<<reply" once the reply is already in hand, so the
    // slow bit-banged logging can never eat the reply it is meant to show.
    function debugLog(reply: string) {
        if (!debugMODE) return
        if (pendingCmd.length > 0) {
            softSerial.writeLine(debugTXPIN, debugBAUD, ">>" + pendingCmd)
            pendingCmd = ""
        }
        softSerial.writeLine(debugTXPIN, debugBAUD, "<<" + reply)
    }



    // Configure these to match your hardware
    const WIFI_TX = SerialPin.C17
    const WIFI_RX = SerialPin.C16
    const DBG_TX = SerialPin.USB_TX
    const DBG_RX = SerialPin.USB_RX

    function dbg(msg: string) {
        serial.redirect(DBG_TX, DBG_RX, BaudRate.BaudRate115200)
        serial.writeLine("[DBG " + input.runningTime() + "] " + msg)
        serial.redirect(WIFI_TX, WIFI_RX, wifiBaudRate)
    }

    //% block="Adafruit IO GET|Username %username|AIO Key %aioKey|Feed %feed"
    //% group="UartWiFi"
    //% weight=65
    export function adafruitIOGetValue(username: string, aioKey: string, feed: string): string {
        clearSerialBuffer()

        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)
        }

        sendAtCmd("AT+CIPSTART=\"TCP\",\"io.adafruit.com\",80")
        let result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 3000)
        if (result == 3) return ""

        let req =
            "GET /api/v2/" + username + "/feeds/" + feed + "/data/last HTTP/1.1\r\n" +
            "Host: io.adafruit.com\r\n" +
            "X-AIO-Key: " + aioKey + "\r\n" +
            "Connection: close\r\n\r\n"

        sendAtCmd("AT+CIPSEND=" + req.length)
        result = waitAtResponse(">", "OK", "ERROR", 2000)
        if (result == 3) return ""

        serial.writeString(req + "\r\n")

        // Read and parse incrementally - find value ASAP
        let buffer = ""
        let start = input.runningTime()
        let lastDataTime = start
        let emptyReads = 0
        let found = ""

        while ((input.runningTime() - start) < 10000) {
            let chunk = serial.readString()
            if (chunk.length > 0) {
                buffer += chunk
                lastDataTime = input.runningTime()
                emptyReads = 0

                // Try to find value after each chunk (only if not found yet)
                if (found.length == 0) {
                    let key = "\"value\":\""
                    let pos = buffer.indexOf(key)
                    if (pos >= 0) {
                        pos += key.length
                        let end = buffer.indexOf("\"", pos)
                        if (end > pos) {
                            found = buffer.substr(pos, end - pos)
                            // dbg("Found: " + found + " at " + buffer.length + " bytes")
                            // Continue reading to drain buffer
                        }
                    }
                }

                // Exit if connection closed
                if (chunk.includes("CLOSED")) break
            } else {
                emptyReads++
                // Only pause after MANY empty reads
                if (emptyReads > 150) {
                    basic.pause(5)
                    emptyReads = 0
                }
                // If we found value and no new data for 500ms, return it
                if (found.length > 0 && (input.runningTime() - lastDataTime) > 500) {
                    return found
                }
                // If no new data for 2 seconds, we're done
                if (buffer.length > 100 && (input.runningTime() - lastDataTime) > 2000) {
                    break
                }
            }
        }

        if (found.length > 0) return found

        // dbg("No value in " + buffer.length + " bytes")
        return ""
    }
    /**
        * Send value to an Adafruit IO feed (HTTP POST)
        */
    //% block="Adafruit IO POST|Username %username|AIO Key %aioKey|Feed %feed|Value %value"
    //% group="UartWiFi"
    //% weight=70
    export function adafruitIOPost(username: string, aioKey: string, feed: string, value: string) {
        serial.readString() // dump old data 
        basic.pause(20)

        let result = 0
        let retry = 2

        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 2000)
        }

        while (isWifiConnected && retry > 0) {
            retry = retry - 1

            // Open TCP connection
            sendAtCmd("AT+CIPSTART=\"TCP\",\"io.adafruit.com\",80")
            result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 3000)
            if (result == 3) continue

            // JSON body
            let body = "{\"value\":\"" + value + "\"}"

            // Build POST request
            let data = "POST /api/v2/" + username + "/feeds/" + feed + "/data HTTP/1.1\r\n"
            data += "Host: io.adafruit.com\r\n"
            data += "X-AIO-Key: " + aioKey + "\r\n"
            data += "Content-Type: application/json\r\n"
            data += "Content-Length: " + body.length + "\r\n"
            data += "User-Agent: Calliope-Mini\r\n"
            data += "Accept: */*\r\n\r\n"
            data += body

            sendAtCmd("AT+CIPSEND=" + data.length)
            result = waitAtResponse(">", "OK", "ERROR", 2000)
            if (result == 3) continue

            sendAtCmd(data)
            result = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
            if (result == 1) break
        }
    }
    function clearSerialBuffer() {
        let t = input.runningTime()
        while (input.runningTime() - t < 200) {
            serial.readString()
            basic.pause(10)
        }
    }


    export function extractAioValue(json: string): string {
        let key = "\"value\":\""
        let start = json.indexOf(key)
        if (start < 0) return ""

        start += key.length
        let end = json.indexOf("\"", start)
        if (end < 0) return ""

        return json.substr(start, end - start)
    }


    // =========================================================================
    // Access Point + web server
    //
    // Brings the module up as its own WiFi network (SoftAP) and serves a small
    // live-updating page. The module is a relay: it forwards browser requests
    // over UART as "+IPD,<id>,<len>:GET <path>"; we send the reply with
    // AT+CIPSEND. We never AT+CIPCLOSE -- Content-Length + Connection: close let
    // the browser render and close, which avoids racing recycled link ids.
    // The page polls /data every 2 s, so the heavy HTML is sent rarely and the
    // repeated requests are tiny.
    // =========================================================================

    // Max bytes per AT+CIPSEND. Stay under the firmware's per-send cap so the
    // multi-KB page goes out as several sends on one socket.
    const CHUNK = 1024

    // The dashboard reads its data from the datalogger (single source). The user
    // logs rows with datalogger.log(...); the driver serves them via getRows.
    let logFull = false            // set by datalogger.onLogFull -> page banner
    let rxBuf = ""
    let cachedPage = ""
    let lastRequestTime = 0
    let serverRunning = false      // background server loop should keep running
    let loopRunning = false        // background server loop is currently alive
    // Remembered AP config so the server can re-run setup after a module reboot
    // (AT+SYSSTORE=0 means the module loses its config on reboot).
    let apTxPin = SerialPin.C17
    let apRxPin = SerialPin.C16
    let apBaud = BaudRate.BaudRate115200
    let apSsid = ""
    let apPasswd = ""
    let apReady = false            // did the last setup actually bring the AP up?
    // The web server can run in two modes: as its own access point, or joined to
    // an existing network. The reboot self-heal has to restore the right one.
    let serverStationMode = false
    let staIp = ""                 // our address on the joined network
    let mdnsOk = false             // did AT+MDNS actually work on this firmware?
    // Dashboard controls the user sets in the browser, exposed as MakeCode blocks.
    let ctrlToggle = [false, false, false]   // A, B, C
    let ctrlSlider = [0, 0, 0]               // A, B, C (0-100)
    let lastRowCount = 0   // client's new cursor (rows it has seen); reported as X-Row-Count
    let lastTotalRows = 0  // total data rows logged on the device; reported as X-Total-Rows
    // Wall-clock sync: browser piggybacks its Unix epoch (seconds) on every /data
    // poll as "?t=N". We record that value and the device's running time at that
    // moment so timestamp() can reconstruct the current wall-clock without any RTC.
    let syncedEpochSec = 0
    let syncedDeviceMs = 0
    let timeSynced = false
    // If no request arrives for this long (ms), assume the viewer vanished (e.g.
    // switched WiFi) leaving a half-open socket that holds the single connection
    // slot. We then close all sockets so a fresh browser can connect again. Must
    // be well above the 2 s poll interval so an active dashboard never trips it.
    const IDLE_RECOVER_MS = 8000

    /**
     * Set up the WiFi module as its own access point and start the web server.
     */
    //% block="Start Access Point|TX %txPin|RX %rxPin|Baud rate %baudRate|SSID %ssid|Password %passwd"
    //% group="Access Point"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% baudRate.defl=BaudRate.BaudRate115200
    //% ssid.defl="CalliopeHub"
    //% weight=80
    export function startAccessPoint(txPin: SerialPin, rxPin: SerialPin, baudRate: BaudRate, ssid: string, passwd: string) {
        serverStationMode = false
        // Remember the config so the background loop can re-run setup after a
        // module reboot (config isn't persisted -- AT+SYSSTORE=0).
        apTxPin = txPin
        apRxPin = rxPin
        apBaud = baudRate
        apSsid = ssid
        apPasswd = passwd
        wifiBaudRate = baudRate

        // Surface a "log full" banner on the dashboard when the flash log fills.
        datalogger.onLogFull(function () { logFull = true })

        doApSetup()
        startBackgroundServer()
    }

    /**
     * Serve the dashboard on a WiFi network that already exists, instead of
     * making one. Joins the network, then starts the same web server.
     *
     * The router decides our address, so the page is announced as
     * "calliope.local" via mDNS -- that works on iOS, macOS and Windows.
     * Android usually cannot resolve .local names; use "WiFi IP address" to read
     * the numeric address and type that instead.
     *
     * Use this OR "start access point", not both.
     */
    //% block="serve dashboard on WiFi|TX %txPin|RX %rxPin|Baud rate %baudRate|SSID = %ssid|Password = %passwd"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% baudRate.defl=BaudRate.BaudRate115200
    //% group="Access Point"
    //% weight=69
    export function startWebServerOnWifi(txPin: SerialPin, rxPin: SerialPin, baudRate: BaudRate, ssid: string, passwd: string) {
        apTxPin = txPin
        apRxPin = rxPin
        apBaud = baudRate
        apSsid = ssid
        apPasswd = passwd
        serverStationMode = true

        datalogger.onLogFull(function () { logFull = true })

        doStationSetup()
        startBackgroundServer()
    }

    /**
     * True if the module accepted the "calliope.local" name. If false the name
     * will not resolve, so use "WiFi IP address" instead. Android cannot resolve
     * .local names even when this is true.
     */
    //% block="calliope.local available?"
    //% group="Access Point"
    //% weight=67
    //% advanced=true
    export function mdnsAvailable(): boolean {
        return mdnsOk
    }

    /**
     * The address the dashboard is reachable at on the joined network, e.g.
     * "192.168.1.42". Empty until "serve dashboard on WiFi" has run. Useful on
     * Android, which cannot resolve "calliope.local".
     */
    //% block="WiFi IP address"
    //% group="Access Point"
    //% weight=68
    export function wifiIpAddress(): string {
        return staIp
    }

    // Join an existing network and start the same web server on it. Also used to
    // recover after a module reboot (config isn't persisted -- AT+SYSSTORE=0).
    function doStationSetup() {
        serial.redirect(apTxPin, apRxPin, BaudRate.BaudRate115200)
        serial.setRxBufferSize(254)

        // The module may still be booting; anything sent now would be lost.
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAtResponse("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }

        sendAtCmd("AT+SYSSTORE=0")
        waitAtResponse("OK", "ERROR", "FAIL", 3000)

        let baudNum = apBaud as number
        if (baudNum != 115200) {
            sendAtCmd("AT+UART_CUR=" + baudNum + ",8,1,0,0")
            basic.pause(100)
            serial.redirect(apTxPin, apRxPin, apBaud)
            basic.pause(100)
            sendAtCmd("AT")
            waitAtResponse("OK", "ERROR", "None", 1000)
        }

        sendAtCmd("AT+CWMODE=1")             // station
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Join, retried -- the first attempt can fail right after boot.
        apReady = false
        for (let attempt = 0; attempt < 3 && !apReady; attempt++) {
            sendAtCmd("AT+CWJAP=\"" + apSsid + "\",\"" + apPasswd + "\"")
            if (waitAtResponse("WIFI GOT IP", "ERROR", "None", 20000) == 1) apReady = true
            else basic.pause(500)
        }
        isWifiConnected = apReady

        // Read back the address the router gave us, so it can be shown on the
        // display. The reply looks like: +CIPSTA:ip:"192.168.1.42"
        staIp = ""
        sendAtCmd("AT+CIPSTA?")
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < 2000) {
            buf += serial.readString()
            if (buf.includes("OK") || buf.includes("ERROR")) break
            basic.pause(50)
        }
        let key = "+CIPSTA:ip:\""
        let i = buf.indexOf(key)
        if (i < 0) { key = "+CIPSTA_CUR:ip:\""; i = buf.indexOf(key) }
        if (i >= 0) {
            let j = buf.indexOf("\"", i + key.length)
            if (j > 0) staIp = buf.substr(i + key.length, j - i - key.length)
        }

        // Announce the dashboard as "calliope.local".
        // Reset first: AT+MDNS=1 is refused with ERROR if mDNS is ALREADY
        // running (this setup having run before, or the reboot self-heal
        // re-running it). That error is easy to misread as "this firmware has
        // no mDNS" -- it does: CONFIG_AT_MDNS_COMMAND_SUPPORT defaults to y and
        // module_esp32c3_default does not disable it.
        sendAtCmd("AT+MDNS=0")
        waitAtResponse("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+MDNS=1,\"calliope\",\"_http\",80")
        mdnsOk = waitAtResponse("OK", "ERROR", "None", 1000) == 1

        // Shut down any server left over from a previous run BEFORE configuring.
        // Config is volatile (SYSSTORE=0) but a running server is not cleared by
        // it, and AT+CIPSERVERMAXCONN is rejected while a server exists -- which
        // is exactly the ERROR seen on hardware here.
        sendAtCmd("AT+CIPSERVER=0")
        waitAtResponse("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPMUX=1")             // required for a TCP server
        waitAtResponse("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPSTO=10")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Must precede AT+CIPSERVER. If it still errors the server simply runs
        // with the firmware default, which is workable for one browser.
        sendAtCmd("AT+CIPSERVERMAXCONN=5")
        waitAtResponse("OK", "ERROR", "None", 1000)

        for (let attempt = 0; attempt < 3; attempt++) {
            sendAtCmd("AT+CIPSERVER=1,80")
            if (waitAtResponse("OK", "ERROR", "None", 1000) != 0) break
            basic.pause(300)
        }

        lastRequestTime = input.runningTime()
    }

    // Send the AP + web-server AT commands (also used to recover after a reboot).
    function doApSetup() {
        serial.redirect(apTxPin, apRxPin, BaudRate.BaudRate115200)
        // A bigger RX buffer reduces lost bytes while a request streams in.
        serial.setRxBufferSize(254)

        // No reset line: the module powers up together with the Calliope and may
        // still be booting. Wait until it actually answers AT before configuring,
        // otherwise our (volatile) config is sent into the void and no AP appears.
        // Retries for up to ~20 s; returns immediately once the module responds.
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAtResponse("OK", "ERROR", "None", 300) == 1) {
                ready = true
            } else {
                basic.pause(200)
            }
        }

        sendAtCmd("AT+SYSSTORE=0")
        waitAtResponse("OK", "ERROR", "FAIL", 3000)

        let baudNum = apBaud as number
        if (baudNum != 115200) {
            sendAtCmd("AT+UART_CUR=" + baudNum + ",8,1,0,0")
            basic.pause(100)
            serial.redirect(apTxPin, apRxPin, apBaud)
            basic.pause(100)
            sendAtCmd("AT")
            waitAtResponse("OK", "ERROR", "None", 1000)
        }

        // Bring up the SoftAP, retried: right after boot the AP subsystem can
        // still be initialising, so CWSAP returns ERROR (leaving the default
        // "ESP_xxxx" network) even though AT and CWMODE already answer. Retry
        // CWMODE+CWSAP until the rename actually sticks.
        apReady = false
        for (let attempt = 0; attempt < 5 && !apReady; attempt++) {
            sendAtCmd("AT+CWMODE=2")
            waitAtResponse("OK", "ERROR", "None", 1000)
            basic.pause(400)             // let the SoftAP subsystem come up
            if (apPasswd.length >= 8) {
                sendAtCmd("AT+CWSAP=\"" + apSsid + "\",\"" + apPasswd + "\",5,3")
            } else {
                sendAtCmd("AT+CWSAP=\"" + apSsid + "\",\"\",5,0")
            }
            if (waitAtResponse("OK", "ERROR", "None", 3000) == 1) {
                apReady = true
            } else {
                basic.pause(500)
            }
        }

        // Short, memorable AP address (default would be 192.168.4.1). Volatile
        // (SYSSTORE=0), so re-applied on every setup / reboot recovery.
        sendAtCmd("AT+CIPAP=\"10.0.0.1\",\"10.0.0.1\",\"255.255.255.0\"")
        waitAtResponse("OK", "ERROR", "None", 2000)

        // Advertise the dashboard as "calliope.local" via mDNS, so devices that
        // resolve .local names (iOS/macOS, Windows) can use the name instead of
        // the IP. Harmless if the firmware lacks mDNS -- it just answers ERROR and
        // we ignore it; 10.0.0.1 stays the reliable fallback (Android often can't
        // resolve .local). Must run after the SoftAP IP is set.
        // Reset first: AT+MDNS=1 is refused with ERROR if mDNS is ALREADY
        // running (this setup having run before, or the reboot self-heal
        // re-running it). That error is easy to misread as "this firmware has
        // no mDNS" -- it does: CONFIG_AT_MDNS_COMMAND_SUPPORT defaults to y and
        // module_esp32c3_default does not disable it.
        sendAtCmd("AT+MDNS=0")
        waitAtResponse("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+MDNS=1,\"calliope\",\"_http\",80")
        mdnsOk = waitAtResponse("OK", "ERROR", "None", 1000) == 1

        // Clear any server left running from a previous run: AT+CIPSERVERMAXCONN
        // below is rejected while one exists, and SYSSTORE=0 does not clear it.
        sendAtCmd("AT+CIPSERVER=0")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Multiple connections are required for a TCP server.
        sendAtCmd("AT+CIPMUX=1")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Keep-alive sockets are polled every ~2 s so they're never idle; this
        // reaps a socket the browser abandoned (tab closed / switched WiFi). Kept
        // short so a half-open socket frees the single slot quickly (the watchdog
        // in handleWebRequests is the faster backstop).
        sendAtCmd("AT+CIPSTO=10")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Allow the maximum number of simultaneous connections the AT firmware
        // supports (CIPMUX link ids 0-4 = 5 sockets). Removes the previous 2-slot
        // cap so a browser opening extra/backup sockets, or a stale half-open
        // socket, can't exhaust the slots and get refused. (Must be set before the
        // server is created.)
        sendAtCmd("AT+CIPSERVERMAXCONN=5")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Start the TCP server on port 80 (retry; ERROR may mean "already
        // running", which is fine -- treat either OK or ERROR as started).
        for (let attempt = 0; attempt < 3; attempt++) {
            sendAtCmd("AT+CIPSERVER=1,80")
            if (waitAtResponse("OK", "ERROR", "None", 1000) != 0) break
            basic.pause(300)
        }

        lastRequestTime = input.runningTime()
    }

    // Serve web requests automatically in the background once the AP is started,
    // so the user doesn't need a "forever" block. Runs as its own fiber and
    // yields with basic.pause so radio/sensor code keeps running.
    function startBackgroundServer() {
        serverRunning = true
        if (loopRunning) return            // a loop is already cycling
        control.inBackground(function () {
            loopRunning = true
            while (serverRunning) {
                handleWebRequests()
                basic.pause(5)
            }
            loopRunning = false
        })
    }

    /**
     * Stop the access point and the background web server.
     */
    //% block="Stop Access Point"
    //% group="Access Point"
    //% weight=10
    export function stopAccessPoint() {
        // Stop the background loop and wait until it has actually exited, so we
        // don't drive the serial port from two fibers at once.
        serverRunning = false
        while (loopRunning) basic.pause(10)

        sendAtCmd("AT+CIPCLOSE=5")           // close all connections
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        sendAtCmd("AT+CIPSERVER=0")          // stop the server
        waitAtResponse("OK", "ERROR", "None", 1000)
        apReady = false
    }

    /**
     * True if the access point was set up successfully (module answered and the
     * network was created). Use this instead of assuming startAccessPoint worked.
     */
    //% block="Access Point ready?"
    //% group="Access Point"
    //% weight=70
    export function accessPointOK(): boolean {
        return apReady
    }

    /**
     * State of a web dashboard toggle (on = true).
     */
    //% block="web toggle %which"
    //% group="Access Point"
    //% weight=60
    export function toggle(which: WebControl): boolean {
        return ctrlToggle[which]
    }

    /**
     * Value of a web dashboard slider (0-100).
     */
    //% block="web slider %which"
    //% group="Access Point"
    //% weight=50
    export function slider(which: WebControl): number {
        return ctrlSlider[which]
    }

    /**
     * Current wall-clock time as Unix timestamp (whole seconds since 1 Jan 1970),
     * synced from the browser when the dashboard first loaded.
     * Returns 0 before any browser has connected.
     * Use with datalogger.setTimestamp(Timestamp.None) and log this as a column.
     */
    //% block="WiFi timestamp (Unix s)"
    //% group="Access Point"
    //% weight=40
    export function timestamp(): number {
        if (!timeSynced) return 0
        return syncedEpochSec + Math.floor((input.runningTime() - syncedDeviceMs) / 1000)
    }


    // Handle one pending web request, if any. Called repeatedly by the background
    // server loop (startBackgroundServer); not a user-facing block.
    function handleWebRequests() {
        rxBuf += serial.readString()

        // Self-heal: the module prints "ready" when it (re)boots. Since the config
        // isn't persisted (AT+SYSSTORE=0), re-run setup -- otherwise the dashboard
        // dies permanently after a reboot (no data, reloads fail).
        if (rxBuf.indexOf("ready") >= 0) {
            rxBuf = ""
            basic.pause(500)
            if (serverStationMode) doStationSetup()
            else doApSetup()
            return
        }

        let idx = rxBuf.indexOf("+IPD,")
        if (idx < 0) {
            if (rxBuf.length > 1024) rxBuf = rxBuf.substr(rxBuf.length - 256)
            webWatchdog()
            return
        }

        // Wait until the request line ":GET <path>" is fully present.
        let getPos = rxBuf.indexOf(":GET ", idx)
        if (getPos < 0) {
            if (rxBuf.length > 2048) rxBuf = ""   // not a GET we handle; reset
            webWatchdog()
            return
        }

        // Link id: the number between "+IPD," and the next comma.
        let after = rxBuf.substr(idx + 5)
        let comma = after.indexOf(",")
        let linkId = comma > 0 ? after.substr(0, comma) : "0"

        // Path: from after ":GET " up to the next space. Require that space so we
        // only act on a COMPLETE request line -- otherwise a half-received
        // "GET /da" mis-routes (serving the whole page instead of the tiny JSON).
        let pathStart = getPos + 5
        let pathEnd = rxBuf.indexOf(" ", pathStart)
        if (pathEnd < 0) {
            if (rxBuf.length > 2048) rxBuf = ""   // wait for the rest of the line
            webWatchdog()
            return
        }
        let path = rxBuf.substr(pathStart, pathEnd - pathStart)

        rxBuf = ""
        drainIdle(150, 1500)             // let the module finish forwarding the request
        if (path.indexOf("/log.csv") == 0) {
            serveLogCsv(linkId)                  // streamed in batches, never one big string
        } else {
            serveResponse(linkId, routeResponse(path))
        }
        lastRequestTime = input.runningTime()
    }

    // If no request has arrived for a while, a viewer probably left (e.g. switched
    // WiFi or closed the tab) leaving a half-open socket that holds a connection
    // slot, so new browsers get refused. Close all sockets to free the slots.
    // This RE-FIRES every idle period (not just once): a browser that closes can
    // leave a fresh half-open socket behind, and a single close may not clear it,
    // so we keep reaping until a new browser actually connects. Fixes "can't
    // reconnect after closing the dashboard". An active dashboard polls every ~2 s
    // so it never goes idle long enough to trip this.
    function webWatchdog() {
        if (input.runningTime() - lastRequestTime > IDLE_RECOVER_MS) {
            sendAtCmd("AT+CIPCLOSE=5")          // link id 5 = all connections
            waitAtResponse("CLOSED", "OK", "ERROR", 1000)
            lastRequestTime = input.runningTime()   // throttle: re-fire after another idle period
        }
    }

    function routeResponse(path: string): string {
        if (path.indexOf("/controls") == 0) {
            return httpResponse("200 OK", "application/json", controlsJson())
        }
        if (path.indexOf("/data") == 0) {
            // The poll carries everything: the browser piggybacks its Unix time
            // (t=) and the dashboard control values (tA/sB/...) on every /data
            // request. Folding controls in here -- instead of a separate /set
            // request -- means there is only ever one request type in flight, so
            // a control change can't collide with a poll on the single-socket,
            // single-fiber server (which previously froze the dashboard).
            syncTimeFromQuery(path)
            applyControls(path)
            let clientFrom = parseQueryInt(path, "from")
            return httpDataResponse(logRowsCsv(clientFrom))
        }
        if (path.indexOf("/favicon") == 0) {
            return httpResponse("204 No Content", "text/plain", "")
        }
        return httpResponse("200 OK", "text/html", pageHtml())
    }

    // Parse the control params piggybacked on the /data poll
    // ("...&tA=1&tB=0&tC=1&sA=50&sB=75&sC=10") and update the control vars.
    // Unknown keys (from, t) are ignored, so it is safe to call on any /data URL.
    function applyControls(path: string) {
        let q = path.indexOf("?")
        if (q < 0) return
        let parts = path.substr(q + 1).split("&")
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            let key = parts[i].substr(0, eq)
            let val = parts[i].substr(eq + 1)
            if (key == "tA") ctrlToggle[0] = val == "1"
            else if (key == "tB") ctrlToggle[1] = val == "1"
            else if (key == "tC") ctrlToggle[2] = val == "1"
            else if (key == "sA") ctrlSlider[0] = clampPct(val)
            else if (key == "sB") ctrlSlider[1] = clampPct(val)
            else if (key == "sC") ctrlSlider[2] = clampPct(val)
        }
    }

    function clampPct(s: string): number {
        let n = Math.round(parseFloat(s))
        if (isNaN(n)) return 0
        return Math.max(0, Math.min(100, n))
    }

    function controlsJson(): string {
        return "{\"tA\":" + (ctrlToggle[0] ? "1" : "0") +
            ",\"tB\":" + (ctrlToggle[1] ? "1" : "0") +
            ",\"tC\":" + (ctrlToggle[2] ? "1" : "0") +
            ",\"sA\":" + ctrlSlider[0] +
            ",\"sB\":" + ctrlSlider[1] +
            ",\"sC\":" + ctrlSlider[2] + "}"
    }

    // Extract an integer query parameter from a path like "/data?from=42".
    // Returns -1 if the key is absent or unparseable.
    function parseQueryInt(path: string, key: string): number {
        let q = path.indexOf("?")
        if (q < 0) return -1
        let parts = path.substr(q + 1).split("&")
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            if (parts[i].substr(0, eq) == key) {
                let n = Math.round(parseFloat(parts[i].substr(eq + 1)))
                return isNaN(n) ? -1 : n
            }
        }
        return -1
    }

    // Re-sync the wall-clock from a "t=<unix seconds>" query param if present.
    // Called on every /data poll, so drift is bounded by the poll interval (~2 s).
    function syncTimeFromQuery(path: string) {
        let t = parseQueryInt(path, "t")
        if (t > 0) {
            syncedEpochSec = t
            syncedDeviceMs = input.runningTime()
            timeSynced = true
        }
    }

    // Datalogger is the single source. getRows(from, count): header is row 0,
    // getNumberOfRows() includes the header. Returns CSV (commas=cols, \n=rows).
    // Sets lastRowCount to the client's NEW cursor (the row index it has now seen
    // up to), which the response reports as X-Row-Count. When the response is
    // capped this is < the device total, so the client keeps polling to catch up.

    // First connection seeds the chart with this many recent rows. Kept small so
    // the very first poll (the slow "warte auf Daten" wait) returns quickly.
    const SEED_ROWS = 50

    // Hard cap on rows returned per /data poll. A client that fell behind (e.g. a
    // connection gap while toggling) then catches up over several polls instead of
    // pulling one big burst -- large responses stress the module and were a likely
    // crash trigger. 50 matches the seed, so no single response exceeds it.
    const MAX_ROWS_PER_POLL = 50

    // For the poll: clientFrom == -1 (first connection) returns header + last
    // SEED_ROWS data rows; clientFrom >= 0 returns only the rows after that index
    // (diff), capped at MAX_ROWS_PER_POLL. Empty body means already up to date.
    function logRowsCsv(clientFrom: number): string {
        let total = datalogger.getNumberOfRows()   // includes header row 0
        let totalData = total - 1
        lastTotalRows = totalData > 0 ? totalData : 0   // total recorded rows -> X-Total-Rows
        if (total <= 1) { lastRowCount = 0; return "" }
        let startData: number
        if (clientFrom < 0) {
            // First connection: seed with the last SEED_ROWS data rows
            startData = totalData - SEED_ROWS
            if (startData < 0) startData = 0
        } else {
            // Diff: only rows the client hasn't seen yet
            if (clientFrom >= totalData) { lastRowCount = totalData; return "" }
            startData = clientFrom
        }
        let count = totalData - startData
        if (count > MAX_ROWS_PER_POLL) count = MAX_ROWS_PER_POLL
        lastRowCount = startData + count   // client's new cursor (may be < totalData)
        let startIdx = startData + 1       // +1 because row 0 is the header
        return datalogger.getRows(0, 1) + "\n" + datalogger.getRows(startIdx, count)
    }

    function httpResponse(status: string, contentType: string, body: string): string {
        // Connection: keep-alive -> the browser reuses ONE socket for every poll
        // instead of reconnecting each time, avoiding the open/close churn that
        // fragments the module's heap and eventually reboots it.
        // X-Log-Full lets the page show a "log full" banner.
        return "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: " + contentType + "; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n" + body
    }

    // Like httpResponse but adds X-Row-Count for the browser's diff offset tracking.
    function httpDataResponse(body: string): string {
        return "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/csv; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "X-Row-Count: " + lastRowCount + "\r\n" +
            "X-Total-Rows: " + lastTotalRows + "\r\n" +
            "Connection: keep-alive\r\n\r\n" + body
    }

    function pageHtml(): string {
        if (cachedPage == "") {
            cachedPage =
                "<!DOCTYPE html><html lang=\"de\"><head>" +
                "<meta charset=\"utf-8\">" +
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
                "<title>Calliope mini WLAN-Log</title><style>" +
                "body{font-family:\"Roboto\",\"Helvetica Now\",Helvetica,Arial,sans-serif;margin:0;color:#222}" +
                ".header-strip{height:10px;background:#42c9c9}" +
                ".header-contents{padding:0 1em}" +
                "h1{display:block;font-size:2em;margin:.67em 0;font-weight:bold;unicode-bidi:isolate}" +
                "main{margin:1em}" +
                "table{border-collapse:collapse;width:100%}" +
                "th,td{border:1px solid #ddd;padding:8px}" +
                "th{background:#f3f3f3;text-align:left}" +
                "td.v{text-align:right;font-variant-numeric:tabular-nums}" +
                "tr:nth-child(even){background:#f2f2f2}" +
                "#meta{color:#555;font-size:13px;margin:.5em 0}" +
                "#last{color:#555;font-size:13px;margin:.75em 0}" +
                "#status{color:#888;font-size:13px}" +
                "#full{display:none;color:#c00;font-weight:700;font-size:13px;margin:.3em 0}" +
                "#charts{display:flex;flex-wrap:wrap;gap:1em;margin-top:1em}" +
                ".chart{border:1px solid #eee;border-radius:6px;width:420px;max-width:100%}" +
                "button{cursor:pointer;border-radius:23px;min-height:40px;font-weight:700;font-size:14px;padding:0 18px;border:none;background:#42c9c9;color:#fff;margin:.5em 0}" +
                ".top{display:flex;flex-wrap:wrap;gap:1em;align-items:flex-start}" +
                ".card{border:1px solid #ddd;border-radius:8px;padding:.6em 1em .9em;background:#fafafa}" +
                ".tablebox{flex:0 0 auto;width:280px;max-width:100%}" +
                ".tablebox table{margin-top:.3em}" +
                "#ctrls{flex:0 0 auto;width:280px;max-width:100%}" +
                "#ctrls h2{font-size:15px;margin:.4em 0;color:#4a5261}" +
                "#ctrls .row{display:flex;align-items:center;gap:.6em;margin:.7em 0}" +
                "#ctrls .lbl{width:5em}" +
                "#ctrls input[type=range]{flex:1;min-width:90px}" +
                "#ctrls .val{width:2.5em;text-align:right;font-variant-numeric:tabular-nums}" +
                "#ctrls input[type=checkbox]{width:38px;height:22px;accent-color:#42c9c9;cursor:pointer}" +
                "footer{margin:1em;color:#888;font-size:13px}" +
                "</style></head><body>" +
                "<header><div class=\"header-strip\"></div>" +
                "<div class=\"header-contents\"><h1>Calliope mini WLAN-Log</h1></div></header>" +
                "<main><div class=\"top\">" +
                "<div class=\"tablebox card\">" +
                "<table id=\"t\"><tr><th>Sensor</th><th>Wert</th></tr></table>" +
                "<div id=\"meta\">Empfangene Pakete: <span id=\"pkts\">0</span></div>" +
                "<div id=\"last\">Letzte Aktualisierung: nie</div>" +
                "<div id=\"full\">Log voll!</div>" +
                "<button onclick=\"dlCsv()\">Als CSV herunterladen</button>" +
                "</div>" +
                "<section id=\"ctrls\" class=\"card\"><h2>Steuerung</h2>" +
                "<div class=\"row\"><span class=\"lbl\">Schalter A</span><input type=\"checkbox\" id=\"tA\"></div>" +
                "<div class=\"row\"><span class=\"lbl\">Schalter B</span><input type=\"checkbox\" id=\"tB\"></div>" +
                "<div class=\"row\"><span class=\"lbl\">Schalter C</span><input type=\"checkbox\" id=\"tC\"></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler A</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sA\"><span id=\"sAv\" class=\"val\">0</span></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler B</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sB\"><span id=\"sBv\" class=\"val\">0</span></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler C</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sC\"><span id=\"sCv\" class=\"val\">0</span></div>" +
                "</section></div>" +
                "<div id=\"charts\"></div>" +
                "<div id=\"status\">warte auf Daten...</div></main>" +
                "<footer>Aktualisiert sich alle 2&nbsp;s &middot; live vom WLAN-Modul</footer>" +
                "<script>" +
                "function E(i){return document.getElementById(i)}" +
                "var s=E('status'),tbl=E('t'),lu=E('last'),charts=E('charts')," +
                "full=E('full'),pk=E('pkts');" +
                "var cols=[],rowEls=[],rows=[],offset=-1;" +
                "var inflight=false,ctrlReady=false,downloading=false;" +
                "function build(h){cols=h;for(var ci=0;ci<h.length;ci++){" +
                "var tr=tbl.insertRow();tr.insertCell().textContent=h[ci];" +
                "var vc=tr.insertCell();vc.className='v';" +
                "var bx=document.createElement('div');bx.className='chart';charts.appendChild(bx);" +
                "rowEls.push({v:vc,b:bx});}}" +
                // The full-log download is a big response. It must NOT run next to
                // the /data poll: the single-fiber server can't serve two sockets at
                // once (the browser opens a 2nd connection and gets REFUSED/EMPTY).
                // So pause polling, wait out any in-flight poll, then fetch with the
                // socket to ourselves. A 30s abort keeps a stalled download from
                // freezing the page; polling resumes (and catches up) either way.
                "async function dlCsv(){if(downloading)return;downloading=true;s.textContent='lade CSV...';" +
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},30000);try{" +
                "while(inflight)await new Promise(function(r){setTimeout(r,50);});" +
                "var resp=await fetch('/log.csv',{cache:'no-store',signal:ac.signal});" +
                "var t=await resp.text();" +
                "var a=document.createElement('a');a.download='calliope-log.csv';" +
                "a.href=URL.createObjectURL(new Blob([t.replace(/,/g,';')],{type:'text/csv'}));a.click();" +
                "s.textContent='CSV geladen';" +
                "}catch(e){s.textContent='CSV-Download fehlgeschlagen';}" +
                "finally{clearTimeout(tmo);downloading=false;}}" +
                "function svg(title,a){" +
                "var W=420,H=200,pl=46,pr=10,pt=20,pb=22,gw=W-pl-pr,gh=H-pt-pb,i,j;" +
                "var s='<svg viewBox=\"0 0 '+W+' '+H+'\" width=\"100%\" style=\"display:block\">';" +
                "s+='<text x=\"'+pl+'\" y=\"13\" fill=\"#4a5261\" font-family=\"sans-serif\" font-size=\"12\" font-weight=\"bold\">'+title+'</text>';" +
                "if(a.length<2)return s+'<text x=\"'+pl+'\" y=\"'+(H/2)+'\" fill=\"#aaa\" font-family=\"sans-serif\" font-size=\"11\">sammle Daten...</text></svg>';" +
                "var mn=Math.min.apply(null,a),mx=Math.max.apply(null,a);if(mn==mx){mn-=1;mx+=1;}" +
                "function yf(v){return (pt+gh-((v-mn)/(mx-mn))*gh).toFixed(1);}" +
                "function xf(q){return (pl+q/(a.length-1)*gw).toFixed(1);}" +
                "s+='<path d=\"M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'\" fill=\"none\" stroke=\"#ccc\"/>';" +
                "var yl=[mx,(mx+mn)/2,mn];" +
                "for(j=0;j<3;j++){var yy=yf(yl[j]);" +
                "s+='<line x1=\"'+pl+'\" y1=\"'+yy+'\" x2=\"'+(pl+gw)+'\" y2=\"'+yy+'\" stroke=\"#eee\"/>';" +
                "s+='<text x=\"2\" y=\"'+(+yy+3)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"10\">'+yl[j].toFixed(1)+'</text>';}" +
                "var p='';for(i=0;i<a.length;i++)p+=xf(i)+','+yf(a[i])+' ';" +
                "s+='<polyline fill=\"none\" stroke=\"#42c9c9\" stroke-width=\"2\" points=\"'+p+'\"/>';" +
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(a.length-1)*2);" +
                "s+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';" +
                "s+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"9\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}" +
                "return s+'</svg>';}" +
                "function ctrlQ(){return '&tA='+(elT[0].checked?1:0)+'&tB='+(elT[1].checked?1:0)+'&tC='+(elT[2].checked?1:0)+'&sA='+elS[0].value+'&sB='+elS[1].value+'&sC='+elS[2].value;}" +
                "async function tick(){if(inflight||downloading)return;inflight=true;" +
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},5000);try{" +
                "var ts=Math.floor(Date.now()/1000);" +
                "var url=(offset<0?'/data?t='+ts:'/data?from='+offset+'&t='+ts)+(ctrlReady?ctrlQ():'');" +
                "var resp=await fetch(url,{cache:'no-store',signal:ac.signal});" +
                "full.style.display=(resp.headers.get('X-Log-Full')=='1')?'':'none';" +
                "var tot=resp.headers.get('X-Total-Rows');if(tot!=null)pk.textContent=tot;" +
                "var rc=parseInt(resp.headers.get('X-Row-Count')||'-1');" +
                // Row count went backwards -> the device restarted/reset its log.
                // Our buffered rows are now stale; drop them and reseed next poll.
                "if(rc>=0&&offset>=0&&rc<offset){console.log('reset',rc,offset);rows.length=0;offset=-1;return;}" +
                "var t=await resp.text();" +
                "var L=t.replace(/\\r/g,'').split('\\n'),nr=[],li;" +
                "for(li=0;li<L.length;li++)if(L[li].length)nr.push(L[li].split(','));" +
                "if(rc>=0)offset=rc;" +
                "if(!cols.length&&nr.length)build(nr[0]);" +
                "for(var ri=1;ri<nr.length;ri++)rows.push(nr[ri]);" +
                "if(rows.length>500)rows.splice(0,rows.length-500);" +
                "if(!rows.length){s.textContent='(warte auf Daten...)';return;}" +
                "var d=rows.slice(-100),last=d[d.length-1],ci;" +
                "for(ci=0;ci<cols.length;ci++){if(!rowEls[ci])continue;" +
                "rowEls[ci].v.textContent=last[ci]!==undefined?last[ci]:'';" +
                "var arr=[],di;for(di=0;di<d.length;di++){var f=parseFloat(d[di][ci]);arr.push(isNaN(f)?0:f);}" +
                "rowEls[ci].b.innerHTML=svg(cols[ci],arr);}" +
                "lu.textContent='Letzte Aktualisierung: '+new Date().toLocaleString();" +
                "s.textContent='aktualisiert';" +
                "}catch(e){s.textContent='(warte auf Daten...)';}" +
                "finally{clearTimeout(tmo);inflight=false;}}" +
                "var elT=[E('tA'),E('tB'),E('tC')],elS=[E('sA'),E('sB'),E('sC')]," +
                "elSv=[E('sAv'),E('sBv'),E('sCv')];" +
                // Controls ride along on the next /data poll (no separate request,
                // so no collision with polling). Flipping a control triggers an
                // immediate tick() for snappy response; the inflight guard keeps
                // it from overlapping the periodic poll.
                "elT.forEach(function(e){e.addEventListener('change',tick);});" +
                "elS.forEach(function(e,i){e.addEventListener('change',tick);e.addEventListener('input',function(){elSv[i].textContent=e.value;});});" +
                "fetch('/controls',{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){" +
                "elT[0].checked=c.tA==1;elT[1].checked=c.tB==1;elT[2].checked=c.tC==1;" +
                "elS[0].value=c.sA;elS[1].value=c.sB;elS[2].value=c.sC;" +
                "elSv[0].textContent=c.sA;elSv[1].textContent=c.sB;elSv[2].textContent=c.sC;" +
                "ctrlReady=true;});" +
                "setInterval(tick,2000);tick();" +
                "</script></body></html>"
        }
        return cachedPage
    }

    // Send the response in <=CHUNK pieces on the given link id. No CIPCLOSE.
    function serveResponse(linkId: string, response: string) {
        let i = 0
        while (i < response.length) {
            let piece = response.substr(i, CHUNK)
            if (!sendChunk(linkId, piece)) return   // connection gone/busy; abort
            i += CHUNK
            basic.pause(20)   // small breather so we don't overrun the module
        }
    }

    // Stream the full log download without ever materialising it as one string: a
    // large contiguous allocation can fail on the fragmented heap (error 022).
    // Two passes -- measure the body length for Content-Length, then send the rows
    // in small batches.
    function serveLogCsv(linkId: string) {
        let total = datalogger.getNumberOfRows()   // includes the header row
        let BATCH = 20
        let bodyLen = 0
        let i = 0
        let first = true
        while (i < total) {
            let n = total - i
            if (n > BATCH) n = BATCH
            if (!first) bodyLen += 1                 // the "\n" that joins batches
            bodyLen += datalogger.getRows(i, n).length
            first = false
            i += n
        }
        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/csv; charset=utf-8\r\n" +
            "Content-Length: " + bodyLen + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n"
        if (!sendChunk(linkId, head)) return
        i = 0
        first = true
        while (i < total) {
            let n = total - i
            if (n > BATCH) n = BATCH
            let piece = (first ? "" : "\n") + datalogger.getRows(i, n)
            if (!sendChunk(linkId, piece)) return
            first = false
            i += n
            basic.pause(20)
        }
    }

    function sendChunk(linkId: string, piece: string): boolean {
        for (let attempt = 0; attempt < 2; attempt++) {
            sendAtCmd("AT+CIPSEND=" + linkId + "," + piece.length)
            let r = waitAtResponse(">", "ERROR", "busy", 3000)
            if (r == 1) {
                serial.writeString(piece)
                return waitAtResponse("SEND OK", "ERROR", "None", 5000) == 1
            }
            if (r == 2) return false            // connection already gone
            drainIdle(150, 1000)                // busy: settle and retry once
        }
        return false
    }

    // Read & discard until the link is quiet for idleMs (or maxMs elapses), so
    // we don't issue AT+CIPSEND while the module is still forwarding the request.
    // The basic.pause(5) is essential: without it this is a tight busy-loop that
    // never yields, starving the user's datalogger.log()/sensor fiber so no new
    // rows get logged (the dashboard then shows frozen values while still polling).
    function drainIdle(idleMs: number, maxMs: number) {
        let last = input.runningTime()
        let start = last
        while (input.runningTime() - start < maxMs) {
            let c = serial.readString()
            if (c.length > 0) {
                last = input.runningTime()
            } else if (input.runningTime() - last >= idleMs) {
                return
            }
            basic.pause(5)   // yield to other fibers (logging/sensors)
        }
    }

}
