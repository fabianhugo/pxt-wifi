/**
 * WiFi Live - a hub that collects readings from several minis and serves them
 * as a full dashboard: live table, per-sensor charts, CSV download and the
 * toggle/slider controls.
 *
 * This started as a values-only page (~1.6 KB, no flash reads). The charting
 * dashboard is back by request now that the transfer path is fixed; /live and
 * the values-only body are still served, so a minimal client can use them.
 *
 * WHY THIS EXISTS
 *
 * The full multi-node dashboard in main.ts is ~12.7 KB and re-reads the flash
 * log on every poll to redraw its charts. At 115200 baud one page load alone
 * occupies the UART for ~1.1 s, and building that page as one string is what
 * caused the GC_TOO_BIG_ALLOCATION (error 022) crashes.
 *
 * The dashboard is back, but the transport fixes found while building the
 * values-only page are kept: requests rescued out of AT replies, a bounded
 * rxBuf, drain-then-parse ordering, and no reply to node pushes. Those are what
 * made it survive two nodes plus a phone.
 *
 * /live still returns just the latest values as plain text, for a minimal
 * client that does not want the charts.
 *
 * HUB PROGRAM (one board)
 *   WiFiLive.startLiveHub(SerialPin.C17, SerialPin.C16, "CalliopeHub", "",
 *                         "temp", "licht")
 *   // then open http://10.0.0.1 on a phone joined to that network
 *
 * The column names are part of the block: the charts and the CSV are read back
 * OUT of the flash log, so they have to be set before anything is logged. The
 * "node" column is added automatically as the first one -- do not list it.
 *
 * NODE PROGRAM (each other board)
 *   WiFiLive.joinHub(SerialPin.C17, SerialPin.C16, "CalliopeHub", "")
 *   basic.forever(function () {
 *       WiFiLive.pushLive("pipig",
 *           datalogger.createCV("temp", input.temperature()),
 *           datalogger.createCV("licht", input.lightLevel()))
 *       basic.pause(2000)
 *   })
 *
 * A board is either a hub or a node, never both: the hub needs CWMODE=2
 * (SoftAP) and a node needs CWMODE=1 (station).
 */

// Debug output over software serial: wire a USB-TTL adapter's RX to P2, 4800 baud.
let debugLIVE = true
let debugLIVEPIN = DigitalPin.P19
let debugLIVEBAUD = softSerial.BaudRate.Baud4800

//% weight=8 color=#7B68EE icon="\uf0e4" block="WiFi Live"
//% groups='["Hub", "Node", "Status"]'
namespace WiFiLive {

    // The access point's fixed address. One definition: AT+CIPAP pins it and
    // liveAddress() reports it, so the two cannot drift apart.
    const AP_IP = "10.0.0.1"

    // How many different minis can be shown. Each costs one name plus one
    // readings string; a small cap keeps the page bounded and the heap calm.
    const MAX_NODES = 8

    // Close idle sockets after this long with no request, so a browser that
    // vanished cannot hold one of the five slots for ever.
    const IDLE_RECOVER_MS = 20000

    let txPin = SerialPin.C17
    let rxPin = SerialPin.C16
    let ssid = ""
    let passwd = ""

    let rxBuf = ""
    let running = false
    let loopAlive = false
    let apReady = false
    let lastRequestTime = 0

    // The whole "database": one slot per node, holding its most recent readings
    // exactly as they arrived ("temp=21.4&licht=88"). Overwritten on each push,
    // so memory does not grow no matter how long the hub runs.
    let nodeNames: string[] = []
    let nodeData: string[] = []
    let nodeSeen: number[] = []          // runningTime() of the last push
    let pushCount = 0

    // Write each push to flash. ON by default here: the dashboard's charts and
    // CSV download are read back OUT of the log, so switching this off leaves
    // the plots empty. (In the values-only build this defaulted to off.)
    let logToFlash = true

    // ---- dashboard state (charts / history / CSV) ----
    const CHUNK = 1024               // max bytes per AT+CIPSEND packet
    const SEED_ROWS = 50             // rows sent on a client's first poll
    const MAX_ROWS_PER_POLL = 50     // cap so a late client catches up gradually
    let pageSegs: string[] = []
    let logFull = false              // set by datalogger.onLogFull -> page banner
    let lastRowCount = 0             // client's new cursor -> X-Row-Count
    let lastTotalRows = 0            // device total -> X-Total-Rows
    let ctrlToggle = [false, false, false]
    let ctrlSlider = [0, 0, 0]
    // Wall-clock sync: the browser piggybacks its Unix time on every /data poll.
    let syncedEpochSec = 0
    let syncedDeviceMs = 0
    let timeSynced = false

    // ---- node side ----
    let joined = false
    let hubHost = AP_IP
    let pushStage = 0
    // Remembered from joinHub so a dropped node can rejoin by itself.
    let joinTx = SerialPin.C17
    let joinRx = SerialPin.C16
    let joinSsid = ""
    let joinPass = ""
    let lastRejoin = 0

