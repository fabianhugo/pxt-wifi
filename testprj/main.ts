// Calliope mini WiFi "sensor hub" test program.
//
// The DATALOGGER is the single source of data: this program logs sensor rows
// with datalogger.log(...), and the WiFi dashboard reads them back (getRows)
// and serves them at http://1.1.1.1. Join the WiFi "CalliopeHub" (open).
//
// The driver lives in wifi.ts (namespace WiFi).

// Heartbeat: confirms the program is actually running (rules out a startup fault).
basic.showIcon(IconNames.Heart)
basic.pause(500)

// 1) Set up the log columns, then start the access point + web server.
datalogger.deleteLog()
datalogger.setColumnTitles("temp", "light", "sound")
WiFi.startAccessPoint(
    SerialPin.C17,                 // TX to the module
    SerialPin.C16,                 // RX from the module
    BaudRate.BaudRate115200,
    "CalliopeHub",                 // network name
    ""                             // empty password = open network
)
// Yes = AP is really up; No = module didn't respond / setup failed.
if (WiFi.accessPointOK()) {
    basic.showIcon(IconNames.Yes)
} else {
    basic.showIcon(IconNames.No)
}

// 2) Log a row of sensor readings every 2 s. The dashboard shows whatever is
//    logged; the background server serves it on its own.
basic.forever(() => {
    datalogger.log(
        datalogger.createCV("temp", input.temperature()),
        datalogger.createCV("light", input.lightLevel()),
        datalogger.createCV("sound", input.soundLevel())
    )
    basic.pause(2000)
})

// React to the web dashboard controls (set from the browser, read here).
basic.forever(() => {
    // Slider A (0-100) -> LED display brightness (0-255).
    led.setBrightness(WiFi.slider(WebControl.A) * 255 / 100)
    // Toggle A lights the centre LED.
    if (WiFi.toggle(WebControl.A)) {
        led.plot(2, 2)
    } else {
        led.unplot(2, 2)
    }
    // Pick B or C in the dropdown: WiFi.toggle(WebControl.B), WiFi.slider(WebControl.C), ...
    basic.pause(200)
})

// Press button A to stop the access point (and the background server).
input.onButtonPressed(Button.A, function () {
    WiFi.stopAccessPoint()
    basic.showIcon(IconNames.No)
})

// To also log readings from other minis over radio, add the "radio" package
// to pxt.json dependencies and log them into the same row, e.g.:
//   radio.onReceivedValue((name, value) => datalogger.log(datalogger.createCV(name, value)))
