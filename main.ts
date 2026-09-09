enum MessageType {
    UDP,
    TCP
}
/**
 * Functions to operate Grove module.
 */
//% weight=10 color=#9F79EE icon="\uf1b3" block="WiFi"
//% groups='["Connection", "Adafruit IO", "ThingSpeak", "IFTTT", "Thingsboard"]'
namespace WiFi {
    /**
     * 
     */

    let isWifiConnected = false;
    let wifiBaudRate = BaudRate.BaudRate115200;

    // Every block below drives the one shared UART to the ESP32. loops.everyInterval
    // runs its body in a separate fiber, so two blocks can otherwise interleave their
    // AT commands mid-exchange and each read the other's replies.
    let busy = false

    function acquire() {
        while (busy) basic.pause(10)
        busy = true
    }

    function release() {
        busy = false
    }
    /**
     * Setup Grove - Uart WiFi V2 to connect to  Wi-Fi
     */
    //% block="Setup Wifi|TX %txPin|RX %rxPin|Baud rate %baudrate|SSID = %ssid|Password = %passwd"
    //% txPin.defl=SerialPin.C17
    //% rxPin.defl=SerialPin.C16
    //% baudRate.defl=BaudRate.BaudRate115200
    //% group="Connection"
    //% weight=90
    export function setupWifi(txPin: SerialPin, rxPin: SerialPin, baudRate: BaudRate, ssid: string, passwd: string) {
        acquire()
        let result = 0

        isWifiConnected = false
        wifiBaudRate = baudRate

        // Start with default ESP32 baud rate (115200)
        serial.redirect(
            txPin,
            rxPin,
            BaudRate.BaudRate115200
        )

        sendAtCmd("AT")
        result = waitAtResponse("OK", "ERROR", "None", 1000)

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

        sendAtCmd(`AT+CWJAP="${ssid}","${passwd}"`)
        result = waitAtResponse("WIFI GOT IP", "ERROR", "None", 20000)

        if (result == 1) {
            isWifiConnected = true
        }
        release()
    }

    /**
     * Check if Grove - Uart WiFi V2 is connected to Wifi
     */
    //% block="Wifi OK?"
    //% weight=85
    //% group="Connection"
    export function wifiOK() {
        return isWifiConnected
    }

