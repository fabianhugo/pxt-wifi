/**
 * WiFi Hub - a Calliope + WiFi board that only collects readings from other
 * minis. No dashboard, no web page.
 *
 * WHY A SEPARATE DRIVER
 *
 * The full AP driver (main.ts) also serves a ~9.3 KB dashboard page. That page
 * is the expensive part, not the nodes: at 115200 baud one page load occupies
 * the UART for ~0.8 s, during which nothing else can be served, and building it
 * as one string is what caused the GC_TOO_BIG_ALLOCATION (error 022) crashes.
 * A node push is ~60 bytes in and ~40 bytes out -- about 9 ms. Dropping the
 * dashboard removes roughly 90% of the code and nearly all of the risk.
 *
 * WHAT THIS IS NOT: a router. In SoftAP mode (CWMODE=2) the module has no
 * uplink and no NAT, so nodes can reach this hub but NOT each other and NOT the
 * internet. It is a data collector.
 *
 * HOW MANY NODES
 *
 *   WiFi associations   up to 10   (AT+CWSAP max_conn; the default is 4)
 *   TCP sockets          5         (AT+CIPSERVERMAXCONN, the AT firmware max)
 *   Practical            3-5       set by the single-fibre server below
 *
 * Bandwidth would allow ~10 nodes, but the server handles one request at a time
 * through one shared RX buffer, so overlapping requests are the real limit.
 * Nodes connect -> send -> close, so they do not hold a socket between pushes.
 * If reboots appear under load, lengthen the node push interval before anything
 * else -- connection churn is what pressures the module's heap.
 *
 * DATA OUT: the hub logs to flash. Retrieve it over USB (MY_DATA.HTM). Nothing
 * is served over WiFi by design.
 *
 * BOTH HALVES ARE IN THIS FILE. A board is either a hub or a node, never both:
 * the hub needs CWMODE=2 (SoftAP), a node needs CWMODE=1 (station).
 *
 * HUB PROGRAM (one board)
 *   datalogger.setColumnTitles("node", "temp")
 *   WiFiHub.startHub(SerialPin.C17, SerialPin.C16, "CalliopeHub", "")
 *
 * NODE PROGRAM (the other boards, one each)
 *   WiFiHub.joinHub(SerialPin.C17, SerialPin.C16, "CalliopeHub", "")
 *   basic.forever(function () {
 *       WiFiHub.pushToHub("B", datalogger.createCV("temp", input.temperature()))
 *       basic.pause(2000)
 *   })
 */
// Debug output over software serial, for BOTH hubs and nodes. Wire a USB-TTL
// adapter's RX to P2 and open it at 4800 baud. Each board logs its own side:
// a hub reports rows arriving, a node reports joining and pushing. Set
// debugHUB = false to silence it (the logging is not free -- see the timing
// note in sendAtCmd).
let debugHUB = true
let debugHUBPIN = DigitalPin.P2
let debugHUBBAUD = softSerial.BaudRate.Baud4800

//% weight=9 color=#5C8DBC icon="" block="WiFi Hub"
//% groups='["Hub", "Node", "Status"]'
namespace WiFiHub {

    // Max simultaneous WiFi associations the SoftAP accepts. ESP-AT allows up
    // to 10; the default of 4 is the usual surprise when a 5th mini cannot join.
    // Note this is the WiFi limit, NOT the socket limit below.
    const AP_MAX_STATIONS = 10

    // Link ids 0-4, the AT firmware maximum. Nodes close their socket after each
    // push, so this is headroom against overlap and stale half-open sockets.
    const MAX_SOCKETS = 5

    // If nothing arrives for this long, assume a node vanished mid-request and
    // left a half-open socket holding a slot; close everything so new nodes can
    // connect. Re-fires every idle period until traffic resumes.
    const IDLE_RECOVER_MS = 20000

    let hubTxPin = SerialPin.C17
    let hubRxPin = SerialPin.C16
    let hubSsid = ""
    let hubPasswd = ""

    let rxBuf = ""
    let running = false            // the background loop should keep going
    let loopAlive = false          // ...and currently is
    let apReady = false
    let lastRequestTime = 0

    let rowsReceived = 0           // successful pushes ingested
    let badRequests = 0            // requests we could not parse

    // Last AT command sent, held until its reply arrives so the two print
    // together (see sendAtCmd).
    let pendingCmd = ""

