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
/**
 * Functions to operate Grove module.
 */
//% weight=10 color=#9F79EE icon="\uf1b3" block="WiFi"
//% groups='["UartWiFi", "Access Point", "Web Controls"]'
namespace WiFi {
    /**
     * 
     */

    let isWifiConnected = false;
    let wifiBaudRate = BaudRate.BaudRate115200;
    // Default target for the "internet ok" check. Small, stable, reserved for
    // exactly this kind of use, and not blocked in as many networks as the
    // public DNS resolvers.
    const PING_HOST = "example.com"
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

    /**
     * Check that the internet is actually reachable (not just the WiFi link).
     * Pings a well-known host; falls back to opening a TCP connection to it if
     * the module's firmware has no AT+PING. Needs station mode ("Setup Wifi").
     */
    //% block="Internet OK?"
    //% group="UartWiFi"
    //% weight=80
    export function internetOk(): boolean {
        return internetOkHost(PING_HOST)
    }

    /**
     * Like "internet ok" but you choose the host to test against.
     */
    //% block="internet ok via %host"
    //% host.defl="example.com"
    //% group="UartWiFi"
    //% advanced=true
    export function internetOkHost(host: string): boolean {
        // A WiFi join can succeed while the uplink is dead (captive portal, no
        // DHCP route, ISP down), so isWifiConnected alone proves nothing. But if
        // we never joined, there is nothing to test.
        if (!isWifiConnected) return false

        // Client requests use single-connection mode. A program that ran the AP
        // server left CIPMUX=1, which would reject the commands below; close any
        // stale socket first (the module keeps TCP state across Calliope resets).
        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        sendAtCmd("AT+CIPMUX=0")
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Preferred: a real ICMP ping. Answers "+PING:<ms>" then OK on success,
        // and "+timeout"/ERROR when the host is unreachable.
        sendAtCmd("AT+PING=\"" + host + "\"")
        let r = waitAtResponse("+PING:", "ERROR", "timeout", 6000)
        if (r == 1) return true

        // ERROR here is ambiguous: unreachable host, OR firmware without AT+PING.
        // Distinguish by trying a TCP connect to port 80 -- reaching the handshake
        // proves DNS and routing work, which is what "internet ok" really means.
        sendAtCmd("AT+CIPSTART=\"TCP\",\"" + host + "\",80")
        r = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 6000)
        let reachable = (r == 1 || r == 2)
        sendAtCmd("AT+CIPCLOSE")               // never leave the socket open
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        return reachable
    }

    // ---------------------------------------------------------------------
    // Internet clock
    //
    // Every HTTP server stamps its replies with a "Date:" header in the fixed
    // RFC 7231 format ("Date: Wed, 19 Aug 2026 15:43:39 GMT"), so we can read the
    // wall clock off any well-known website with no JSON parsing and no API key.
    // We ask for a 204 (empty body) URL so the reply is only headers.
    //
    // The fetched time is cached and kept running by input.runningTime(), so
    // repeated block calls do NOT hit the network every time.
    // ---------------------------------------------------------------------

    const TIME_HOST = "www.google.com"
    const TIME_PATH = "/generate_204"
    // Re-fetch at most this often (ms). Between fetches the clock is advanced
    // locally, which is plenty accurate for logging.
    const TIME_REFRESH_MS = 600000        // 10 minutes

    let netEpochSec = 0                   // Unix seconds at the moment of the fetch
    let netDeviceMs = 0                   // input.runningTime() at that same moment
    let netTimeOk = false                 // have we ever successfully fetched?
    let netLastTry = 0                    // runningTime() of the last attempt

    /**
     * Current time from the internet as a Unix timestamp (seconds since
     * 1 Jan 1970, UTC). Fetches from a website the first time it is used, then
     * keeps the clock running locally (re-checks every ~10 minutes).
     * Returns 0 if the time could not be fetched. Needs station mode
     * ("Setup Wifi") and a working internet connection.
     */
    //% block="internet time (Unix s)"
    //% group="UartWiFi"
    //% weight=78
    export function internetTimestamp(): number {
        refreshNetTime()
        if (!netTimeOk) return 0
        return netEpochSec + Math.floor((input.runningTime() - netDeviceMs) / 1000)
    }

    /**
     * One part (year, month, day, hour, minute or second) of the current time
     * fetched from the internet. Time is UTC. Returns 0 if the time could not
     * be fetched.
     */
    //% block="internet time %unit"
    //% group="UartWiFi"
    //% weight=77
    export function internetTime(unit: TimeUnit): number {
        let t = internetTimestamp()
        if (t == 0) return 0
        return civilFromUnix(t, unit)
    }

    // Fetch the time only if we have never got it, or the cache is stale.
    function refreshNetTime() {
        let now = input.runningTime()
        // Don't hammer the network when a fetch keeps failing: retry no more than
        // every 10 s until the first success.
        if (netTimeOk && (now - netDeviceMs) < TIME_REFRESH_MS) return
        if (netLastTry != 0 && (now - netLastTry) < 10000) return
        netLastTry = now
        fetchNetTime()
    }

    // Open a TCP connection, send a bare HTTP request and read the "Date:" header
    // out of the reply. Always closes its own socket.
    function fetchNetTime() {
        if (!isWifiConnected) return

        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        sendAtCmd("AT+CIPMUX=0")
        waitAtResponse("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPSTART=\"TCP\",\"" + TIME_HOST + "\",80")
        let r = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 6000)
        if (r != 1 && r != 2) return

        let req = "GET " + TIME_PATH + " HTTP/1.1\r\nHost: " + TIME_HOST + "\r\nConnection: close\r\n\r\n"
        sendAtCmd("AT+CIPSEND=" + req.length)
        r = waitAtResponse(">", "ERROR", "busy", 3000)
        if (r != 1) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "CLOSED", 1000)
            return
        }
        serial.writeString(req)

        // Collect the reply until we have the Date header (or give up).
        let buf = ""
        let start = input.runningTime()
        let epoch = 0
        while ((input.runningTime() - start) < 6000) {
            buf += serial.readString()
            let d = parseHttpDate(buf)
            if (d > 0) { epoch = d; break }
            basic.pause(100)
        }

        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)

        if (epoch > 0) {
            netEpochSec = epoch
            netDeviceMs = input.runningTime()
            netTimeOk = true
        }
    }

    // Pull "Date: Wed, 19 Aug 2026 15:43:39 GMT" out of an HTTP reply and convert
    // it to Unix seconds. Returns 0 if the header isn't there (yet) or is short.
    function parseHttpDate(resp: string): number {
        let i = resp.indexOf("Date: ")
        if (i < 0) i = resp.indexOf("date: ")
        if (i < 0) return 0
        let s = resp.substr(i + 6, 26)        // "Wed, 19 Aug 2026 15:43:39 "
        if (s.length < 25) return 0           // header not fully arrived yet
        // Fixed offsets after the 5-char weekday prefix ("Wed, ").
        let day = parseInt(s.substr(5, 2))
        let mon = monthFromName(s.substr(8, 3))
        let year = parseInt(s.substr(12, 4))
        let hour = parseInt(s.substr(17, 2))
        let min = parseInt(s.substr(20, 2))
        let sec = parseInt(s.substr(23, 2))
        // Sanity-check the parse rather than trusting fixed offsets blindly: a
        // mangled or partial header must yield 0, never a bogus time.
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

    // Days since 1 Jan 1970 for a civil date (year >= 1970).
    function daysFromCivil(year: number, mon: number, day: number): number {
        let days = 0
        for (let y = 1970; y < year; y++) days += isLeap(y) ? 366 : 365
        for (let m = 1; m < mon; m++) days += daysInMonth(year, m)
        return days + day - 1
    }

    function unixFromCivil(year: number, mon: number, day: number, hour: number, min: number, sec: number): number {
        return daysFromCivil(year, mon, day) * 86400 + hour * 3600 + min * 60 + sec
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

            if (buffer.includes(target1)) return 1
            if (buffer.includes(target2)) return 2
            if (buffer.includes(target3)) return 3

            basic.pause(100)
        }

        return 0
    }

    function sendAtCmd(cmd: string) {
        serial.writeString(cmd + "\u000D\u000A")
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
    export function startAccessPoint(txPin: SerialPin, rxPin: SerialPin, baudRate: BaudRate, ssid: string, passwd: string) {
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
        sendAtCmd("AT+CIPAP=\"4.3.2.1\",\"4.3.2.1\",\"255.255.255.0\"")
        waitAtResponse("OK", "ERROR", "None", 2000)

        // Advertise the dashboard as "calliope.local" via mDNS, so devices that
        // resolve .local names (iOS/macOS, Windows) can use the name instead of
        // the IP. Harmless if the firmware lacks mDNS -- it just answers ERROR and
        // we ignore it; 4.3.2.1 stays the reliable fallback (Android often can't
        // resolve .local). Must run after the SoftAP IP is set.
        sendAtCmd("AT+MDNS=1,\"calliope\",\"_http\",80")
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
    export function accessPointOK(): boolean {
        return apReady
    }

    /**
     * State of a web dashboard toggle (on = true).
     */
    //% block="web toggle %which"
    //% group="Access Point"
    export function toggle(which: WebControl): boolean {
        return ctrlToggle[which]
    }

    /**
     * Value of a web dashboard slider (0-100).
     */
    //% block="web slider %which"
    //% group="Access Point"
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
            doApSetup()
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
                ".header-strip{height:10px;background:rgba(66,201,201,1)}" +
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
                "button{cursor:pointer;border-radius:23px;min-height:40px;font-weight:700;font-size:14px;padding:0 18px;border:none;background:rgba(66,201,201,1);color:#fff;margin:.5em 0}" +
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
                ".switch{position:relative;display:inline-block;width:64px;height:28px;flex:none}" +
                ".switch input{opacity:0;width:0;height:0}" +
                ".switch .slider{position:absolute;inset:0;cursor:pointer;background:#bbb;border-radius:28px;transition:.2s}" +
                ".switch .slider:before{content:\"\";position:absolute;height:22px;width:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.3)}" +
                ".switch .slider:after{content:\"AUS\";position:absolute;right:7px;top:7px;font-size:10px;font-weight:700;color:#fff}" +
                ".switch input:checked + .slider{background:rgba(66,201,201,1)}" +
                ".switch input:checked + .slider:before{transform:translateX(36px)}" +
                ".switch input:checked + .slider:after{content:\"EIN\";left:8px;right:auto}" +
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
                "<div class=\"row\"><span class=\"lbl\">Schalter A</span><label class=\"switch\"><input type=\"checkbox\" id=\"tA\"><span class=\"slider\"></span></label></div>" +
                "<div class=\"row\"><span class=\"lbl\">Schalter B</span><label class=\"switch\"><input type=\"checkbox\" id=\"tB\"><span class=\"slider\"></span></label></div>" +
                "<div class=\"row\"><span class=\"lbl\">Schalter C</span><label class=\"switch\"><input type=\"checkbox\" id=\"tC\"><span class=\"slider\"></span></label></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler A</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sA\"><span id=\"sAv\" class=\"val\">0</span></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler B</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sB\"><span id=\"sBv\" class=\"val\">0</span></div>" +
                "<div class=\"row\"><span class=\"lbl\">Regler C</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sC\"><span id=\"sCv\" class=\"val\">0</span></div>" +
                "</section></div>" +
                "<div id=\"charts\"></div>" +
                "<div id=\"status\">warte auf Daten...</div></main>" +
                "<footer>Aktualisiert sich alle 2&nbsp;s &middot; live vom WLAN-Modul</footer>" +
                "<script>" +
                "var s=document.getElementById('status'),tbl=document.getElementById('t')," +
                "lu=document.getElementById('last'),charts=document.getElementById('charts')," +
                "full=document.getElementById('full'),pk=document.getElementById('pkts');" +
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
                "s+='<polyline fill=\"none\" stroke=\"rgba(66,201,201,1)\" stroke-width=\"2\" points=\"'+p+'\"/>';" +
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
                "if(rc>=0&&offset>=0&&rc<offset){console.log('reset: Neustart erkannt rc='+rc+' offset='+offset);rows.length=0;offset=-1;return;}" +
                "var t=await resp.text();" +
                "var L=t.replace(/\\r/g,'').split('\\n'),nr=[],li;" +
                "for(li=0;li<L.length;li++)if(L[li].length)nr.push(L[li].split(','));" +
                "if(rc>=0)offset=rc;" +
                "if(!cols.length&&nr.length)build(nr[0]);" +
                "for(var ri=1;ri<nr.length;ri++)rows.push(nr[ri]);" +
                "if(rows.length>500)rows.splice(0,rows.length-500);" +
                "console.log('poll: X-Row-Count='+rc+' neueZeilen='+(nr.length>0?nr.length-1:0)+' offset='+offset+' puffer='+rows.length);" +
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
                "var elT=[document.getElementById('tA'),document.getElementById('tB'),document.getElementById('tC')];" +
                "var elS=[document.getElementById('sA'),document.getElementById('sB'),document.getElementById('sC')];" +
                "var elSv=[document.getElementById('sAv'),document.getElementById('sBv'),document.getElementById('sCv')];" +
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