    let pendingCmd = ""
    // Text of the most recent AT reply, so callers can inspect it without
    // re-reading the port (which would consume the next request).
    let lastReply = ""
    // Set by sendChunk when the module reported the peer closing during the
    // send, so the caller can skip a CIPCLOSE that would only answer ERROR.
    let peerClosed = false

    // ==================================================================
    // Hub
    // ==================================================================

    /**
     * Start the live hub: make the WiFi network the other minis join, log what
     * they send, and serve the dashboard.
     *
     * Name the sensor columns the nodes will send (temp, licht, ...). The
     * "node" column is added automatically as the first one, because the
     * dashboard needs it to tell the minis apart -- do not list it yourself.
     */
    //% block="start live hub|TX %tx|RX %rx|network name %name|password %pass|columns %col1||%col2 %col3 %col4 %col5"
    //% tx.defl=SerialPin.C17
    //% rx.defl=SerialPin.C16
    //% name.defl="CalliopeHub"
    //% col1.defl="temp"
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Hub"
    //% weight=100
    export function startLiveHub(tx: SerialPin, rx: SerialPin, name: string, pass: string, col1: string, col2?: string, col3?: string, col4?: string, col5?: string) {
        txPin = tx
        rxPin = rx
        ssid = name
        passwd = pass
        nodeNames = []
        nodeData = []
        nodeSeen = []
        pushCount = 0

        // "node" is fixed and always first: ingest() writes it as column 0, and
        // the dashboard groups the table and the chart series by it. Setting the
        // titles here means the hub program cannot forget to -- getting them
        // wrong left the charts silently empty.
        // setColumnTitles drops empty/undefined arguments itself (it filters on
        // !!el), so unused slots can be passed straight through.
        datalogger.setColumnTitles("node", col1, col2, col3, col4, col5)

        // The page shows a banner when the flash log fills up.
        datalogger.onLogFull(function () { logFull = true })

        apSetup()
        startBackgroundServer()
    }

    /**
     * Also write every reading to flash, so it can be downloaded over USB later
     * (MY_DATA.HTM). Off by default: the live page never reads the log, and
     * writing is the slow part of handling a push.
     */
    //% block="also log to flash %on"
    //% on.shadow=toggleOnOff
    //% group="Hub"
    //% weight=90
    export function setLogToFlash(on: boolean) {
        logToFlash = on
    }

    /** The address to open in a browser, e.g. "10.0.0.1". */
    //% block="live page address"
    //% group="Status"
    //% weight=80
    export function liveAddress(): string {
        return AP_IP
    }

    /** True if the WiFi network came up and the hub is serving. */
    //% block="live hub OK?"
    //% group="Status"
    //% weight=79
    export function liveHubOK(): boolean {
        return apReady && running
    }

    /** How many different minis have sent readings. */
    //% block="number of nodes"
    //% group="Status"
    //% weight=78
    export function nodeCount(): number {
        return nodeNames.length
    }

    /** Total readings received since the hub started. */
    //% block="readings received"
    //% group="Status"
    //% weight=77
    export function readingsCount(): number {
        return pushCount
    }

    // ==================================================================
    // Node
    // ==================================================================