    // Whether to answer a push with an HTTP 200. Off by default: the node waits
    // only for SEND OK from its OWN module and closes immediately, so it never
    // reads the reply. Sending one costs a CIPSEND round trip plus a wait for
    // SEND OK/FAIL -- time the hub needs for the next request when nodes push
    // fast. Turn it on if you point a browser or curl at /push and want to see
    // an answer.
    let replyToPushes = false

    // ---- node side (a mini that PUSHES to the hub) ----
    let joined = false             // did joinHub() succeed?
    let hubHost = "10.0.0.1"        // matches the CIPAP address the hub sets
    // Where the last push got to: 0 ok, 1 no connection, 2 no send prompt,
    // 3 sent but not acknowledged.
    let pushStage = 0

    /**
     * Start the hub: bring up the WiFi network other minis join, and begin
     * collecting their readings in the background.
     *
     * Set up the log columns first with datalogger.setColumnTitles, including
     * "node" plus the sensor names the nodes send.
     *
     * Leave the password empty for an open network, or use at least 8
     * characters for WPA2.
     */
    //% block="start hub|TX %txPin|RX %rxPin|network name %ssid|password %passwd"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% ssid.defl="CalliopeHub"
    //% group="Hub"
    //% weight=100
    export function startHub(txPin: SerialPin, rxPin: SerialPin, ssid: string, passwd: string) {
        hubTxPin = txPin
        hubRxPin = rxPin
        hubSsid = ssid
        hubPasswd = passwd
        rowsReceived = 0
        badRequests = 0

        apSetup()
        startBackgroundServer()
    }

    /** Stop collecting. The WiFi network stays up until the module is reset. */
    //% block="stop hub"
    //% group="Hub"
    //% weight=90
    export function stopHub() {
        running = false
    }

    /** True if the WiFi network came up and the hub is collecting. */
    //% block="hub OK?"
    //% group="Status"
    //% weight=80
    export function hubOK(): boolean {
        return apReady && running
    }

    /** How many rows nodes have pushed since the hub started. */
    //% block="rows received"
    //% group="Status"
    //% weight=79
    export function rowsCount(): number {
        return rowsReceived
    }

    /**
     * Requests the hub could not understand (malformed or unknown path). A
     * steadily rising count means a node is sending something unexpected.
     */
    //% block="bad requests"
    //% group="Status"
    //% weight=78
    //% advanced=true
    export function badRequestCount(): number {
        return badRequests
    }

    // ===================================================================
    // Node side
    //
    // A mini that SENDS readings to the hub. This is the other half of the
    // pairing and is deliberately in the same file so both programs come from
    // one extension.
    //
    // A board is either a hub or a node, never both: the hub needs CWMODE=2
    // (SoftAP) and a node needs CWMODE=1 (station). Do not call startHub and
    // joinHub in the same program.
    // ===================================================================

