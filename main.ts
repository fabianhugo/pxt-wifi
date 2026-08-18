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
/**
 * Functions to operate Grove module.
 */
//% weight=10 color=#9F79EE icon="\uf1b3" block="WiFi"
//% groups='["UartWiFi", "Access Point", "Web Controls", "Sensor Node"]'
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
    export function wifiOK() {
        return isWifiConnected
    }

    /**
     * Send data to ThingSpeak
     */
    //% block="Send Data to your ThingSpeak Channel|Write API Key %apiKey|Field1 %field1|Field2 %field2||Field3 %field3|Field4 %field4|Field5 %field5|Field6 %field6|Field7 %field7|Field8 %field8"
    //% group="UartWiFi"
    //% expandableArgumentMode="enabled"
    //% apiKey.defl="your Write API Key"
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
            lastAt = buffer                   // remember the raw reply for diagnostics

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
    let pageSegs: string[] = []
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
    // Address of the hub access point a sensor node pushes to (see pushToHub).
    // Matches the AT+CIPAP address the hub sets in doApSetup.
    let hubHost = "4.3.2.1"
    // Diagnostic: where the last pushToHub got to. 0 = ok, 1 = could not connect
    // (CIPSTART), 2 = no send prompt (CIPSEND), 3 = send not acknowledged.
    let pushStage = 0
    // Diagnostic: the raw text of the most recent AT reply (set by waitAtResponse).
    let lastAt = ""
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
    //% group="Web Controls"
    export function toggle(which: WebControl): boolean {
        return ctrlToggle[which]
    }

    /**
     * Value of a web dashboard slider (0-100).
     */
    //% block="web slider %which"
    //% group="Web Controls"
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


    // =========================================================================
    // Sensor node: push readings to the hub
    //
    // A second (third, ...) Calliope joins the hub's WiFi in station mode (use
    // "Setup Wifi" with the hub's SSID) and sends one row of readings to the hub
    // with pushToHub(). The hub logs each pushed row (tagged with the node name)
    // and the dashboard draws one chart line per node. The node stays a plain
    // HTTP client -- the hub remains the only server.
    // =========================================================================

    /**
     * Set the hub's IP address that pushToHub sends to (default 4.3.2.1).
     */
    //% block="hub address %host"
    //% host.defl="4.3.2.1"
    //% group="Sensor Node"
    export function setHubAddress(host: string) {
        hubHost = host
    }

    /**
     * Where the last pushToHub got to (for diagnosing a failed push):
     * 0 = ok, 1 = could not connect to the hub, 2 = no send prompt,
     * 3 = data sent but not acknowledged.
     */
    //% block="last push status"
    //% group="Sensor Node"
    export function pushStatus(): number {
        return pushStage
    }

    /**
     * The raw text of the most recent AT reply (CR/LF flattened to spaces), for
     * diagnosing a failed push -- e.g. show it with "show string".
     */
    //% block="last AT reply"
    //% group="Sensor Node"
    export function lastResponse(): string {
        let out = ""
        for (let i = 0; i < lastAt.length; i++) {
            let c = lastAt.charAt(i)
            if (c == "\r" || c == "\n") out += " "
            else out += c
        }
        return out
    }

    /**
     * Send one row of readings to the hub access point. Join the hub's WiFi
     * first with "Setup Wifi" (station mode). "node" names this sender so the
     * hub charts each node separately; the other values become columns. Returns
     * true if the hub accepted the row.
     */
    //% block="push to hub as node $node $data1||$data2 $data3 $data4 $data5"
    //% blockId=wifipushtohub
    //% node.defl="B"
    //% data1.shadow=dataloggercreatecolumnvalue
    //% data2.shadow=dataloggercreatecolumnvalue
    //% data3.shadow=dataloggercreatecolumnvalue
    //% data4.shadow=dataloggercreatecolumnvalue
    //% data5.shadow=dataloggercreatecolumnvalue
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Sensor Node"
    export function pushToHub(node: string, data1: datalogger.ColumnValue, data2?: datalogger.ColumnValue, data3?: datalogger.ColumnValue, data4?: datalogger.ColumnValue, data5?: datalogger.ColumnValue): boolean {
        let cvs = [data1, data2, data3, data4, data5].filter(el => !!el)
        let query = "node=" + urlEncode(node)
        for (let i = 0; i < cvs.length; i++) {
            query += "&" + urlEncode(cvs[i].column) + "=" + urlEncode(cvs[i].value)
        }
        return pushQuery(query)
    }

    // Open a short-lived TCP connection to the hub and send GET /push?<query>.
    // Single-connection mode (CIPMUX=0), like the ThingSpeak/Adafruit clients.
    // Always closes its own socket so the hub's connection slots aren't held.
    function pushQuery(query: string): boolean {
        let ok = false
        // Clear any stale connection first. The WiFi module has no reset line, so
        // it keeps TCP state across Calliope resets/reflashes -- a connection left
        // open by a previous run makes the next CIPSTART report "CLOSED" and fail.
        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        // Client side uses single-connection mode (no link id on CIPSTART/CIPSEND).
        // A node left in CIPMUX=1 by a previous program would reject these, so
        // force 0. (Safe: pushQuery always closes its socket, so none is active.)
        sendAtCmd("AT+CIPMUX=0")
        waitAtResponse("OK", "ERROR", "None", 1000)
        pushStage = 1                         // 1 = couldn't connect (until proven otherwise)
        let retry = 2
        while (retry > 0 && !ok) {
            retry--
            // Connect. Accept OK or ALREADY CONNECTED; on ERROR/timeout retry
            // (the old code fell through to CIPSEND on a timeout, sending into a
            // socket that was never established).
            sendAtCmd("AT+CIPSTART=\"TCP\",\"" + hubHost + "\",80")
            let r = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 5000)
            if (r != 1 && r != 2) { basic.pause(300); continue }
            pushStage = 2                     // connected; now sending
            let req = "GET /push?" + query + " HTTP/1.1\r\nHost: " + hubHost + "\r\nConnection: close\r\n\r\n"
            sendAtCmd("AT+CIPSEND=" + req.length)
            r = waitAtResponse(">", "ERROR", "busy", 3000)
            if (r != 1) {
                sendAtCmd("AT+CIPCLOSE")
                waitAtResponse("OK", "ERROR", "CLOSED", 1000)
                continue
            }
            pushStage = 3                     // got the send prompt; writing data
            serial.writeString(req)
            r = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "CLOSED", 1000)
            if (r == 1) { ok = true; pushStage = 0 }
        }
        return ok
    }

    // Minimal percent-encoding for query values (node names, column titles,
    // numeric values). Encodes the characters that would break a query string.
    function urlEncode(s: string): string {
        let out = ""
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i)
            if (c == " ") out += "%20"
            else if (c == "&") out += "%26"
            else if (c == "=") out += "%3D"
            else if (c == "+") out += "%2B"
            else if (c == "%") out += "%25"
            else if (c == "#") out += "%23"
            else if (c == "?") out += "%3F"
            else out += c
        }
        return out
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
        serveRequest(linkId, path)
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
        if (path.indexOf("/log.csv") == 0) {
            return httpResponse("200 OK", "text/csv", logFullCsv())   // full log download
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
        if (path.indexOf("/push") == 0) {
            // A sensor node delivered a row of readings (see pushToHub).
            return httpResponse("200 OK", "text/plain", ingestPush(path))
        }
        if (path.indexOf("/favicon") == 0) {
            return httpResponse("204 No Content", "text/plain", "")
        }
        return httpResponse("404 Not Found", "text/plain", "")
    }

    // A sensor node sends a row as GET /push?node=B&temp=21.4&light=120 . Each
    // key=value pair becomes a logged column (node= identifies the sender), so
    // the dashboard can chart each node as its own line. The hub's
    // setColumnTitles should include "node" plus the sensor names the nodes send.
    function ingestPush(path: string): string {
        let q = path.indexOf("?")
        if (q < 0) return "no data"
        let parts = path.substr(q + 1).split("&")
        let cvs: datalogger.ColumnValue[] = []
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            let key = urlDecode(parts[i].substr(0, eq))
            if (key.length == 0) continue
            let val = urlDecode(parts[i].substr(eq + 1))
            cvs.push(datalogger.createCV(key, val))
        }
        if (cvs.length == 0) return "no data"
        datalogger.logData(cvs)
        return "ok"
    }

    function urlDecode(s: string): string {
        let out = ""
        let i = 0
        while (i < s.length) {
            let c = s.charAt(i)
            if (c == "+") {
                out += " "
                i++
            } else if (c == "%" && i + 2 < s.length) {
                out += String.fromCharCode(hexVal(s.charAt(i + 1)) * 16 + hexVal(s.charAt(i + 2)))
                i += 3
            } else {
                out += c
                i++
            }
        }
        return out
    }

    function hexVal(c: string): number {
        let n = c.charCodeAt(0)
        if (n >= 48 && n <= 57) return n - 48        // 0-9
        if (n >= 97 && n <= 102) return n - 87       // a-f
        if (n >= 65 && n <= 70) return n - 55        // A-F
        return 0
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

    // For the download: the entire log.
    function logFullCsv(): string {
        return datalogger.getRows(0, datalogger.getNumberOfRows())
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

    // The dashboard page is stored as many small string segments and is NEVER
    // assembled into one big string -- a single ~14 KB allocation is what tripped
    // error 022 (GC_TOO_BIG_ALLOCATION) on the fragmented heap. servePage streams
    // these segments in CHUNK-sized packets, so total page size no longer matters.
    function buildPage() {
        if (pageSegs.length == 0) {
            pageSegs = [
                "<!DOCTYPE html><html lang=\"de\"><head>",
                "<meta charset=\"utf-8\">",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
                "<title>Calliope mini WLAN-Log</title><style>",
                "body{font-family:\"Roboto\",\"Helvetica Now\",Helvetica,Arial,sans-serif;margin:0;color:#222}",
                ".header-strip{height:10px;background:rgba(66,201,201,1)}",
                ".header-contents{padding:0 1em}",
                "h1{display:block;font-size:2em;margin:.67em 0;font-weight:bold;unicode-bidi:isolate}",
                "main{margin:1em}",
                "table{border-collapse:collapse;width:100%}",
                "th,td{border:1px solid #ddd;padding:8px}",
                "th{background:#f3f3f3;text-align:left}",
                "td.v{text-align:right;font-variant-numeric:tabular-nums}",
                "tr:nth-child(even){background:#f2f2f2}",
                "#last{color:#555;font-size:13px;margin:.75em 0}",
                "#meta{color:#555;font-size:13px;margin:.5em 0}",
                "#status{color:#888;font-size:13px}",
                "#full{display:none;color:#c00;font-weight:700;font-size:13px;margin:.3em 0}",
                "#charts{display:flex;flex-wrap:wrap;gap:1em;margin-top:1em}",
                ".chart{border:1px solid #eee;border-radius:6px;width:420px;max-width:100%}",
                "button{cursor:pointer;border-radius:23px;min-height:40px;font-weight:700;font-size:14px;padding:0 18px;border:none;background:rgba(66,201,201,1);color:#fff;margin:.5em 0}",
                ".top{display:flex;flex-wrap:wrap;gap:1em;align-items:flex-start}",
                ".card{border:1px solid #ddd;border-radius:8px;padding:.6em 1em .9em;background:#fafafa}",
                ".tablebox{flex:1 1 320px;min-width:280px;max-width:100%}",
                ".tablebox table{margin-top:.3em}",
                "#ctrls{flex:0 0 auto;width:280px;max-width:100%}",
                "#ctrls h2{font-size:15px;margin:.4em 0;color:#4a5261}",
                "#ctrls .row{display:flex;align-items:center;gap:.6em;margin:.7em 0}",
                "#ctrls .lbl{width:5em}",
                "#ctrls input[type=range]{flex:1;min-width:90px}",
                "#ctrls .val{width:2.5em;text-align:right;font-variant-numeric:tabular-nums}",
                ".switch{position:relative;display:inline-block;width:64px;height:28px;flex:none}",
                ".switch input{opacity:0;width:0;height:0}",
                ".switch .slider{position:absolute;inset:0;cursor:pointer;background:#bbb;border-radius:28px;transition:.2s}",
                ".switch .slider:before{content:\"\";position:absolute;height:22px;width:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.3)}",
                ".switch .slider:after{content:\"AUS\";position:absolute;right:7px;top:7px;font-size:10px;font-weight:700;color:#fff}",
                ".switch input:checked + .slider{background:rgba(66,201,201,1)}",
                ".switch input:checked + .slider:before{transform:translateX(36px)}",
                ".switch input:checked + .slider:after{content:\"EIN\";left:8px;right:auto}",
                "footer{margin:1em;color:#888;font-size:13px}",
                "</style></head><body>",
                "<header><div class=\"header-strip\"></div>",
                "<div class=\"header-contents\"><h1>Calliope mini WLAN-Log</h1></div></header>",
                "<main><div class=\"top\">",
                "<div class=\"tablebox card\">",
                "<table id=\"t\"><tr><th>Sensor</th><th>Wert</th></tr></table>",
                "<div id=\"meta\">Empfangene Pakete: <span id=\"pkts\">0</span></div>",
                "<div id=\"last\">Letzte Aktualisierung: nie</div>",
                "<div id=\"full\">Log voll!</div>",
                "<button onclick=\"dlCsv()\">Als CSV herunterladen</button>",
                "</div>",
                "<section id=\"ctrls\" class=\"card\"><h2>Steuerung</h2>",
                "<div class=\"row\"><span class=\"lbl\">Schalter A</span><label class=\"switch\"><input type=\"checkbox\" id=\"tA\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Schalter B</span><label class=\"switch\"><input type=\"checkbox\" id=\"tB\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Schalter C</span><label class=\"switch\"><input type=\"checkbox\" id=\"tC\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler A</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sA\"><span id=\"sAv\" class=\"val\">0</span></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler B</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sB\"><span id=\"sBv\" class=\"val\">0</span></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler C</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sC\"><span id=\"sCv\" class=\"val\">0</span></div>",
                "</section></div>",
                "<div id=\"charts\"></div>",
                "<div id=\"status\">warte auf Daten...</div></main>",
                "<footer>Aktualisiert sich alle 2&nbsp;s &middot; live vom WLAN-Modul</footer>",
                "<script>",
                "var s=document.getElementById('status'),tbl=document.getElementById('t'),",
                "lu=document.getElementById('last'),charts=document.getElementById('charts'),",
                "full=document.getElementById('full'),pk=document.getElementById('pkts');",
                "var cols=[],rowEls=[],rows=[],offset=-1;",
                "var inflight=false,ctrlReady=false,downloading=false;",
                // Multi-node: when the data has a "node" column, each row is tagged
                // with its sender and the dashboard groups by node (one chart line
                // per node). nodeIx<0 means single-source mode (original layout).
                "var nodeIx=-1,senIx=[],chB=[];",
                "var PAL=['#42c9c9','#e8743b','#19a979','#945ecf','#cc3c5d','#d39c00'];",
                "function build(h){cols=h;",
                "for(var k=0;k<h.length;k++)if(h[k].toLowerCase()=='node')nodeIx=k;",
                "if(nodeIx<0){",
                // Single-source: one table row + one chart per column (original).
                "for(var ci=0;ci<h.length;ci++){",
                "var tr=tbl.insertRow();tr.insertCell().textContent=h[ci];",
                "var vc=tr.insertCell();vc.className='v';",
                "var bx=document.createElement('div');bx.className='chart';charts.appendChild(bx);",
                "rowEls.push({v:vc,b:bx});}",
                "}else{",
                // Multi-node: one chart per sensor column (skip node + any time
                // column); the table is rebuilt each tick as Node x sensors.
                "for(var c2=0;c2<h.length;c2++){",
                "if(c2==nodeIx||h[c2].toLowerCase().indexOf('time')==0)continue;",
                "senIx.push(c2);",
                "var b2=document.createElement('div');b2.className='chart';charts.appendChild(b2);chB.push(b2);}",
                "}}",
                // The full-log download is a big response. It must NOT run next to
                // the /data poll: the single-fiber server can't serve two sockets at
                // once (the browser opens a 2nd connection and gets REFUSED/EMPTY).
                // So pause polling, wait out any in-flight poll, then fetch with the
                // socket to ourselves. A 30s abort keeps a stalled download from
                // freezing the page; polling resumes (and catches up) either way.
                "async function dlCsv(){if(downloading)return;downloading=true;s.textContent='lade CSV...';",
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},30000);try{",
                "while(inflight)await new Promise(function(r){setTimeout(r,50);});",
                "var resp=await fetch('/log.csv',{cache:'no-store',signal:ac.signal});",
                "var t=await resp.text();",
                "var a=document.createElement('a');a.download='calliope-log.csv';",
                "a.href=URL.createObjectURL(new Blob([t.replace(/,/g,';')],{type:'text/csv'}));a.click();",
                "s.textContent='CSV geladen';",
                "}catch(e){s.textContent='CSV-Download fehlgeschlagen';}",
                "finally{clearTimeout(tmo);downloading=false;}}",
                "function svg(title,a){",
                "var W=420,H=200,pl=46,pr=10,pt=20,pb=22,gw=W-pl-pr,gh=H-pt-pb,i,j;",
                "var s='<svg viewBox=\"0 0 '+W+' '+H+'\" width=\"100%\" style=\"display:block\">';",
                "s+='<text x=\"'+pl+'\" y=\"13\" fill=\"#4a5261\" font-family=\"sans-serif\" font-size=\"12\" font-weight=\"bold\">'+title+'</text>';",
                "if(a.length<2)return s+'<text x=\"'+pl+'\" y=\"'+(H/2)+'\" fill=\"#aaa\" font-family=\"sans-serif\" font-size=\"11\">sammle Daten...</text></svg>';",
                "var mn=Math.min.apply(null,a),mx=Math.max.apply(null,a);if(mn==mx){mn-=1;mx+=1;}",
                "function yf(v){return (pt+gh-((v-mn)/(mx-mn))*gh).toFixed(1);}",
                "function xf(q){return (pl+q/(a.length-1)*gw).toFixed(1);}",
                "s+='<path d=\"M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'\" fill=\"none\" stroke=\"#ccc\"/>';",
                "var yl=[mx,(mx+mn)/2,mn];",
                "for(j=0;j<3;j++){var yy=yf(yl[j]);",
                "s+='<line x1=\"'+pl+'\" y1=\"'+yy+'\" x2=\"'+(pl+gw)+'\" y2=\"'+yy+'\" stroke=\"#eee\"/>';",
                "s+='<text x=\"2\" y=\"'+(+yy+3)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"10\">'+yl[j].toFixed(1)+'</text>';}",
                "var p='';for(i=0;i<a.length;i++)p+=xf(i)+','+yf(a[i])+' ';",
                "s+='<polyline fill=\"none\" stroke=\"rgba(66,201,201,1)\" stroke-width=\"2\" points=\"'+p+'\"/>';",
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(a.length-1)*2);",
                "s+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';",
                "s+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"9\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}",
                "return s+'</svg>';}",
                // Multi-series chart: one labelled, coloured line per node.
                "function svgM(title,series){",
                "var W=420,H=210,pl=46,pr=10,pt=22,pb=22,gw=W-pl-pr,gh=H-pt-pb,i,k;",
                "var o='<svg viewBox=\"0 0 '+W+' '+H+'\" width=\"100%\" style=\"display:block\">';",
                "o+='<text x=\"'+pl+'\" y=\"13\" fill=\"#4a5261\" font-family=\"sans-serif\" font-size=\"12\" font-weight=\"bold\">'+title+'</text>';",
                "var all=[];for(k=0;k<series.length;k++)for(i=0;i<series[k].v.length;i++)all.push(series[k].v[i]);",
                "if(all.length<2)return o+'<text x=\"'+pl+'\" y=\"'+(H/2)+'\" fill=\"#aaa\" font-family=\"sans-serif\" font-size=\"11\">sammle Daten...</text></svg>';",
                "var mn=Math.min.apply(null,all),mx=Math.max.apply(null,all);if(mn==mx){mn-=1;mx+=1;}",
                "var ml=2;for(k=0;k<series.length;k++)if(series[k].v.length>ml)ml=series[k].v.length;",
                "function yf(val){return (pt+gh-((val-mn)/(mx-mn))*gh).toFixed(1);}",
                "function xf(q,len){return (pl+(len<2?gw:q/(len-1)*gw)).toFixed(1);}",
                "o+='<path d=\"M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'\" fill=\"none\" stroke=\"#ccc\"/>';",
                "var yl=[mx,(mx+mn)/2,mn];",
                "for(i=0;i<3;i++){var yy=yf(yl[i]);",
                "o+='<line x1=\"'+pl+'\" y1=\"'+yy+'\" x2=\"'+(pl+gw)+'\" y2=\"'+yy+'\" stroke=\"#eee\"/>';",
                "o+='<text x=\"2\" y=\"'+(+yy+3)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"10\">'+yl[i].toFixed(1)+'</text>';}",
                "for(k=0;k<series.length;k++){var a=series[k].v,p='';for(i=0;i<a.length;i++)p+=xf(i,a.length)+','+yf(a[i])+' ';",
                "o+='<polyline fill=\"none\" stroke=\"'+series[k].c+'\" stroke-width=\"2\" points=\"'+p+'\"/>';}",
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(ml-1)*2);",
                "o+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';",
                "o+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"9\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}",
                "var lx=pl+4;for(k=0;k<series.length;k++){",
                "o+='<rect x=\"'+lx+'\" y=\"'+(pt-9)+'\" width=\"9\" height=\"9\" fill=\"'+series[k].c+'\"/>';",
                "o+='<text x=\"'+(lx+12)+'\" y=\"'+(pt-1)+'\" fill=\"#555\" font-family=\"sans-serif\" font-size=\"10\">'+series[k].n+'</text>';",
                "lx+=22+series[k].n.length*6;}",
                "return o+'</svg>';}",
                // Render the Node x sensors table and one per-sensor chart (a line
                // per node) from the buffered rows. Used when nodeIx>=0.
                "function renderN(){var seen={},nodes=[],i,j,k;",
                "for(i=0;i<rows.length;i++){var nv=rows[i][nodeIx];if(nv!==undefined&&seen[nv]===undefined){seen[nv]=1;nodes.push(nv);}}",
                "if(!nodes.length)return;",
                "var h='<tr><th>Node</th>';for(j=0;j<senIx.length;j++)h+='<th>'+cols[senIx[j]]+'</th>';h+='</tr>';",
                "for(k=0;k<nodes.length;k++){var r=null;for(i=rows.length-1;i>=0;i--){if(rows[i][nodeIx]==nodes[k]){r=rows[i];break;}}",
                "h+='<tr><td>'+nodes[k]+'</td>';",
                "for(j=0;j<senIx.length;j++){var ci=senIx[j];h+='<td class=\"v\">'+((r&&r[ci]!==undefined)?r[ci]:'')+'</td>';}h+='</tr>';}",
                "tbl.innerHTML=h;",
                "var win=rows.slice(-400);",
                "for(j=0;j<senIx.length;j++){var c2=senIx[j],series=[];",
                "for(k=0;k<nodes.length;k++){var v=[];",
                "for(i=0;i<win.length;i++){if(win[i][nodeIx]!=nodes[k])continue;var fv=parseFloat(win[i][c2]);if(!isNaN(fv))v.push(fv);}",
                "series.push({n:nodes[k],c:PAL[k%PAL.length],v:v});}",
                "chB[j].innerHTML=svgM(cols[c2],series);}}",
                "function ctrlQ(){return '&tA='+(elT[0].checked?1:0)+'&tB='+(elT[1].checked?1:0)+'&tC='+(elT[2].checked?1:0)+'&sA='+elS[0].value+'&sB='+elS[1].value+'&sC='+elS[2].value;}",
                "async function tick(){if(inflight||downloading)return;inflight=true;",
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},5000);try{",
                "var ts=Math.floor(Date.now()/1000);",
                "var url=(offset<0?'/data?t='+ts:'/data?from='+offset+'&t='+ts)+(ctrlReady?ctrlQ():'');",
                "var resp=await fetch(url,{cache:'no-store',signal:ac.signal});",
                "full.style.display=(resp.headers.get('X-Log-Full')=='1')?'':'none';",
                "var tot=resp.headers.get('X-Total-Rows');if(tot!=null)pk.textContent=tot;",
                "var rc=parseInt(resp.headers.get('X-Row-Count')||'-1');",
                // Row count went backwards -> the device restarted/reset its log.
                // Our buffered rows are now stale; drop them and reseed next poll.
                "if(rc>=0&&offset>=0&&rc<offset){console.log('reset: Neustart erkannt rc='+rc+' offset='+offset);rows.length=0;offset=-1;return;}",
                "var t=await resp.text();",
                "var L=t.replace(/\\r/g,'').split('\\n'),nr=[],li;",
                "for(li=0;li<L.length;li++)if(L[li].length)nr.push(L[li].split(','));",
                "if(rc>=0)offset=rc;",
                "if(!cols.length&&nr.length)build(nr[0]);",
                "for(var ri=1;ri<nr.length;ri++)rows.push(nr[ri]);",
                "if(rows.length>500)rows.splice(0,rows.length-500);",
                "console.log('poll: X-Row-Count='+rc+' neueZeilen='+(nr.length>0?nr.length-1:0)+' offset='+offset+' puffer='+rows.length);",
                "if(!rows.length){s.textContent='(warte auf Daten...)';return;}",
                "if(nodeIx>=0){renderN();}else{",
                "var d=rows.slice(-100),last=d[d.length-1],ci;",
                "for(ci=0;ci<cols.length;ci++){if(!rowEls[ci])continue;",
                "rowEls[ci].v.textContent=last[ci]!==undefined?last[ci]:'';",
                "var arr=[],di;for(di=0;di<d.length;di++){var f=parseFloat(d[di][ci]);arr.push(isNaN(f)?0:f);}",
                "rowEls[ci].b.innerHTML=svg(cols[ci],arr);}}",
                "lu.textContent='Letzte Aktualisierung: '+new Date().toLocaleString();",
                "s.textContent='aktualisiert';",
                "}catch(e){s.textContent='(warte auf Daten...)';}",
                "finally{clearTimeout(tmo);inflight=false;}}",
                "var elT=[document.getElementById('tA'),document.getElementById('tB'),document.getElementById('tC')];",
                "var elS=[document.getElementById('sA'),document.getElementById('sB'),document.getElementById('sC')];",
                "var elSv=[document.getElementById('sAv'),document.getElementById('sBv'),document.getElementById('sCv')];",
                // Controls ride along on the next /data poll (no separate request,
                // so no collision with polling). Flipping a control triggers an
                // immediate tick() for snappy response; the inflight guard keeps
                // it from overlapping the periodic poll.
                "elT.forEach(function(e){e.addEventListener('change',tick);});",
                "elS.forEach(function(e,i){e.addEventListener('change',tick);e.addEventListener('input',function(){elSv[i].textContent=e.value;});});",
                "fetch('/controls',{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){",
                "elT[0].checked=c.tA==1;elT[1].checked=c.tB==1;elT[2].checked=c.tC==1;",
                "elS[0].value=c.sA;elS[1].value=c.sB;elS[2].value=c.sC;",
                "elSv[0].textContent=c.sA;elSv[1].textContent=c.sB;elSv[2].textContent=c.sC;",
                "ctrlReady=true;});",
                "setInterval(tick,2000);tick();",
                "</script></body></html>",
            ]
        }
    }

    // Dispatch a request. The two BIG responses (the dashboard page and the full
    // CSV log) are streamed so we never build the whole thing as one string --
    // that single oversized allocation is what trips error 022
    // (GC_TOO_BIG_ALLOCATION). All other responses are small and bounded, so they
    // go through the simple build-then-send path unchanged.
    function serveRequest(linkId: string, path: string) {
        if (path.indexOf("/log.csv") == 0) {
            serveLogCsv(linkId)
        } else if (path.indexOf("/data") == 0 || path.indexOf("/controls") == 0
            || path.indexOf("/push") == 0 || path.indexOf("/favicon") == 0) {
            serveResponse(linkId, routeResponse(path))
        } else {
            servePage(linkId)
        }
    }

    // Stream the dashboard HTML. The page is already cached as one string; we send
    // its bytes in CHUNK pieces directly instead of concatenating headers+body
    // into a second full-size copy (which doubled peak memory and caused 022).
    function servePage(linkId: string) {
        buildPage()
        let len = 0
        for (let i = 0; i < pageSegs.length; i++) len += pageSegs[i].length
        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: " + len + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n"
        if (!sendChunk(linkId, head)) return
        // Pack the small segments into <=CHUNK packets; never one big string.
        let buf = ""
        for (let i = 0; i < pageSegs.length; i++) {
            if (buf.length + pageSegs[i].length > CHUNK && buf.length > 0) {
                if (!sendChunk(linkId, buf)) return
                buf = ""
                basic.pause(20)
            }
            buf += pageSegs[i]
        }
        if (buf.length > 0) sendChunk(linkId, buf)
    }

    // Stream the full log as CSV without ever holding it all in one string.
    // Two passes over the rows in small batches: pass 1 measures the exact body
    // length (for Content-Length), pass 2 sends it batch by batch. Only the
    // snapshot of rows [0, total) is read, so rows appended meanwhile are ignored
    // and the length stays consistent.
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

    // Send a small header string, then a (possibly large) body in CHUNK pieces,
    // WITHOUT concatenating them into one big string first.
    function serveHeadAndBody(linkId: string, head: string, body: string) {
        if (!sendChunk(linkId, head)) return
        let i = 0
        while (i < body.length) {
            if (!sendChunk(linkId, body.substr(i, CHUNK))) return
            i += CHUNK
            basic.pause(20)
        }
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