    /**
     * Join the hub's WiFi network (station mode). Use the same name and
     * password given to "start live hub".
     */
    //% block="join hub|TX %tx|RX %rx|network name %name|password %pass"
    //% tx.defl=SerialPin.C17
    //% rx.defl=SerialPin.C16
    //% name.defl="CalliopeHub"
    //% group="Node"
    //% weight=70
    export function joinHub(tx: SerialPin, rx: SerialPin, name: string, pass: string): boolean {
        joinTx = tx
        joinRx = rx
        joinSsid = name
        joinPass = pass
        joined = false
        serial.redirect(tx, rx, BaudRate.BaudRate115200)
        serial.setRxBufferSize(254)

        // The module may still be booting; anything sent now would be lost.
        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAt("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }

        sendAtCmd("AT+SYSSTORE=0")
        waitAt("OK", "ERROR", "FAIL", 3000)
        sendAtCmd("AT+CWMODE=1")
        waitAt("OK", "ERROR", "None", 1000)

        for (let a = 0; a < 3 && !joined; a++) {
            sendAtCmd("AT+CWJAP=\"" + name + "\",\"" + pass + "\"")
            if (waitAt("WIFI GOT IP", "ERROR", "None", 20000) == 1) joined = true
            else basic.pause(500)
        }
        note(joined ? "node: joined " + name : "node: join FAILED")
        return joined
    }

    /** True if this mini joined the hub's network. */
    //% block="joined hub?"
    //% group="Node"
    //% weight=69
    export function joinedHub(): boolean {
        return joined
    }

    /**
     * Send this mini's current readings to the hub. "name" identifies this mini
     * on the page. Values replace whatever was sent before, so the page always
     * shows the latest.
     */
    //% block="send readings as %name $d1||$d2 $d3 $d4 $d5"
    //% blockId=wifilivepush
    //% name.defl="A"
    //% d1.shadow=dataloggercreatecolumnvalue
    //% d2.shadow=dataloggercreatecolumnvalue
    //% d3.shadow=dataloggercreatecolumnvalue
    //% d4.shadow=dataloggercreatecolumnvalue
    //% d5.shadow=dataloggercreatecolumnvalue
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Node"
    //% weight=68
    export function pushLive(name: string, d1: datalogger.ColumnValue, d2?: datalogger.ColumnValue, d3?: datalogger.ColumnValue, d4?: datalogger.ColumnValue, d5?: datalogger.ColumnValue): boolean {
        let cvs = [d1, d2, d3, d4, d5].filter(el => !!el)
        let q = "node=" + enc(name)
        for (let i = 0; i < cvs.length; i++) {
            q += "&" + enc(cvs[i].column) + "=" + enc(cvs[i].value)
        }
        // Do not push over a link that is not up. Hardware log showed 39
        // consecutive failures doing exactly that: the node had never joined (or
        // had been dropped -- 8x WIFI CONNECTED but only 2x WIFI GOT IP), and
        // every push still ran a full CIPCLOSE/CIPMUX/CIPSTART x2 sequence
        // against nothing. That AT churn is what drove the module into
        // "busy p..." where it stopped answering even a plain AT.
        if (!joined) {
            rejoin()
            if (!joined) {
                pushStage = 1
                note("push skipped: not joined")
                return false
            }
        }

        let ok = pushQuery(q)
        if (!ok && pushStage == 1) {
            // Could not reach the hub. The usual cause is that the WiFi link
            // dropped underneath us, so try once to get it back -- otherwise the
            // node stays dead until the program is restarted.
            joined = false
            rejoin()
        }
        note(ok ? "push ok: " + q : "push FAILED (" + failReason() + ")")
        return ok
    }

    /**
     * Where the last send got to: 0 = ok, 1 = no connection to the hub,
     * 2 = no send prompt, 3 = not acknowledged.
     */
    //% block="last send status"
    //% group="Node"
    //% weight=67
    //% advanced=true
    export function pushStatus(): number {
        return pushStage
    }

    // Re-join the network we were told about, at most every REJOIN_MS.
    //
    // The rate limit is essential: a FAILING join is expensive -- three CWJAP
    // attempts at a 20 s timeout each, so up to ~60 s. Two details matter and
    // both were got wrong first time:
    //   * the window must exceed that worst case, or the next push rejoins
    //     immediately and the node does nothing but join;
    //   * lastRejoin is stamped AFTER the attempt, not before, so the wait is
    //     measured from when we stopped trying rather than when we started.
    const REJOIN_MS = 30000
    function rejoin() {
        if (joinSsid.length == 0) return              // joinHub was never called
        if (lastRejoin != 0 && (input.runningTime() - lastRejoin) < REJOIN_MS) return
        note("node: link lost, rejoining " + joinSsid)
        joinHub(joinTx, joinRx, joinSsid, joinPass)
        lastRejoin = input.runningTime()
    }

    function failReason(): string {
        if (pushStage == 1) return "no connection"
        if (pushStage == 2) return "no prompt"
        if (pushStage == 3) return "not acknowledged"
        return "unknown"
    }

    // Short-lived TCP connection to the hub: connect, send, close. Never holds
    // one of the hub's five slots between pushes.
    function pushQuery(query: string): boolean {
        let ok = false
        sendAtCmd("AT+CIPCLOSE")
        waitAt("OK", "ERROR", "CLOSED", 1000)
        sendAtCmd("AT+CIPMUX=0")             // client mode: no link id
        waitAt("OK", "ERROR", "None", 1000)

        pushStage = 1
        let retry = 2
        while (retry > 0 && !ok) {
            retry--
            serial.readString()              // drop a late CLOSED from last time
            sendAtCmd("AT+CIPSTART=\"TCP\",\"" + hubHost + "\",80")
            let r = waitAt("CONNECT", "ALREADY CONNECTED", "ERROR", 5000)
            if (r != 1 && r != 2) { basic.pause(300); continue }

            pushStage = 2
            let req = "GET /p?" + query + " HTTP/1.1\r\nHost: " + hubHost + "\r\nConnection: close\r\n\r\n"
            sendAtCmd("AT+CIPSEND=" + req.length)
            // Wait for ">" only: "ERROR" as a target would match the echo of our
            // own command and abort a send that was about to succeed.
            if (!waitPrompt(3000)) {
                sendAtCmd("AT+CIPCLOSE")
                waitAt("OK", "ERROR", "CLOSED", 1000)
                continue
            }

            pushStage = 3
            serial.writeString(req)
            r = waitAt("SEND OK", "SEND FAIL", "ERROR", 5000)
            sendAtCmd("AT+CIPCLOSE")
            waitAt("OK", "ERROR", "CLOSED", 1000)
            // Let the teardown finish, or the NEXT connect races it and the
            // module refuses the send with a stale "CLOSED ... ERROR".
            basic.pause(200)
            serial.readString()
            if (r == 1) { ok = true; pushStage = 0 }
        }
        return ok
    }

    function waitPrompt(timeout: number): boolean {
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < timeout) {
            buf += serial.readString()
            if (buf.includes(">")) { log(buf); return true }
            basic.pause(20)
        }
        log(buf + " [NO PROMPT]")
        return false
    }