    /**
     * Send data to ThingSpeak
     */
    //% block="Send Data to your ThingSpeak Channel|Write API Key %apiKey|Field1 %field1|Field2 %field2||Field3 %field3|Field4 %field4|Field5 %field5|Field6 %field6|Field7 %field7|Field8 %field8"
    //% group="ThingSpeak"
    //% expandableArgumentMode="enabled"
    //% apiKey.defl="your Write API Key"
    //% weight=70
    export function sendToThingSpeak(apiKey: string, field1: number = 0, field2: number = 0, field3: number = 0, field4: number = 0, field5: number = 0, field6: number = 0, field7: number = 0, field8: number = 0) {
        acquire()
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
            result = waitSendPrompt(2000)
            if (result != 1) continue
            sendAtCmd(data)
            result = waitSendResult(5000)
            if (result == 1) break
        }
        release()
    }

    /**
     * Send data to IFTTT
     */
    //% block="Send Data to your IFTTT Event|Event %event|Key %key|value1 %value1||value2 %value2|value3 %value3"
    //% group="IFTTT"
    //% event.defl="your Event"
    //% key.defl="your Key"
    //% value1.defl="Hello"
    //% value2.defl="Calliope"
    //% value3.defl="mini"
    //% weight=65
    export function sendToIFTTT(event: string, key: string, value1: string, value2: string, value3: string) {
        acquire()
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
            result = waitSendPrompt(2000)
            if (result != 1) continue
            sendAtCmd(data)
            result = waitSendResult(5000)
            // close the TCP connection
            // sendAtCmd("AT+CIPCLOSE")
            // waitAtResponse("OK", "ERROR", "None", 2000)
            if (result == 1) break
        }
        release()
    }

    let ThingsboardAdresse = "paminasogo.ddns.net"
    let ThingsboardPort = "9090"
    /**
      * Send data to Thingsboard
      */
    //% block="Send Data to your Thingsboard Server|Token %AccessToken|Daten_1 %Daten1||Daten_2 %Daten2|Daten_3 %Daten3|Daten_4 %Daten4|Daten_5 %Daten5|Daten_6 %Daten6|Daten_7 %Daten7|Daten_8 %Daten8"
    //% expandableArgumentMode="enabled"
    //% AccessToken.defl="API Token(Thingsboard)"
    //% group="Thingsboard"
    //% weight=40
    export function sendToThingsboard(AccessToken: string, Daten1: number = 0.0, Daten2: number = 0.0, Daten3: number = 0.0, Daten4: number = 0.0, Daten5: number = 0.0, Daten6: number = 0.0, Daten7: number = 0.0, Daten8: number = 0.0) {
        acquire()
        let result = 0
        let retry = 2

        let data: { [key: string]: number } = {
            "Daten1": Daten1,
            "Daten2": Daten2,
            "Daten3": Daten3,
            "Daten4": Daten4,
            "Daten5": Daten5,
            "Daten6": Daten6,
            "Daten7": Daten7,
            "Daten8": Daten8
        }


        // close the previous TCP connection
        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 200) //vorher 2000
        }

        const payload = JSON.stringify(data);
        const request = `POST /api/v1/${AccessToken}/telemetry HTTP/1.1\r\n` +
            `Host: ${ThingsboardAdresse}\r\n` +
            `Content-Type: application/json\r\n` +
            `Content-Length: ${payload.length}\r\n\r\n` +
            `${payload}`;

        while (isWifiConnected && retry > 0) {
            retry = retry - 1;

            sendAtCmd(`AT+CIPSTART="TCP","${ThingsboardAdresse}",${ThingsboardPort}`);
            result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 3000)
            if (result == 3) continue

            // sendAtCmd appends CRLF, so the announced length must include those 2 bytes.
            sendAtCmd(`AT+CIPSEND=${request.length + 2}`);
            result = waitSendPrompt(2000)
            if (result != 1) continue

            sendAtCmd(request);
            result = waitSendResult(5000)
            if (result == 1) break

            // close the previous TCP connection
            if (isWifiConnected) {
                sendAtCmd("AT+CIPCLOSE")
                waitAtResponse("OK", "ERROR", "None", 200) //vorher 2000
            }


        }
        release()
    }
    /**
    * Set thingsboard adress and port
    */
    //% block="Change thingsboard Server %Serveradresse|adress %Port|port"
    //% adress.defl="paminasogo.ddns.net"
    //% port.defl="9090"
    //% weight=8
    //% group="Thingsboard"
    export function setThingsboardServer(adress: string, port: string){
    ThingsboardAdresse = adress;
    ThingsboardPort = port;
    }
    
    

    /**
     * Send a raw message via TCP or UDP
     */
    //% block="Send Message|Type %type|Server %address|Port %port|Message %message"
    //% weight=70
    //% advanced=true
    export function sendMessage(type: MessageType, address: string, port: number, message: string): void {
        acquire()
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
            result = waitSendPrompt(2000)
            if (result != 1) continue

            // Send actual message
            serial.writeString(message)
            result = waitSendResult(5000)

            // Close connection
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)

            if (result == 1) break
        }
        release()
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

    // Wait for the module to be ready to accept a payload after AT+CIPSEND. It may answer
    // with the ">" prompt or only with "OK" - this firmware does not reliably emit ">", so
    // accepting "OK" as well is required, otherwise the payload is never written at all.
    function waitSendPrompt(timeout: number) {
        let buffer = ""
        let start = input.runningTime()

        while ((input.runningTime() - start) < timeout) {
            buffer += serial.readString()

            if (buffer.includes("ERROR") || buffer.includes("SEND FAIL")) {
                debugLog(buffer)
                return 2
            }
            if (buffer.includes(">") || buffer.includes("OK")) {
                debugLog(buffer)
                return 1
            }

            basic.pause(100)
        }

        debugLog(buffer + " [TIMEOUT]")
        return 0
    }

    // After a payload is written the module does not reliably answer "SEND OK": it may
    // report "Recv <n> bytes" and then stream the server's reply as "+IPD,<n>:...".
    // Either of those means the data reached the server, so both count as success and
    // the caller must not retry - a retry posts the value a second time.
    function waitSendResult(timeout: number) {
        let buffer = ""
        let start = input.runningTime()

        while ((input.runningTime() - start) < timeout) {
            buffer += serial.readString()

            if (buffer.includes("SEND OK") || buffer.includes("+IPD") || buffer.includes("Recv")) {
                debugLog(buffer)
                return 1
            }
            if (buffer.includes("SEND FAIL") || buffer.includes("ERROR")) {
                debugLog(buffer)
                return 2
            }

            basic.pause(100)
        }

        debugLog(buffer + " [TIMEOUT]")
        return 0
    }

    // The last command sent, waiting to be printed by the debug logger.
    let pendingCmd = ""
    // Guards the bit-banged debug pin; see debugLog.
    let logBusy = false
    let debugMODE = false
    let debugTXPIN = DigitalPin.P19
    let debugBAUD = softSerial.BaudRate.Baud4800 
    
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
            while (logBusy) basic.pause(10)
            logBusy = true
            softSerial.writeLine(debugTXPIN, debugBAUD, ">>" + pendingCmd)
            pendingCmd = ""
            logBusy = false
        }
    }

    // Print ">>command" then "<<reply" once the reply is already in hand, so the
    // slow bit-banged logging can never eat the reply it is meant to show.
    //
    // Emitted as ONE writeLine, and guarded by its own lock: softSerial bit-bangs at
    // 4800 baud and busy-waits, so a ~140 char record blocks for ~300 ms. Across two
    // writeLine calls, or two fibers, the scheduler interleaves the output character by
    // character and the log becomes unreadable.
    function debugLog(reply: string) {
        if (!debugMODE) return

        while (logBusy) basic.pause(10)
        logBusy = true

        let record = ""
        if (pendingCmd.length > 0) {
            record = ">>" + pendingCmd + "\r\n"
            pendingCmd = ""
        }
        softSerial.writeLine(debugTXPIN, debugBAUD, record + "<<" + reply)

        logBusy = false
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
    //% group="Adafruit IO"
    //% weight=75
    export function adafruitIOGetValue(username: string, aioKey: string, feed: string): string {
        acquire()
        clearSerialBuffer()

        if (isWifiConnected) {
            sendAtCmd("AT+CIPCLOSE")
            waitAtResponse("OK", "ERROR", "None", 1000)
        }

        sendAtCmd("AT+CIPSTART=\"TCP\",\"io.adafruit.com\",80")
        let result = waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 3000)
        if (result == 3) { release(); return "" }

        // Built without the trailing blank line: sendAtCmd appends the CRLF that
        // terminates the headers, exactly as in adafruitIOPost, which the module accepts.
        let req =
            "GET /api/v2/" + username + "/feeds/" + feed + "/data/last HTTP/1.1\r\n" +
            "Host: io.adafruit.com\r\n" +
            "X-AIO-Key: " + aioKey + "\r\n" +
            "Connection: close\r\n"

        sendAtCmd("AT+CIPSEND=" + (req.length + 2))
        result = waitSendPrompt(2000)
        if (result != 1) { release(); return "" }

        sendAtCmd(req)

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
                    release()
                    debugLog("GET=" + found)
                    return found
                }
                // If no new data for 2 seconds, we're done
                if (buffer.length > 100 && (input.runningTime() - lastDataTime) > 2000) {
                    break
                }
            }
        }

        release()
        if (found.length > 0) { debugLog("GET=" + found); return found }

        debugLog("GET no value in " + buffer.length + " bytes")
        return ""
    }
    /**
        * Send value to an Adafruit IO feed (HTTP POST)
        */
    //% block="Adafruit IO POST|Username %username|AIO Key %aioKey|Feed %feed|Value %value"
    //% value.shadow=math_number
    //% value.defl=132
    //% group="Adafruit IO"
    //% weight=80
    export function adafruitIOPost(username: string, aioKey: string, feed: string, value: any) {
        acquire()
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

            // Drop anything left from a previous attempt (typically the tail of a "+IPD"
            // response), otherwise it is read as the answer to the command below.
            serial.readString()

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

            // sendAtCmd appends CRLF, so the announced length must include those 2 bytes.
            sendAtCmd("AT+CIPSEND=" + (data.length + 2))
            result = waitSendPrompt(2000)
            if (result != 1) continue

            sendAtCmd(data)
            result = waitSendResult(5000)
            if (result == 1) break
        }
        release()
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


}
