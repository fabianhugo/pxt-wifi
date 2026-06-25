/**
 * Calliope mini WiFi "sensor hub" test program.
 * 
 * The DATALOGGER is the single source of data: this program logs sensor rows
 * 
 * with datalogger.log(...), and the WiFi dashboard reads them back (getRows)
 * 
 * and serves them at http://1.1.1.1. Join the WiFi "CalliopeHub" (open).
 * 
 * The driver lives in wifi.ts (namespace WiFi).
 */
// radio.onReceivedValue((name, value) => datalogger.log(datalogger.createCV(name, value)))
datalogger.onLogFull(function () {
    basic.showIcon(IconNames.Asleep)
})
// Press button A to stop the access point (and the background server).
input.onButtonPressed(Button.A, function () {
    WiFi.stopAccessPoint()
    basic.showIcon(IconNames.No)
})
input.onButtonEvent(Button.AB, input.buttonEventClick(), function () {
    // 1) Set up the log columns, then start the access point + web server.
    datalogger.deleteLog()
})
// Heartbeat: confirms the program is actually running (rules out a startup fault).
basic.showIcon(IconNames.Heart)
basic.pause(500)
datalogger.setColumnTitles(
"temp",
"light",
"sound"
)
// TX to the module
// RX from the module
// network name
// empty password = open network
WiFi.startAccessPoint(
SerialPin.C17,
SerialPin.C16,
BaudRate.BaudRate115200,
"CalliopeHub",
""
)
// Yes = AP is really up; No = module didn't respond / setup failed.
if (WiFi.accessPointOK()) {
    basic.showIcon(IconNames.Yes)
} else {
    basic.showIcon(IconNames.No)
}
/**
 * To also log readings from other minis over radio, add the "radio" package
 */
// to pxt.json dependencies and log them into the same row, e.g.:
loops.everyInterval(2000, function () {
    basic.setLedColor(basic.rgb(WiFi.slider(WebControl.A), WiFi.slider(WebControl.B), WiFi.slider(WebControl.C)))
    // Toggle A lights the centre LED.
    if (WiFi.toggle(WebControl.A)) {
        led.plot(1, 2)
    } else {
        led.unplot(1, 2)
    }
    // Toggle A lights the centre LED.
    if (WiFi.toggle(WebControl.B)) {
        led.plot(2, 2)
    } else {
        led.unplot(2, 2)
    }
    // Toggle A lights the centre LED.
    if (WiFi.toggle(WebControl.C)) {
        led.plot(3, 2)
    } else {
        led.unplot(3, 2)
    }
    datalogger.log(
    datalogger.createCV("temp", input.temperature()),
    datalogger.createCV("light", input.lightLevel()),
    datalogger.createCV("sound", input.soundLevel())
    )
})