    function enc(s: string): string {
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

    // ==================================================================
    // Server
    // ==================================================================

    function apSetup() {
        serial.redirect(txPin, rxPin, BaudRate.BaudRate115200)
        serial.setRxBufferSize(254)

        let ready = false
        for (let i = 0; i < 40 && !ready; i++) {
            sendAtCmd("AT")
            if (waitAt("OK", "ERROR", "None", 300) == 1) ready = true
            else basic.pause(200)
        }

        sendAtCmd("AT+SYSSTORE=0")
        waitAt("OK", "ERROR", "FAIL", 3000)

        apReady = false
        for (let a = 0; a < 5 && !apReady; a++) {
            sendAtCmd("AT+CWMODE=2")
            waitAt("OK", "ERROR", "None", 1000)
            basic.pause(400)                 // let the SoftAP subsystem come up
            if (passwd.length >= 8) {
                sendAtCmd("AT+CWSAP=\"" + ssid + "\",\"" + passwd + "\",5,3")
            } else {
                sendAtCmd("AT+CWSAP=\"" + ssid + "\",\"\",5,0")
            }
            if (waitAt("OK", "ERROR", "None", 3000) == 1) apReady = true
            else basic.pause(500)
        }

        sendAtCmd("AT+CIPAP=\"" + AP_IP + "\",\"" + AP_IP + "\",\"255.255.255.0\"")
        waitAt("OK", "ERROR", "None", 2000)

        // Stop any server left running: AT+CIPSERVERMAXCONN below is rejected
        // while one exists, and SYSSTORE=0 does not clear it.
        sendAtCmd("AT+CIPSERVER=0")
        waitAt("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPMUX=1")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+CIPSTO=10")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+CIPSERVERMAXCONN=5")
        waitAt("OK", "ERROR", "None", 1000)

        for (let a = 0; a < 3; a++) {
            sendAtCmd("AT+CIPSERVER=1,80")
            if (waitAt("OK", "ERROR", "None", 1000) != 0) break
            basic.pause(300)
        }

        lastRequestTime = input.runningTime()
        note(apReady ? "hub up: " + ssid + " on " + AP_IP : "hub FAILED to start")
    }

    function startBackgroundServer() {
        running = true
        if (loopAlive) return
        control.inBackground(function () {
            loopAlive = true
            while (running) {
                handleRequests()
                basic.pause(5)               // yield to the user's own code
            }
            loopAlive = false
        })
    }

    function handleRequests() {
        rxBuf += serial.readString()

        // The module prints "ready" when it reboots. Config is volatile
        // (SYSSTORE=0), so re-run setup or the hub is dead for good.
        if (rxBuf.indexOf("ready") >= 0) {
            rxBuf = ""
            note("module rebooted -- re-running setup")
            basic.pause(500)
            apSetup()
            return
        }

        let idx = rxBuf.indexOf("+IPD,")
        if (idx < 0) {
            if (rxBuf.length > 1024) rxBuf = rxBuf.substr(rxBuf.length - 256)
            idleWatchdog()
            return
        }
        let getPos = rxBuf.indexOf(":GET ", idx)
        if (getPos < 0) {
            if (rxBuf.length > 2048) rxBuf = ""
            idleWatchdog()
            return
        }

        let after = rxBuf.substr(idx + 5)
        let comma = after.indexOf(",")
        let linkId = comma > 0 ? after.substr(0, comma) : "0"

        let pathStart = getPos + 5
        let pathEnd = rxBuf.indexOf(" ", pathStart)
        if (pathEnd < 0) {                   // request line not complete yet
            if (rxBuf.length > 2048) rxBuf = ""
            idleWatchdog()
            return
        }
        let path = rxBuf.substr(pathStart, pathEnd - pathStart)

        // Consume this request INCLUDING its headers. A node push ends right
        // after the path, but a browser sends ~400 more bytes (Host, Accept,
        // User-Agent...). Leaving those in rxBuf -- and, worse, in the module's
        // UART queue -- meant the AT+CIPSEND below read header text while
        // hunting for the ">" prompt and timed out, so the page was never sent.
        // A request ends at the blank line after the headers.
        // Wait for the whole request to arrive BEFORE trimming. drainIdle appends
        // what it reads to rxBuf, so doing this first means the blank line that
        // ends the headers is actually present to be found -- and any following
        // request is preserved rather than cut away.
        if (rxBuf.indexOf("\r\n\r\n", pathEnd) < 0) drainIdle(120, 800)

        let endOfReq = rxBuf.indexOf("\r\n\r\n", pathEnd)
        if (endOfReq >= 0) {
            rxBuf = rxBuf.substr(endOfReq + 4)   // keep anything queued behind it
        } else {
            rxBuf = ""                            // headers never completed
        }

        serveRequest(linkId, path)
        lastRequestTime = input.runningTime()
    }