    /**
     * Join the hub's WiFi network (station mode). Use the same network name and
     * password given to "start hub" on the hub board.
     */
    //% block="join hub network|TX %txPin|RX %rxPin|network name %ssid|password %passwd"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% ssid.defl="CalliopeHub"
    //% group="Node"
    //% weight=70
    export function joinHub(txPin: SerialPin, rxPin: SerialPin, ssid: string, passwd: string): boolean {
        joined = false
        serial.redirect(txPin, rxPin, BaudRate.BaudRate115200)
        serial.setRxBufferSize(254)

        // Same reason as the hub: the module may still be booting, and anything
        // sent now would be lost.
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAtResponse("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }
        if (!ready) debugNote("node: module not answering AT")

        sendAtCmd("AT+SYSSTORE=0")
        waitAtResponse("OK", "ERROR", "FAIL", 3000)

        sendAtCmd("AT+CWMODE=1")            // station
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Retried: right after boot the first join can fail even though AT
        // already answers.
        for (let attempt = 0; attempt < 3 && !joined; attempt++) {
            sendAtCmd("AT+CWJAP=\"" + ssid + "\",\"" + passwd + "\"")
            if (waitAtResponse("WIFI GOT IP", "ERROR", "None", 20000) == 1) joined = true
            else basic.pause(500)
        }
        debugNote(joined ? "node: joined " + ssid
                         : "node: could NOT join " + ssid + " (3 tries)")
        return joined
    }

    /** True if this node joined the hub's network. */
    //% block="joined hub?"
    //% group="Node"
    //% weight=69
    export function joinedHub(): boolean {
        return joined
    }

    /**
     * The hub's address that "push to hub" sends to. Only needed if the hub was
     * changed from the default.
     */
    //% block="hub address %host"
    //% host.defl="10.0.0.1"
    //% group="Node"
    //% weight=68
    //% advanced=true
    export function setHubAddress(host: string) {
        hubHost = host
    }

    /**
     * Send one row of readings to the hub. Join the hub's network first.
     * "node" names this sender so the hub can tell the minis apart; the other
     * values become columns. Returns true if the hub accepted the row.
     */
    //% block="push to hub as node $node $data1||$data2 $data3 $data4 $data5"
    //% blockId=wifihubpush
    //% node.defl="B"
    //% data1.shadow=dataloggercreatecolumnvalue
    //% data2.shadow=dataloggercreatecolumnvalue
    //% data3.shadow=dataloggercreatecolumnvalue
    //% data4.shadow=dataloggercreatecolumnvalue
    //% data5.shadow=dataloggercreatecolumnvalue
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Node"
    //% weight=67
    export function pushToHub(node: string, data1: datalogger.ColumnValue, data2?: datalogger.ColumnValue, data3?: datalogger.ColumnValue, data4?: datalogger.ColumnValue, data5?: datalogger.ColumnValue): boolean {
        let cvs = [data1, data2, data3, data4, data5].filter(el => !!el)
        let query = "node=" + urlEncode(node)
        for (let i = 0; i < cvs.length; i++) {
            query += "&" + urlEncode(cvs[i].column) + "=" + urlEncode(cvs[i].value)
        }
        let ok = pushQuery(query)
        // Logged after the exchange, never during it -- the bit-banged write
        // would otherwise block while the hub's reply is arriving.
        if (ok) {
            debugNote("push ok: " + query)
        } else {
            debugNote("push FAILED (" + pushFailReason() + "): " + query)
        }
        return ok
    }

    /**
     * Where the last push got to, for diagnosing a failure: 0 = ok,
     * 1 = could not reach the hub, 2 = no send prompt, 3 = not acknowledged.
     */
    //% block="last push status"
    //% group="Node"
    //% weight=66
    //% advanced=true
    export function pushStatus(): number {
        return pushStage
    }

    // Wait for the ">" send prompt and nothing else. Returns false on timeout.
    // Deliberately does not treat "ERROR" as a stop condition -- see the call
    // site for why that was losing good sends.
    function waitForPrompt(timeout: number): boolean {
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < timeout) {
            buf += serial.readString()
            if (buf.includes(">")) { debugLog(buf); return true }
            basic.pause(20)
        }
        debugLog(buf + " [NO PROMPT]")
        return false
    }

    // Turn pushStage into something readable in the debug log.
    function pushFailReason(): string {
        if (pushStage == 1) return "no connection to hub"
        if (pushStage == 2) return "no send prompt"
        if (pushStage == 3) return "not acknowledged"
        return "unknown"
    }

