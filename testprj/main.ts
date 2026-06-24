// Calliope mini WiFi "sensor hub" test program.
//
// Brings the WiFi module up as its own access point and serves a live page at
// http://192.168.4.1 showing this mini's sensor readings. Join the WiFi
// "CalliopeHub" (open network) and open that address in a browser.
//
// The driver lives in wifi.ts (namespace WiFi).

// Heartbeat: confirms the program is actually running (rules out a startup fault).
basic.showIcon(IconNames.Heart)
basic.pause(500)

// 1) Start the access point + web server. From here on, browser requests are
//    served automatically in the background -- no "forever" loop needed.
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

// 2) Keep this mini's own sensor readings up to date. The web page shows
//    whatever is in the table; the background server serves it on its own.
basic.forever(() => {
    WiFi.setSensorValue("hub.temperature", input.temperature())
    WiFi.setSensorValue("hub.light", input.lightLevel())
    WiFi.setSensorValue("hub.sound", input.soundLevel())
    basic.pause(1000)
})

// React to the web dashboard controls (set from the browser, read here).
basic.forever(() => {
    // Slider 1 (0-100) -> LED display brightness (0-255).
    led.setBrightness(WiFi.slider1() * 255 / 100)
    // Toggle 1 lights the centre LED.
    if (WiFi.toggle1()) {
        led.plot(2, 2)
    } else {
        led.unplot(2, 2)
    }
    // Also available: WiFi.toggle2() (boolean) and WiFi.slider2() (0-100).
    basic.pause(200)
})

// Press button A to stop the access point (and the background server).
input.onButtonPressed(Button.A, function () {
    WiFi.stopAccessPoint()
    basic.showIcon(IconNames.No)
})

// To also show readings from other minis over radio, add the "radio" package
// to pxt.json dependencies and:
//   radio.setGroup(1)
//   radio.onReceivedValue((name, value) => WiFi.setSensorValue("radio." + name, value))