    function serveRequest(linkId: string, path: string) {
        // NOTE ordering: "/p" is tested before "/push" would be, and "/live"
        // before the catch-all. Nodes still POST to /p, so they do NOT need
        // reflashing when switching between the values-only and dashboard builds.
        if (path.indexOf("/p?") == 0 || path == "/p") {
            // A node pushed readings. Nodes never read the reply -- they close
            // as soon as their own module reports SEND OK -- so do not send one.
            ingest(path)
        } else if (path.indexOf("/live") == 0) {
            serveText(linkId, liveBody())
        } else if (path.indexOf("/controls") == 0) {
            serveResponse(linkId, httpResponse("200 OK", "application/json", controlsJson()))
        } else if (path.indexOf("/log.csv") == 0) {
            serveLogCsv(linkId)
        } else if (path.indexOf("/data") == 0) {
            // The poll carries the browser clock (t=) and the control values,
            // so only one request type is ever in flight.
            syncTimeFromQuery(path)
            applyControls(path)
            serveResponse(linkId, httpDataResponse(logRowsCsv(parseQueryInt(path, "from"))))
        } else if (path.indexOf("/favicon") == 0) {
            serveText(linkId, "")
        } else {
            servePage(linkId)
        }
    }

    // Store the readings for one node, replacing whatever it sent before.
    function ingest(path: string) {
        let q = path.indexOf("?")
        if (q < 0) return
        let parts = path.substr(q + 1).split("&")

        let name = ""
        let readings = ""
        let cvs: datalogger.ColumnValue[] = []
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            let k = dec(parts[i].substr(0, eq))
            let v = dec(parts[i].substr(eq + 1))
            if (k == "node") { name = v; continue }
            if (k.length == 0) continue
            if (readings.length > 0) readings += ","
            readings += k + "=" + v
            if (logToFlash) cvs.push(datalogger.createCV(k, v))
        }
        if (name.length == 0 || readings.length == 0) return

        let slot = nodeNames.indexOf(name)
        if (slot < 0) {
            if (nodeNames.length >= MAX_NODES) return   // ignore extra minis
            nodeNames.push(name)
            nodeData.push("")
            nodeSeen.push(0)
            slot = nodeNames.length - 1
        }
        nodeData[slot] = readings
        nodeSeen[slot] = input.runningTime()
        pushCount++