    // Open a short-lived TCP connection to the hub and send GET /push?<query>.
    // Single-connection mode (CIPMUX=0), like the ThingSpeak/Adafruit clients.
    // Always closes its own socket, so a node never holds one of the hub's five
    // slots between pushes. (Reused from commit 7e14cb4.)
    function pushQuery(query: string): boolean {
        let ok = false
        // Clear any stale connection first. The module has no reset line, so it
        // keeps TCP state across Calliope resets/reflashes -- a connection left
        // open by a previous run makes the next CIPSTART report "CLOSED".
        sendAtCmd("AT+CIPCLOSE")
        waitAtResponse("OK", "ERROR", "CLOSED", 1000)
        // A node left in CIPMUX=1 by a previous program would reject these.
        sendAtCmd("AT+CIPMUX=0")
        waitAtResponse("OK", "ERROR", "None", 1000)

        pushStage = 1                        // couldn't connect, until proven otherwise
        let retry = 2
        while (retry > 0 && !ok) {
            retry--
            // Drop anything still sitting in the UART before opening a socket.
            // The module emits "CLOSED" for the PREVIOUS connection after we
            // have stopped reading (waitAtResponse discards whatever followed
            // the target it matched), so that stale line would otherwise be the
            // first thing the CIPSEND wait below sees -- and its trailing ERROR
            // aborted the send, costing a whole extra connect/fail cycle on
            // every push after the first.
            serial.readString()
            sendAtCmd("AT+CIPSTART=\"TCP\",\"" + hubHost + "\",80")
            let r = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 5000)
            if (r != 1 && r != 2) { basic.pause(300); continue }

            // Same again: CIPSTART's own reply may be followed by more traffic.
            serial.readString()

            pushStage = 2                    // connected; sending
            let req = "GET /push?" + query + " HTTP/1.1\r\nHost: " + hubHost + "\r\nConnection: close\r\n\r\n"
            sendAtCmd("AT+CIPSEND=" + req.length)
            // Wait for the ">" prompt specifically. Passing "ERROR" as a target
            // here is unsafe: the module echoes the command, and any stale line
            // still in flight can carry an ERROR that arrives BEFORE the prompt,
            // aborting a send that would have worked.
            if (!waitForPrompt(3000)) {
                sendAtCmd("AT+CIPCLOSE")
                waitAtResponse("OK", "ERROR", "CLOSED", 1000)
                continue
            }

            pushStage = 3                    // got the prompt; writing
            serial.writeString(req)
            r = waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "CLOSED", 1000)
            // Let the teardown actually finish. Without this the NEXT push's
            // CIPSTART is issued while the old socket is still closing: the
            // module answers CONNECT/OK, then tears the new socket down as the
            // old close completes, so CIPSEND is refused with a leading
            // "CLOSED ... ERROR" and the push costs a second connect attempt.
            // Seen on hardware as every push after the first taking two tries.
            basic.pause(200)
            serial.readString()              // drop the late "CLOSED" notice
            if (r == 1) { ok = true; pushStage = 0 }
        }
        return ok
    }

    // Minimal percent-encoding for query values (node names, column titles,
    // numbers). Encodes the characters that would break a query string.
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

    /**
     * Answer each push with an HTTP 200. Off by default -- nodes never read the
     * reply, and skipping it lets the hub keep up when they push quickly. Turn
     * it on to test the hub from a browser or curl.
     */
    //% block="reply to pushes %on"
    //% on.shadow=toggleOnOff
    //% group="Hub"
    //% weight=85
    //% advanced=true
    export function setReplyToPushes(on: boolean) {
        replyToPushes = on
    }

    // ---------------------------------------------------------------- setup

    // Bring the SoftAP and TCP server up. Also used to recover after a module
    // reboot, since AT+SYSSTORE=0 means nothing is persisted.
    function apSetup() {
        serial.redirect(hubTxPin, hubRxPin, BaudRate.BaudRate115200)
        // The pxt default RX buffer is 64 bytes, only ~5.5 ms of data at 115200.
        serial.setRxBufferSize(254)

        // No reset line: the module powers up with the Calliope and may still be
        // booting, so configuration sent now would go into the void and no AP
        // would appear. Wait for it to answer AT first (~20 s cap).
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAtResponse("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }

        sendAtCmd("AT+SYSSTORE=0")          // do not wear out flash with config
        waitAtResponse("OK", "ERROR", "FAIL", 3000)

        // Bring up the SoftAP, retried: right after boot the AP subsystem can
        // still be initialising and CWSAP answers ERROR, silently leaving the
        // default "ESP_xxxx" network in place.
        apReady = false
        for (let attempt = 0; attempt < 5 && !apReady; attempt++) {
            sendAtCmd("AT+CWMODE=2")
            waitAtResponse("OK", "ERROR", "None", 1000)
            basic.pause(400)                // let the SoftAP subsystem come up
            // ssid,pwd,channel,encryption,max_conn -- the 5th parameter is what
            // lets more than the default 4 minis associate.
            let tail = hubPasswd.length >= 8
                ? "\"" + hubSsid + "\",\"" + hubPasswd + "\",5,3"
                : "\"" + hubSsid + "\",\"\",5,0"
            sendAtCmd("AT+CWSAP=" + tail + "," + AP_MAX_STATIONS)
            if (waitAtResponse("OK", "ERROR", "None", 3000) == 1) {
                apReady = true
            } else {
                // Not every AT build accepts max_conn. A rejected CWSAP leaves
                // the module on its default "ESP_xxxx" network, which looks like
                // "the hub never appeared" -- so fall back to the 4-parameter
                // form that main.ts has always used. Costs one retry and caps
                // associations at the firmware default (4).
                sendAtCmd("AT+CWSAP=" + tail)
                if (waitAtResponse("OK", "ERROR", "None", 3000) == 1) apReady = true
                else basic.pause(500)
            }
        }

        // Short, memorable address. Nodes default to this (WiFi.setHubAddress).
        sendAtCmd("AT+CIPAP=\"10.0.0.1\",\"10.0.0.1\",\"255.255.255.0\"")
        waitAtResponse("OK", "ERROR", "None", 2000)

        sendAtCmd("AT+CIPMUX=1")            // required for a TCP server
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Reap sockets a node abandoned mid-push.
        sendAtCmd("AT+CIPSTO=10")
        waitAtResponse("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPSERVERMAXCONN=" + MAX_SOCKETS)
        waitAtResponse("OK", "ERROR", "None", 1000)

        // Start the server (ERROR usually just means "already running").
        for (let attempt = 0; attempt < 2; attempt++) {
            sendAtCmd("AT+CIPSERVER=1,80")
            if (waitAtResponse("OK", "ERROR", "None", 2000) == 1) break
            basic.pause(300)
        }

        lastRequestTime = input.runningTime()
        debugNote(apReady ? "hub up: " + hubSsid + " on 10.0.0.1"
                          : "hub FAILED to start (CWSAP never accepted)")
    }

    function startBackgroundServer() {
        running = true
        if (loopAlive) return               // one loop is enough
        control.inBackground(function () {
            loopAlive = true
            while (running) {
                handleRequests()
                basic.pause(5)              // yield so logging/sensors still run
            }
            loopAlive = false
        })
    }

    // -------------------------------------------------------------- serving

    // Handle one pending request, if any. The module forwards a request as
    // "+IPD,<link>,<len>:GET <path> HTTP/1.1...".
    function handleRequests() {
        rxBuf += serial.readString()

        // Self-heal: the module prints "ready" when it reboots. Config is
        // volatile (SYSSTORE=0), so re-run setup or the hub is dead for good.
        if (rxBuf.indexOf("ready") >= 0) {
            rxBuf = ""
            debugNote("module rebooted -- re-running setup")
            basic.pause(500)
            apSetup()
            return
        }

        let idx = rxBuf.indexOf("+IPD,")
        if (idx < 0) {
            // Keep the buffer bounded; never let noise grow without limit.
            if (rxBuf.length > 1024) rxBuf = rxBuf.substr(rxBuf.length - 256)
            idleWatchdog()
            return
        }

        let getPos = rxBuf.indexOf(":GET ", idx)
        if (getPos < 0) {
            if (rxBuf.length > 2048) rxBuf = ""     // not a GET we handle
            idleWatchdog()
            return
        }

        // Link id: the number between "+IPD," and the next comma.
        let after = rxBuf.substr(idx + 5)
        let comma = after.indexOf(",")
        let linkId = comma > 0 ? after.substr(0, comma) : "0"

        // Require the space after the path, so a half-received request line is
        // not acted on.
        let pathStart = getPos + 5
        let pathEnd = rxBuf.indexOf(" ", pathStart)
        if (pathEnd < 0) {
            if (rxBuf.length > 2048) rxBuf = ""
            idleWatchdog()
            return
        }
        let path = rxBuf.substr(pathStart, pathEnd - pathStart)

        // Consume ONLY this request, keeping anything already buffered behind
        // it. rxBuf = "" used to throw the remainder away, which silently
        // dropped a second node's request whenever two arrived close together --
        // and at speed they always do (the log showed +IPD lines cut mid-path).
        rxBuf = rxBuf.substr(pathEnd)
        // Reply IMMEDIATELY. The node sends "Connection: close" and drops its
        // socket as soon as its own module reports SEND OK -- it never reads the
        // HTTP response. Draining first (this used to be drainIdle(150, 1500))
        // meant the hub spent up to 1.5 s waiting for silence that never comes
        // when two nodes are pushing, by which time the socket was long gone and
        // every reply failed with "0,CLOSED ... ERROR".
        serveRequest(linkId, path)
        lastRequestTime = input.runningTime()
    }

    function serveRequest(linkId: string, path: string) {
        if (path.indexOf("/push") == 0) {
            // Log the row FIRST -- that is the job. The reply is optional.
            let body = ingestPush(path)
            if (replyToPushes) sendResponse(linkId, "200 OK", body)
            // Not replying leaves our end of the socket open; the module reaps
            // it via CIPSTO, and the node has already closed its side.
        } else if (path.indexOf("/favicon") == 0) {
            sendResponse(linkId, "204 No Content", "")
        } else {
            // Deliberately no dashboard: see the header comment.
            badRequests++
            debugNote("404 " + path)
            sendResponse(linkId, "404 Not Found", "hub: only /push")
        }
    }

    // A node sends a row as GET /push?node=B&temp=21.4&light=120 . Each
    // key=value pair becomes a logged column; node= identifies the sender.
    // (Reused unchanged from the multi-node work in commit 7e14cb4.)
    function ingestPush(path: string): string {
        let q = path.indexOf("?")
        if (q < 0) { badRequests++; return "no data" }
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
        if (cvs.length == 0) { badRequests++; debugNote("push: no data"); return "no data" }
        datalogger.logData(cvs)
        rowsReceived++
        // Safe here: the request is fully read and the reply has not been sent
        // yet, so blocking on the bit-banged log cannot lose incoming bytes.
        let summary = ""
        for (let j = 0; j < cvs.length; j++) {
            summary += (j > 0 ? " " : "") + cvs[j].column + "=" + cvs[j].value
        }
        debugNote("row " + rowsReceived + ": " + summary)
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

    // Replies are tiny (tens of bytes), so unlike the dashboard driver there is
    // no chunking and no risk of a large contiguous allocation.
    function sendResponse(linkId: string, status: string, body: string) {
        let resp = "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: text/plain\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Connection: close\r\n\r\n" + body
        // If the reply went out, close our end so the slot is freed promptly. If
        // it did not, the node already closed and CIPCLOSE would just add
        // another failing command to the log.
        if (sendChunk(linkId, resp)) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAtResponse("OK", "ERROR", "CLOSED", 500)
        }
    }

    // Best-effort reply. A node that has already closed is the NORMAL case, not
    // an error: it stops listening the moment its own module says SEND OK. So a
    // refused CIPSEND is not retried -- retrying just spent two more failed AT
    // commands per row and slowed the hub down under load.
    function sendChunk(linkId: string, piece: string): boolean {
        sendAtCmd("AT+CIPSEND=" + linkId + "," + piece.length)
        if (waitAtResponse(">", "ERROR", "link is not valid", 1000) != 1) {
            return false                    // socket gone; the row is already logged
        }
        serial.writeString(piece)
        return waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 2000) == 1
    }

    // A node that vanished mid-request leaves a half-open socket holding one of
    // the five slots. Re-fires every idle period until traffic resumes; an
    // active hub never goes idle this long.
    function idleWatchdog() {
        if (input.runningTime() - lastRequestTime > IDLE_RECOVER_MS) {
            sendAtCmd("AT+CIPCLOSE=5")      // link id 5 = all connections
            waitAtResponse("CLOSED", "OK", "ERROR", 1000)
            lastRequestTime = input.runningTime()
            debugNote("idle: closed all sockets")
        }
    }

    // ------------------------------------------------------------- AT plumbing

    function sendAtCmd(cmd: string) {
        serial.writeString(cmd + "\u000D\u000A")
        // The debug echo is deliberately NOT printed here. softSerial bit-bangs
        // at 4800 baud and busy-waits, so a ~50 character command blocks for
        // ~110 ms -- and at 115200 baud the module can deliver ~1150 bytes in
        // that time, far more than the 254-byte RX buffer holds. Logging before
        // the reply arrives therefore EATS the reply. Stash the command;
        // waitAtResponse prints both once the reply is safely read.
        pendingCmd = cmd
    }

    // Print ">>command" and "<<reply" together, after the reply is in hand.
    function debugLog(reply: string) {
        if (!debugHUB) return
        if (pendingCmd.length > 0) {
            softSerial.writeLine(debugHUBPIN, debugHUBBAUD, ">>" + pendingCmd)
            pendingCmd = ""
        }
        softSerial.writeLine(debugHUBPIN, debugHUBBAUD, "<<" + flatten(reply))
    }

    // A standalone line with no AT reply involved (an ingested row, a warning).
    function debugNote(msg: string) {
        if (!debugHUB) return
        softSerial.writeLine(debugHUBPIN, debugHUBBAUD, msg)
    }

    // CR/LF to spaces, so one AT exchange stays on one terminal line.
    function flatten(s: string): string {
        let out = ""
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i)
            if (c == "\r" || c == "\n") out += " "
            else out += c
        }
        return out
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
}
