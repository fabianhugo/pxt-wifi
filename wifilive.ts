/**
 * WiFi Live - a hub that shows the CURRENT readings of several minis on a web
 * page. No charts, no history, no log parsing, no controls.
 *
 * WHY THIS EXISTS
 *
 * The full multi-node dashboard in main.ts is ~12.7 KB and re-reads the flash
 * log on every poll to redraw its charts. At 115200 baud one page load alone
 * occupies the UART for ~1.1 s, and building that page as one string is what
 * caused the GC_TOO_BIG_ALLOCATION (error 022) crashes.
 *
 * This page is ~1.6 KB (-87%, ~0.14 s per load) because it answers a different
 * question: "what is every sensor reading right now?" That needs only the LAST
 * value per node, which is kept in RAM. The datalogger is never read to serve a
 * request, so no history, no diff cursor, no CSV, and nothing is sent from the
 * browser back to the Calliope.
 *
 * Logging to flash still happens if you want it -- see logToFlash below -- but
 * it is independent of what the page shows.
 *
 * HUB PROGRAM (one board)
 *   WiFiLive.startLiveHub(SerialPin.C17, SerialPin.C16, "CalliopeHub", "")
 *   // then open http://10.0.0.1 on a phone joined to that network
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
let debugLIVE = false
let debugLIVEPIN = DigitalPin.P2
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

    // Optional: also write each push to flash for later USB download. Off by
    // default -- the page does not need it, and it is the slow part.
    let logToFlash = false

    // ---- node side ----
    let joined = false
    let hubHost = AP_IP
    let pushStage = 0

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
     * Start the live hub: make the WiFi network the other minis join, and serve
     * a page showing their current readings.
     */
    //% block="start live hub|TX %tx|RX %rx|network name %name|password %pass"
    //% tx.defl=SerialPin.C17
    //% rx.defl=SerialPin.C16
    //% name.defl="CalliopeHub"
    //% group="Hub"
    //% weight=100
    export function startLiveHub(tx: SerialPin, rx: SerialPin, name: string, pass: string) {
        txPin = tx
        rxPin = rx
        ssid = name
        passwd = pass
        nodeNames = []
        nodeData = []
        nodeSeen = []
        pushCount = 0

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
        let ok = pushQuery(q)
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
        if (path.indexOf("/p") == 0) {
            // A node pushed readings. Nodes never read the reply -- they close
            // as soon as their own module reports SEND OK -- so do not send one.
            ingest(path)
        } else if (path.indexOf("/live") == 0) {
            serveText(linkId, liveBody())
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

    // The page is sent as small pieces and never assembled into one string, so
    // no single large allocation is ever needed (error 022).
    function servePage(linkId: string) {
        let segs = pageSegments()
        let total = 0
        for (let i = 0; i < segs.length; i++) total += segs[i].length

        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: " + total + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n\r\n"
        // Pack the segments into a few ~512 B packets instead of sending all 35
        // individually. Every CIPSEND is a round trip during which node pushes
        // keep arriving, so 35 of them stretched one page load long enough that
        // the phone gave up ("warte auf Daten"). Four packets is ~9x less
        // exposure. The pieces are still small enough that no single large
        // allocation is needed.
        if (!sendChunk(linkId, head)) return
        let packet = ""
        for (let i = 0; i < segs.length; i++) {
            if (packet.length > 0 && packet.length + segs[i].length > 512) {
                if (!sendChunk(linkId, packet)) return
                packet = ""
                basic.pause(20)              // breather so we don't overrun
            }
            packet += segs[i]
        }
        if (packet.length > 0 && !sendChunk(linkId, packet)) return
        // As in serveText: skip the close if the browser already hung up.
        if (!peerClosed) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAt("OK", "ERROR", "CLOSED", 500)
        }
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

    // The page. Only the latest values, so there is no chart code, no history
    // buffer, no CSV and nothing sent back to the Calliope.
    function pageSegments(): string[] {
        return [
            "<!DOCTYPE html><html lang=\"de\"><head><meta charset=\"utf-8\">",
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
            "<title>Calliope Live</title><style>",
            "body{font-family:system-ui,sans-serif;margin:0;color:#222;background:#fafafa}",
            "header{background:#42c9c9;color:#fff;padding:.6em 1em}",
            "h1{font-size:1.2em;margin:0}",
            "main{margin:1em}",
            "table{border-collapse:collapse;width:100%;background:#fff}",
            "th,td{border:1px solid #ddd;padding:.5em .6em;text-align:left}",
            "th{background:#f3f3f3}",
            "td.v{text-align:right;font-variant-numeric:tabular-nums}",
            "#s{color:#888;font-size:13px;margin-top:.6em}",
            "</style></head><body>",
            "<header><h1>Calliope Live</h1></header>",
            "<main><table id=\"t\"></table><div id=\"s\">warte auf Daten...</div></main>",
            "<script>",
            "var T=document.getElementById(\"t\"),S=document.getElementById(\"s\");",
            "async function u(){",
            "try{",
            "var r=await fetch(\"/live\",{cache:\"no-store\"});",
            "var d=await r.text();",
            "var L=d.split(\"\\n\"),h=\"<tr><th>Knoten</th>\",c=[],i,j;",
            "for(i=0;i<L.length;i++){if(!L[i])continue;c.push(L[i].split(\",\"));}",
            "if(!c.length){S.textContent=\"keine Daten\";return;}",
            "var keys=[];",
            "for(i=0;i<c.length;i++)for(j=1;j<c[i].length;j++){var k=c[i][j].split(\"=\")[0];if(keys.indexOf(k)<0)keys.push(k);}",
            "for(j=0;j<keys.length;j++)h+=\"<th>\"+keys[j]+\"</th>\";",
            "h+=\"</tr>\";",
            "for(i=0;i<c.length;i++){h+=\"<tr><td>\"+c[i][0]+\"</td>\";",
            "for(j=0;j<keys.length;j++){var v=\"\";for(var m=1;m<c[i].length;m++){var kv=c[i][m].split(\"=\");if(kv[0]==keys[j])v=kv[1];}",
            "h+=\"<td class=v>\"+v+\"</td>\";}h+=\"</tr>\";}",
            "T.innerHTML=h;S.textContent=\"aktualisiert \"+new Date().toLocaleTimeString();",
            "}catch(e){S.textContent=\"keine Verbindung\";}}",
            "setInterval(u,2000);u();",
            "</script></body></html>"
        ]
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