        if (logToFlash && cvs.length > 0) {
            // "node" first, then the readings. Built in order rather than with
            // insertAt so this stays on the same String/Array methods the rest
            // of the driver already relies on.
            let row: datalogger.ColumnValue[] = [datalogger.createCV("node", name)]
            for (let j = 0; j < cvs.length; j++) row.push(cvs[j])
            datalogger.logData(row)
        }
        note("live " + name + ": " + readings)
    }

    // One line per node: "name,key=value,key=value". Built fresh each request;
    // with MAX_NODES it stays a few hundred bytes, far below the allocation size
    // that caused error 022 in the charting dashboard.
    function liveBody(): string {
        let out = ""
        for (let i = 0; i < nodeNames.length; i++) {
            out += nodeNames[i] + "," + nodeData[i] + "\n"
        }
        return out
    }

    function serveText(linkId: string, body: string) {
        let resp = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n\r\n" + body
        // Only close if the peer has not already gone. Closing a dead link
        // answers ERROR and, worse, that exchange can swallow the browser's next
        // request.
        if (sendChunk(linkId, resp) && !peerClosed) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAt("OK", "ERROR", "CLOSED", 500)
        }
    }

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

    function sendChunk(linkId: string, piece: string): boolean {
        peerClosed = false
        sendAtCmd("AT+CIPSEND=" + linkId + "," + piece.length)
        if (waitAt(">", "ERROR", "link is not valid", 1000) != 1) return false
        serial.writeString(piece)
        let ok = waitAt("SEND OK", "SEND FAIL", "ERROR", 2000) == 1
        // "Connection: close" means the browser hangs up as soon as it has the
        // body, so <id>,CLOSED usually arrives with the SEND OK.
        if (lastReply.indexOf(linkId + ",CLOSED") >= 0) peerClosed = true
        return ok
    }


    // Read until the line has been quiet for idleMs (or maxMs elapses), so a
    // request that is still streaming in is fully absorbed before we reply.
    // The pause matters: without it this starves the user's own code.
    function drainIdle(idleMs: number, maxMs: number) {
        let start = input.runningTime()
        let lastData = start
        while (input.runningTime() - start < maxMs) {
            let s = serial.readString()
            if (s.length > 0) {
                lastData = input.runningTime()
                // Keep everything: the tail of the current request's headers
                // (which handleRequests needs to find the blank line) and any
                // following request that arrived in the same read. Discarding
                // either made the browser's polls disappear.
                rxBuf += s
                // ...but do not let it grow without limit while nodes keep
                // pushing; fall back to the most recent request.
                if (rxBuf.length > 1024) {
                    let keep = lastIdx(rxBuf, "+IPD,")
                    rxBuf = keep > 0 ? rxBuf.substr(keep) : rxBuf.substr(rxBuf.length - 512)
                }
            }
            else if (input.runningTime() - lastData > idleMs) return
            basic.pause(5)
        }
    }

    // A browser that vanished leaves a half-open socket holding a slot. Re-fires
    // every idle period until traffic resumes.
    function idleWatchdog() {
        if (input.runningTime() - lastRequestTime > IDLE_RECOVER_MS) {
            sendAtCmd("AT+CIPCLOSE=5")       // link id 5 = all connections
            waitAt("CLOSED", "OK", "ERROR", 1000)
            lastRequestTime = input.runningTime()
        }
    }

    function buildPage() {
        if (pageSegs.length == 0) {
            pageSegs = [
                "<!DOCTYPE html><html lang=\"de\"><head>",
                "<meta charset=\"utf-8\">",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
                "<title>Calliope mini WLAN-Log</title><style>",
                "body{font-family:\"Roboto\",\"Helvetica Now\",Helvetica,Arial,sans-serif;margin:0;color:#222}",
                ".header-strip{height:10px;background:#bbef53}",
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
                "#status{color:#888;font-size:13px;margin:.6em 0}",
                // The waiting state is what the user stares at, so make it
                // readable and visibly alive. Three dots fade in turn, animated
                // in CSS -- nothing is added to the 2 s poll and it keeps moving
                // even while a request is in flight.
                //
                // Opacity on three spans, NOT an animated content: property --
                // animating content is not supported everywhere and would simply
                // show no dots at all on the browsers that skip it.
                "#status.wait{color:#5a7a10;font-size:16px;font-weight:700}",
                "#status .d{animation:b 1.2s infinite}",
                "#status .d:nth-child(2){animation-delay:.2s}",
                "#status .d:nth-child(3){animation-delay:.4s}",
                "@keyframes b{0%,60%,100%{opacity:.2}30%{opacity:1}}",
                "#full{display:none;color:#c00;font-weight:700;font-size:13px;margin:.3em 0}",
                "#charts{display:flex;flex-wrap:wrap;gap:1em;margin-top:1em}",
                ".chart{border:1px solid #eee;border-radius:6px;width:420px;max-width:100%}",
                "button{cursor:pointer;border-radius:23px;min-height:40px;font-weight:700;font-size:14px;padding:0 18px;border:none;background:#bbef53;color:#233;margin:.5em 0}",
                "button:disabled{background:#ddd;color:#999;cursor:default}",
                ".top{display:flex;flex-wrap:wrap;gap:1em;align-items:flex-start}",
                ".card{border:1px solid #ddd;border-radius:8px;padding:.6em 1em .9em;background:#fafafa}",
                ".tablebox{flex:1 1 320px;min-width:280px;max-width:100%}",
                ".tablebox table{margin-top:.3em}",
                ".dlrow{display:flex;justify-content:flex-end}",
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
                ".switch input:checked + .slider{background:#bbef53}",
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
                // The waiting indicator lives here, where the eye already is --
                // next to the values -- rather than far below the charts.
                "<div id=\"status\" class=\"wait\">warte auf Daten<span class=\"d\">.</span><span class=\"d\">.</span><span class=\"d\">.</span></div>",
                // Button right-aligned inside the card.
                "<div class=\"dlrow\"><button id=\"dl\" onclick=\"dlCsv()\">Als CSV herunterladen</button></div>",
                "</div>",
                "<section id=\"ctrls\" class=\"card\"><h2>Steuerung</h2>",
                "<div class=\"row\"><span class=\"lbl\">Schalter A</span><label class=\"switch\"><input type=\"checkbox\" id=\"tA\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Schalter B</span><label class=\"switch\"><input type=\"checkbox\" id=\"tB\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Schalter C</span><label class=\"switch\"><input type=\"checkbox\" id=\"tC\"><span class=\"slider\"></span></label></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler A</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sA\"><span id=\"sAv\" class=\"val\">0</span></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler B</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sB\"><span id=\"sBv\" class=\"val\">0</span></div>",
                "<div class=\"row\"><span class=\"lbl\">Regler C</span><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sC\"><span id=\"sCv\" class=\"val\">0</span></div>",
                "</section></div>",
                "<div id=\"charts\"></div></main>",
                "<footer>Aktualisiert sich alle 2&nbsp;s &middot; live vom WLAN-Modul</footer>",
                "<script>",
                "var s=document.getElementById('status'),tbl=document.getElementById('t'),",
                "lu=document.getElementById('last'),charts=document.getElementById('charts'),",
                "full=document.getElementById('full'),pk=document.getElementById('pkts');",
                "var WAIT='warte auf Daten<span class=\"d\">.</span><span class=\"d\">.</span><span class=\"d\">.</span>';",
                "var cols=[],rowEls=[],rows=[],offset=-1;",
                "var inflight=false,ctrlReady=false,downloading=false;",
                // Multi-node: when the data has a "node" column, each row is tagged
                // with its sender and the dashboard groups by node (one chart line
                // per node). nodeIx<0 means single-source mode (original layout).
                "var nodeIx=-1,senIx=[],chB=[];",
                "var PAL=['#8bc220','#e8743b','#19a979','#945ecf','#cc3c5d','#d39c00'];",
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
                "async function dlCsv(){if(downloading)return;downloading=true;",
                // Grey the button while the log is gathered, and keep it greyed
                // for at least 5 s so a click always gives visible feedback even
                // when the download finishes almost instantly.
                "var B=document.getElementById('dl'),t0=Date.now();",
                "if(B){B.disabled=true;B.textContent='sammle Daten...';}",
                "s.textContent='lade CSV...';",
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},30000);try{",
                "while(inflight)await new Promise(function(r){setTimeout(r,50);});",
                "var resp=await fetch('/log.csv',{cache:'no-store',signal:ac.signal});",
                "var t=await resp.text();",
                "var a=document.createElement('a');a.download='calliope-log.csv';",
                "a.href=URL.createObjectURL(new Blob([t.replace(/,/g,';')],{type:'text/csv'}));a.click();",
                "s.textContent='CSV geladen';",
                "}catch(e){s.textContent='CSV-Download fehlgeschlagen';}",
                "finally{clearTimeout(tmo);",
                "var wait=5000-(Date.now()-t0);if(wait<0)wait=0;",
                "setTimeout(function(){if(B){B.disabled=false;B.textContent='Als CSV herunterladen';}downloading=false;},wait);",
                "}}",
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
                "s+='<polyline fill=\"none\" stroke=\"#8bc220\" stroke-width=\"2\" points=\"'+p+'\"/>';",
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(a.length-1)*2);",
                "s+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';",
                "s+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"9\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}",
                "return s+'</svg>';}",
                // Multi-series chart: one labelled, coloured line per node.
                "function svgM(title,series){",
                // pt (top padding) leaves room for the column title AND the node legend
                // underneath it. At pt=22 the two sat 8 px apart and read as one
                // block; 32 separates them clearly. H grows to match so the plot
                // area itself is unchanged.
                "var W=420,H=220,pl=46,pr=10,pt=32,pb=22,gw=W-pl-pr,gh=H-pt-pb,i,k;",
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
                "o+='<rect x=\"'+lx+'\" y=\"'+(pt-11)+'\" width=\"9\" height=\"9\" fill=\"'+series[k].c+'\"/>';",
                "o+='<text x=\"'+(lx+12)+'\" y=\"'+(pt-3)+'\" fill=\"#555\" font-family=\"sans-serif\" font-size=\"10\">'+series[k].n+'</text>';",
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
                "if(!rows.length){s.className='wait';s.innerHTML=WAIT;return;}",
                "if(nodeIx>=0){renderN();}else{",
                "var d=rows.slice(-100),last=d[d.length-1],ci;",
                "for(ci=0;ci<cols.length;ci++){if(!rowEls[ci])continue;",
                "rowEls[ci].v.textContent=last[ci]!==undefined?last[ci]:'';",
                "var arr=[],di;for(di=0;di<d.length;di++){var f=parseFloat(d[di][ci]);arr.push(isNaN(f)?0:f);}",
                "rowEls[ci].b.innerHTML=svg(cols[ci],arr);}}",
                // One line only: "Letzte Aktualisierung: <time>" already says the
                // page is live, so the separate "aktualisiert" status was a
                // second line saying the same thing.
                "lu.textContent='Letzte Aktualisierung: '+new Date().toLocaleTimeString();",
                "s.className='';s.textContent='';",
                "}catch(e){s.className='wait';s.innerHTML=WAIT;}",
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

    function controlsJson(): string {
        return "{\"tA\":" + (ctrlToggle[0] ? "1" : "0") +
            ",\"tB\":" + (ctrlToggle[1] ? "1" : "0") +
            ",\"tC\":" + (ctrlToggle[2] ? "1" : "0") +
            ",\"sA\":" + ctrlSlider[0] +
            ",\"sB\":" + ctrlSlider[1] +
            ",\"sC\":" + ctrlSlider[2] + "}"
    }

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

    function syncTimeFromQuery(path: string) {
        let t = parseQueryInt(path, "t")
        if (t > 0) {
            syncedEpochSec = t
            syncedDeviceMs = input.runningTime()
            timeSynced = true
        }
    }

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

    // Send a prebuilt response in <=CHUNK pieces.
    function serveResponse(linkId: string, response: string) {
        let i = 0
        while (i < response.length) {
            if (!sendChunk(linkId, response.substr(i, CHUNK))) return
            i += CHUNK
            basic.pause(20)
        }
        if (!peerClosed) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAt("OK", "ERROR", "CLOSED", 500)
        }
    }

    function clampPct(s: string): number {
        let n = Math.round(parseFloat(s))
        if (isNaN(n)) return 0
        return Math.max(0, Math.min(100, n))
    }

    // ==================================================================
    // AT plumbing
    // ==================================================================

    // pxt's String has indexOf but NOT lastIndexOf, so scan forward for the last
    // occurrence. Returns -1 if absent.
    function lastIdx(hay: string, needle: string): number {
        let found = -1
        let from = 0
        while (true) {
            let i = hay.indexOf(needle, from)
            if (i < 0) return found
            found = i
            from = i + 1
        }
    }

    function dec(s: string): string {
        let out = ""
        let i = 0
        while (i < s.length) {
            let c = s.charAt(i)
            if (c == "+") { out += " "; i++ }
            else if (c == "%" && i + 2 < s.length) {
                out += String.fromCharCode(hexVal(s.charAt(i + 1)) * 16 + hexVal(s.charAt(i + 2)))
                i += 3
            } else { out += c; i++ }
        }
        return out
    }

    function hexVal(c: string): number {
        let n = c.charCodeAt(0)
        if (n >= 48 && n <= 57) return n - 48
        if (n >= 97 && n <= 102) return n - 87
        if (n >= 65 && n <= 70) return n - 55
        return 0
    }

    function sendAtCmd(cmd: string) {
        serial.writeString(cmd + "\u000D\u000A")
        // Not logged here: softSerial bit-bangs at 4800 baud and busy-waits, so
        // printing now would block ~100 ms while the module's reply arrives and
        // overruns the RX buffer. waitAt prints both once the reply is read.
        pendingCmd = cmd
    }

    function log(reply: string) {
        if (!debugLIVE) return
        if (pendingCmd.length > 0) {
            softSerial.writeLine(debugLIVEPIN, debugLIVEBAUD, ">>" + pendingCmd)
            pendingCmd = ""
        }
        softSerial.writeLine(debugLIVEPIN, debugLIVEBAUD, "<<" + flatten(reply))
    }

    function note(msg: string) {
        if (!debugLIVE) return
        softSerial.writeLine(debugLIVEPIN, debugLIVEBAUD, msg)
    }

    function flatten(s: string): string {
        let out = ""
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i)
            if (c == "\r" || c == "\n") out += " "
            else out += c
        }
        return out
    }

    function waitAt(t1: string, t2: string, t3: string, timeout: number) {
        let buffer = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < timeout) {
            buffer += serial.readString()
            if (buffer.includes(t1)) { finishWait(buffer); return 1 }
            if (buffer.includes(t2)) { finishWait(buffer); return 2 }
            if (buffer.includes(t3)) { finishWait(buffer); return 3 }
            basic.pause(100)
        }
        finishWait(buffer + " [TIMEOUT]")
        return 0
    }

    // Log the exchange, but FIRST rescue anything in it that was not an AT reply
    // at all.
    //
    // The module reuses link ids the instant a socket closes, so the browser's
    // next request routinely lands inside the reply to our AT+CIPCLOSE. waitAt
    // keeps its buffer locally and drops it on return, which destroyed that
    // request -- the page then never loaded, because every retry was eaten the
    // same way. Anything from "+IPD," onward is pushed back for handleRequests.
    function finishWait(buffer: string) {
        lastReply = buffer
        let i = buffer.indexOf("+IPD,")
        if (i >= 0) {
            rxBuf += buffer.substr(i)
            // Bound it. While a page is being sent, nodes keep pushing and each
            // CIPSEND's wait rescues whatever is in flight -- unbounded, that
            // grew faster than requests could be served and the page never
            // finished. Requests are small and idempotent (each push just
            // overwrites that node's slot), so dropping the oldest costs at most
            // one stale reading.
            if (rxBuf.length > 1024) {
                let keep = lastIdx(rxBuf, "+IPD,")
                rxBuf = keep > 0 ? rxBuf.substr(keep) : ""
            }
        }
        log(buffer)
    }
}
