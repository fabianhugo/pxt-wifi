/**
 * Software serial (bit-banged UART) for micro:bit v2 — extra serial ports on
 * arbitrary pins, leaving the built-in `serial` untouched. Several pins can be
 * in use at once. Format: 8N1, LSB first, idle-high, non-inverted (3.3V TTL).
 *
 * RX is interrupt-driven via `pins.onPulsed`, which CODAL times in an interrupt
 * handler, so the CPU is idle between edges — there is no polling loop. TX
 * busy-waits (unavoidable when bit-banging) with every deadline measured from
 * the start edge, so a frame can be delayed but never compressed.
 */
//% weight=100 color=#2b8a3e icon="" block="Soft Serial"
//% groups='["Ports", "Sending", "Receiving", "Checksum", "Diagnostics"]'
namespace softSerial {

    // ---------------------------------------------------------------- config

    export enum BaudRate {
        //% block="1200"
        Baud1200 = 1200,
        //% block="2400"
        Baud2400 = 2400,
        //% block="4800"
        Baud4800 = 4800,
        //% block="9600"
        Baud9600 = 9600,
        //% block="19200"
        Baud19200 = 19200,
    }

    const DATA_BITS = 8;

    // Extra idle time held after the stop bit, in 1/4 bit cells. This is the
    // guard band that absorbs inter-byte jitter; see writeByte() for why a
    // stop bit with no margin corrupts the *following* byte.
    const STOP_MARGIN_QUARTERS = 2;

    // control.micros() is masked to 30 bits by the runtime and wraps ~18 min.
    const MICROS_MASK = 0x3fffffff;

    /** Size of each port's RX ring buffer, in bytes. Must be a power of two. */
    const RX_BUFFER_SIZE = 128;


    function elapsed(since: number): number {
        return (control.micros() - since) & MICROS_MASK;
    }

    // ------------------------------------------------------------------ port

    /**
     * Give the scheduler a chance to run between transmitted frames.
     *
     * A frame itself must be sent without yielding — its bit timing is
     * busy-waited. But between frames the CPU must be released, because
     * received pulse events are queued by CODAL and drained by the idle fiber
     * (MessageBus::idle). The queue is only 10 deep, so blocking it for more
     * than about ten bit cells loses incoming data. Sending a whole string
     * without yielding blocks it for milliseconds and silently drops whatever
     * arrives meanwhile.
     *
     * basic.pause(0) yields to the scheduler without adding a real delay, so
     * the inter-byte gap stays close to the guard band writeByte already holds.
     */
    function yieldBetweenFrames(): void {
        basic.pause(0);
    }

    /**
     * One software serial port. Each instance owns its own pins, baud rate and
     * receive buffer, so several can run side by side.
     */
    export class SoftSerialPort {
        private txPin: DigitalPin;
        private rxPin: DigitalPin;

        private bitMicros: number;      // nominal bit cell, µs
        // Bit period in 1/256 µs. At 9600 baud a cell is 104.1667 µs, and
        // truncating to 104 loses 1.7 µs over a frame. Eight fractional bits
        // make each edge deadline exact to well under a microsecond.
        private bitMicros256: number;

        private rxBuf: Buffer;
        private rxHead: number;
        private rxTail: number;
        private rxOverflows: number;
        private rxFramingErrors: number;

        // RX decoder state. See onRun() for the protocol.
        private rxBitsSeen: number;
        private rxShift: number;
        // Wall-clock time at which the current frame's data bits completed.
        // Only meaningful once rxBitsSeen reaches DATA_BITS + 1; used to decide
        // when a frame whose stop bit was never reported can be completed.
        private rxDataDoneAt: number;

        // Set while a frame is being transmitted. RX events are dropped during
        // this window (half duplex) so they cannot preempt the TX bit timing.
        private txActive: boolean;
        // Scratch buffer for the frame being sent; reused so TX never allocates.
        private txLevels: number[];
        private txGlitches: number;

        // A port is either transmit-only or receive-only; the unused pin is
        // NO_PIN and is never touched.
        private isTx: boolean;

        constructor(tx: DigitalPin, rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800) {
            this.txPin = tx;
            this.rxPin = rx;
            this.isTx = (tx as number) >= 0;
            this.bitMicros = Math.idiv(1000000, baud as number);
            this.bitMicros256 = Math.idiv(256000000, baud as number);

            this.rxBuf = control.createBuffer(RX_BUFFER_SIZE);
            this.rxHead = 0;
            this.rxTail = 0;
            this.rxOverflows = 0;
            this.rxFramingErrors = 0;
            this.rxBitsSeen = 0;
            this.rxShift = 0;
            this.rxDataDoneAt = 0;

            this.txActive = false;
            this.txLevels = [0, 0, 0, 0, 0, 0, 0, 0, 0];
            this.txGlitches = 0;

            if (this.isTx) {
                // Idle state of a non-inverted UART line is high. Drive TX high
                // before anything else so we never emit a spurious start bit.
                pins.digitalWritePin(this.txPin, 1);
            } else {
                // Hold RX high when nothing drives it, so an unplugged cable
                // reads as idle rather than as a stream of start bits.
                pins.setPull(this.rxPin, PinPullMode.PullUp);

                // CODAL times both polarities once ON_PULSE is enabled.
                // Handlers are registered per (pin, polarity), so ports on
                // different pins do not interfere with each other.
                //
                // WARNING: never call pins.digitalReadPin() on this pin after
                // this point. NRF52Pin::getDigitalValue() calls disconnect()
                // for a pin that is not already in IO_STATUS_DIGITAL_IN, which
                // clears IO_STATUS_EVENT_PULSE_ON_EDGE and silently ends all
                // reception on this pin.
                // Handlers MUST be queued, not immediate. Registering them as
                // MESSAGE_BUS_LISTENER_IMMEDIATE runs them in interrupt
                // context, and the pxt runtime refuses to execute TypeScript
                // there: invoking any closure calls pushThreadContext(), which
                // panics with PANIC_CALLED_FROM_ISR (914) when PXT_IN_ISR().
                // See gc.cpp:161 and gc.cpp:741.
                pins.onPulsed(this.rxPin, PulseValue.Low,
                    () => this.onRun(0, pins.pulseDuration()));
                pins.onPulsed(this.rxPin, PulseValue.High,
                    () => this.onRun(1, pins.pulseDuration()));
            }
        }

        // ---------------------------------------------------------------- RX

        /**
         * Handle one completed run of constant level on the RX line. A UART
         * frame is a run-length encoding of alternating levels, so the bits are
         * rebuilt without ever sampling the pin: a run of `level` lasting
         * `micros` is round(micros / bitMicros) consecutive bits of it.
         */
        private onRun(level: number, micros: number): void {
            if (micros <= 0) return;
            // Our own transmission is not incoming data, and servicing it here
            // would steal time from the TX bit loop.
            if (this.txActive) return;

            // Rounding to nearest absorbs interrupt-latency jitter.
            let bits = Math.idiv(micros + (this.bitMicros >> 1), this.bitMicros);
            if (bits <= 0) bits = 1;

            if (this.rxBitsSeen == 0) {
                // Idle. Only a low run can begin a frame — the start bit.
                if (level != 0) return;
                this.rxBitsSeen = 1;
                this.rxShift = 0;
                bits -= 1;
                if (bits <= 0) return;
                // A start bit longer than one cell means the first data bits
                // are also 0; shift them in.
                this.pushBits(0, bits);
                return;
            }

            this.pushBits(level, bits);
        }

        /** Shift `count` bits of `level` in, emitting the frame when complete. */
        private pushBits(level: number, count: number): void {
            while (count > 0 && this.rxBitsSeen > 0) {
                if (this.rxBitsSeen <= DATA_BITS) {
                    // Data bits, LSB first.
                    if (level) this.rxShift |= (1 << (this.rxBitsSeen - 1));
                    this.rxBitsSeen++;
                    if (this.rxBitsSeen == DATA_BITS + 1) {
                        // Data complete; only the stop bit is outstanding. Note
                        // when we got here so flushPending() can decide the stop
                        // bit is never going to be reported.
                        this.rxDataDoneAt = control.micros();
                    }
                } else {
                    // Stop bit; must be high on a valid frame.
                    if (level) {
                        this.rxPush(this.rxShift & 0xff);
                    } else {
                        this.rxFramingErrors++;
                    }
                    this.rxBitsSeen = 0;
                    this.rxShift = 0;
                    // Adjacent low runs are indistinguishable in a run-length
                    // view, so resynchronise on the next run.
                    return;
                }
                count--;
            }
        }

        private rxPush(b: number): void {
            const next = (this.rxHead + 1) & (RX_BUFFER_SIZE - 1);
            if (next == this.rxTail) {
                // Full: drop the newest rather than overwrite unread data.
                this.rxOverflows++;
                return;
            }
            this.rxBuf.setUint8(this.rxHead, b);
            this.rxHead = next;
        }

        /**
         * Complete a frame whose data bits are all in but whose stop bit has
         * not been reported yet.
         *
         * `onPulsed` reports a run only once it ENDS, and the stop bit of the
         * last byte in a burst is a high run that merges into the idle line —
         * it does not end until the *next* message pulls the line low. Without
         * this, the final byte of every message (the "\n") would sit in the
         * decoder until more data arrived, delivering every message one late.
         *
         * Once all eight data bits are in, the byte is fully determined: the
         * only thing still outstanding is the stop bit, and the line having
         * stayed idle-high past its deadline is exactly what a valid stop bit
         * looks like. So after one full frame time of silence we complete it.
         */
        private flushPending(): void {
            if (this.rxBitsSeen != DATA_BITS + 1) return;
            // One whole frame of idle is unambiguous: a real stop bit is one
            // cell, so anything beyond that cannot be part of this frame.
            // Wait a couple of frame times before concluding the stop bit will
            // never arrive. This is measured from when the data bits completed,
            // which is a real point in time, unlike the spacing between two
            // handler invocations: pulse events are QUEUED by CODAL and
            // dispatched in bursts, so consecutive handler calls can be
            // microseconds apart while the edges themselves were a bit cell
            // apart. Timing the line by when handlers happen to run is wrong.
            if (elapsed(this.rxDataDoneAt) < this.bitMicros * 2 * (DATA_BITS + 2)) {
                return;
            }
            // NB: do NOT sample the pin to confirm it is idle-high here.
            // NRF52Pin::getDigitalValue() only has a fast path for pins already
            // in IO_STATUS_DIGITAL_IN; a pin armed for pulse events is not, so
            // it calls disconnect(), which clears the GPIO SENSE interrupt and
            // wipes IO_STATUS_EVENT_PULSE_ON_EDGE. That permanently kills every
            // further onPulsed event on this pin — one message would arrive and
            // then reception would stop dead.
            //
            // The timeout is sufficient evidence on its own: if the line had
            // gone low instead, that run would have been reported and advanced
            // the frame, so rxBitsSeen would no longer be sitting at
            // DATA_BITS + 1 and we would not be here.
            this.rxPush(this.rxShift & 0xff);
            this.rxBitsSeen = 0;
            this.rxShift = 0;
        }

        /** Number of bytes waiting in the receive buffer. */
        public available(): number {
            this.flushPending();
            return (this.rxHead - this.rxTail) & (RX_BUFFER_SIZE - 1);
        }

        /** Read one byte, or -1 if none is waiting. */
        public readByte(): number {
            if (this.rxHead == this.rxTail) this.flushPending();
            if (this.rxHead == this.rxTail) return -1;
            const b = this.rxBuf.getUint8(this.rxTail);
            this.rxTail = (this.rxTail + 1) & (RX_BUFFER_SIZE - 1);
            return b;
        }

        /** Read everything currently buffered as a string. */
        public readString(): string {
            // Flush first so a byte still waiting on its stop bit is included
            // in *this* call rather than surfacing in the next one.
            this.flushPending();
            let s = "";
            while (true) {
                const b = this.readByte();
                if (b < 0) break;
                s += String.fromCharCode(b);
            }
            return s;
        }

        /**
         * Read up to and including `delimiter`, or "" if no complete line has
         * arrived. A partial line stays buffered for the next call.
         */
        public readUntil(delimiter: string): string {
            if (!delimiter || delimiter.length == 0) return "";
            this.flushPending();
            const d = delimiter.charCodeAt(0);

            // Look ahead without consuming, so a partial line is preserved.
            let i = this.rxTail;
            let found = false;
            while (i != this.rxHead) {
                if (this.rxBuf.getUint8(i) == d) { found = true; break; }
                i = (i + 1) & (RX_BUFFER_SIZE - 1);
            }
            if (!found) return "";

            let s = "";
            while (true) {
                const b = this.readByte();
                if (b < 0) break;
                s += String.fromCharCode(b);
                if (b == d) break;
            }
            return s;
        }

        // ---------------------------------------------------------------- TX

        /**
         * Send one byte.
         *
         * The frame clock is anchored to the start edge itself. Timestamping
         * before driving the edge would let an interrupt land in between: the
         * edge would be late while every later deadline stayed absolute, so the
         * frame would be compressed and the stop bit — last in the frame —
         * would absorb the squeeze. A stop bit short by a full cell makes the
         * receiver open its next frame one cell early, delivering
         * (byte >> 1) | 0x80. Anchoring to the edge means a frame can only ever
         * be delayed as a whole, never compressed.
         */
        public writeByte(value: number): void {
            if (!this.isTx) return;
            // Precompute levels before touching the pin; doing this between
            // two edges would risk the bit-cell budget. Index 0 (the start bit)
            // is driven directly below.
            for (let i = 0; i < DATA_BITS; i++) {
                this.txLevels[1 + i] = (value >> i) & 1;    // data, LSB first
            }
            this.txLevels[DATA_BITS + 1] = 1;               // stop bit

            // RX handlers run in interrupt context and would preempt this
            // frame between two edges. Interrupts cannot be masked from
            // TypeScript, so RX ignores the line instead (half duplex).
            this.txActive = true;

            pins.digitalWritePin(this.txPin, 0);            // start bit
            const frameStart = control.micros();

            let slipped = false;
            for (let b = 1; b < DATA_BITS + 2; b++) {
                if (this.waitUntilBit(frameStart, b)) slipped = true;
                pins.digitalWritePin(this.txPin, this.txLevels[b]);
            }

            // Hold the stop bit for its cell plus a guard band. The stop bit
            // has no edge of its own to defend it — it ends when the next start
            // bit begins — so the guard band makes inter-byte jitter eat the
            // idle gap instead of the stop bit.
            this.waitUntilStop(frameStart);

            if (slipped) this.txGlitches++;

            this.txActive = false;
            // Discard anything latched mid-frame.
            this.rxBitsSeen = 0;
            this.rxShift = 0;
        }

        /**
         * Busy-wait until `bitIndex` cells have elapsed since the start edge.
         * Returns true if the deadline was already missed by more than half a
         * cell, meaning the peer may have seen a corrupted byte.
         */
        private waitUntilBit(frameStart: number, bitIndex: number): boolean {
            const target = (bitIndex * this.bitMicros256) >> 8;
            while (true) {
                const remaining = target - elapsed(frameStart);
                if (remaining <= 0) return remaining < -(this.bitMicros >> 1);
                // waitMicros busy-waits on hardware (no yield). Capping each
                // call limits overshoot; re-reading the clock is nearly free.
                control.waitMicros(remaining > 64 ? 64 : remaining);
            }
        }

        /** Busy-wait until the stop bit and its guard band have elapsed. */
        private waitUntilStop(frameStart: number): void {
            const target =
                (((DATA_BITS + 2) * 4 + STOP_MARGIN_QUARTERS)
                    * this.bitMicros256) >> 10;
            while (true) {
                const remaining = target - elapsed(frameStart);
                if (remaining <= 0) return;
                control.waitMicros(remaining > 64 ? 64 : remaining);
            }
        }

        public writeBuffer(buf: Buffer): void {
            for (let i = 0; i < buf.length; i++) {
                this.writeByte(buf.getUint8(i));
                yieldBetweenFrames();
            }
        }

        public writeString(text: string): void {
            for (let i = 0; i < text.length; i++) {
                this.writeByte(text.charCodeAt(i) & 0xff);
                yieldBetweenFrames();
            }
        }

        public writeLine(text: string): void {
            this.writeString(text);
            this.writeByte(13);
            yieldBetweenFrames();
            this.writeByte(10);
        }

        // -------------------------------------------------------- diagnostics

        /** Bytes lost because the receive buffer was full. */
        public overflowCount(): number { return this.rxOverflows; }

        /** Frames rejected because the stop bit was not high. */
        public framingErrorCount(): number { return this.rxFramingErrors; }

        /**
         * Transmitted bytes whose bit timing slipped far enough that the peer
         * may have received them corrupted. Non-zero means the micro:bit was
         * too busy while sending; send less often, or drop the baud rate.
         */
        public txGlitchCount(): number { return this.txGlitches; }
    }


    // ----------------------------------------------------------- port registry

    // Open ports, keyed by pin. A port is created the first time a pin is used
    // and reused afterwards, so no explicit "connect" step is needed: every
    // block carries the baud rate and just works on its own.
    //
    // Send blocks are keyed by their TX pin, receive blocks by their RX pin.
    // That is what makes `available(P16)` work when P16 is wired as RX — the
    // pin you name in a block is always the pin the data is on.
    let ports: SoftSerialPort[] = [];
    let portPins: number[] = [];
    let portBauds: number[] = [];

    const NO_PIN = -1;

    /**
     * Find the port registered for `pin`, creating it if this is the first use.
     * `isTx` selects which side of the port the pin is.
     */
    function portFor(pin: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                     isTx: boolean): SoftSerialPort {
        const key = pin as number;
        for (let i = 0; i < portPins.length; i++) {
            if (portPins[i] == key) {
                // Changing the baud rate of a live pin would need the pulse
                // handlers torn down, which CODAL does not offer. Report it
                // rather than silently ignoring the new rate.
                if (portBauds[i] != (baud as number)) baudConflicts++;
                return ports[i];
            }
        }
        const p = isTx
            ? new SoftSerialPort(pin, NO_PIN as DigitalPin, baud)
            : new SoftSerialPort(NO_PIN as DigitalPin, pin, baud);
        portPins.push(key);
        portBauds.push(baud as number);
        ports.push(p);
        return p;
    }

    let baudConflicts = 0;

    /**
     * Number of times a block asked for a baud rate different from the one a
     * pin was already using. The first rate a pin sees wins; a non-zero count
     * means two blocks disagree about the same pin.
     */
    //% blockId=softserial_baud_conflicts
    //% block="soft serial baud conflict count"
    //% group="Diagnostics" weight=27 advanced=true
    export function baudConflictCount(): number {
        return baudConflicts;
    }

    // --------------------------------------------------------- sending blocks

    /** Send text on a pin. */
    //% blockId=softserial_write_string
    //% block="soft serial|pin %tx|baud %baud|write %text"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Sending" weight=90
    export function writeString(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                                text: string): void {
        portFor(tx, baud, true).writeString(text);
    }

    /** Send text followed by CR LF. */
    //% blockId=softserial_write_line
    //% block="soft serial|pin %tx|baud %baud|write line %text"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Sending" weight=89
    export function writeLine(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                              text: string): void {
        portFor(tx, baud, true).writeLine(text);
    }

    /** Send a number as decimal text. */
    //% blockId=softserial_write_number
    //% block="soft serial|pin %tx|baud %baud|write number %value"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Sending" weight=88
    export function writeNumber(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                                value: number): void {
        portFor(tx, baud, true).writeString("" + value);
    }

    /** Send a single byte. */
    //% blockId=softserial_write_byte
    //% block="soft serial|pin %tx|baud %baud|write byte %value"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% value.min=0 value.max=255
    //% inlineInputMode=inline
    //% group="Sending" weight=87
    export function writeByte(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                              value: number): void {
        portFor(tx, baud, true).writeByte(value & 0xff);
    }

    /** Send a buffer of bytes. */
    //% blockId=softserial_write_buffer
    //% block="soft serial|pin %tx|baud %baud|write buffer %buf"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Sending" weight=86 advanced=true
    export function writeBuffer(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                                buf: Buffer): void {
        portFor(tx, baud, true).writeBuffer(buf);
    }

    // ------------------------------------------------------- receiving blocks

    /**
     * Number of bytes waiting on a receive pin.
     *
     * Using this block starts listening on the pin, so no setup step is needed.
     */
    //% blockId=softserial_available
    //% block="soft serial|pin %rx|baud %baud|available bytes"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Receiving" weight=80
    export function available(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): number {
        return portFor(rx, baud, false).available();
    }

    /** Read everything received so far on a pin. */
    //% blockId=softserial_read_string
    //% block="soft serial|pin %rx|baud %baud|read string"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Receiving" weight=79
    export function readString(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): string {
        return portFor(rx, baud, false).readString();
    }

    /** Read one byte from a pin, or -1 if none is waiting. */
    //% blockId=softserial_read_byte
    //% block="soft serial|pin %rx|baud %baud|read byte"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Receiving" weight=78
    export function readByte(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): number {
        return portFor(rx, baud, false).readByte();
    }

    /** Run code whenever a complete line arrives on a pin. */
    //% blockId=softserial_on_line
    //% block="on soft serial|pin %rx|baud %baud|line received"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% draggableParameters=reporter
    //% inlineInputMode=inline
    //% group="Receiving" weight=77
    export function onLine(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                           handler: (line: string) => void): void {
        // Open the port here rather than inside the loop, so listening starts
        // as soon as the handler is registered.
        const port = portFor(rx, baud, false);
        control.inBackground(() => {
            while (true) {
                const line = port.readUntil("\n");
                if (line.length > 0) {
                    handler(trimEol(line));
                } else {
                    // Nothing complete yet. Well under one byte time at the
                    // slowest baud, so we stay responsive without spinning.
                    basic.pause(5);
                }
            }
        });
    }

    function trimEol(s: string): string {
        let end = s.length;
        while (end > 0) {
            const c = s.charCodeAt(end - 1);
            if (c != 10 && c != 13) break;
            end--;
        }
        return s.substr(0, end);
    }

    // --------------------------------------------------------------- checksum

    /**
     * Checksum used by the checked send/receive blocks.
     *
     * CRC-8 (polynomial 0x07, init 0x00) — the same one used by SMBus/1-Wire
     * style links. It catches every single-bit error and every burst up to
     * eight bits, which is exactly the failure mode a bit-banged UART has: the
     * residual corruption on this driver is a lone flipped bit inside one byte.
     * A plain sum would miss reordering and cancel out paired errors.
     */
    function crc8(s: string): number {
        let crc = 0;
        for (let i = 0; i < s.length; i++) {
            crc = crc ^ (s.charCodeAt(i) & 0xff);
            for (let b = 0; b < 8; b++) {
                if (crc & 0x80) {
                    crc = ((crc << 1) ^ 0x07) & 0xff;
                } else {
                    crc = (crc << 1) & 0xff;
                }
            }
        }
        return crc & 0xff;
    }

    function hex2(v: number): string {
        const digits = "0123456789ABCDEF";
        return digits.charAt((v >> 4) & 0xf) + digits.charAt(v & 0xf);
    }

    function fromHex2(s: string): number {
        let v = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            let d = -1;
            if (c >= 48 && c <= 57) d = c - 48;              // 0-9
            else if (c >= 65 && c <= 70) d = c - 55;         // A-F
            else if (c >= 97 && c <= 102) d = c - 87;        // a-f
            if (d < 0) return -1;
            v = (v << 4) | d;
        }
        return v;
    }

    /**
     * Send text with a checksum appended, as `text*XX` followed by CR LF.
     *
     * The receiving side should use "on soft serial checked line received",
     * which verifies the checksum and silently drops corrupted messages.
     */
    //% blockId=softserial_write_checked
    //% block="soft serial|pin %tx|baud %baud|write checked %text"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Checksum" weight=70 blockGap=8
    export function writeChecked(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                                 text: string): void {
        // '*' separates payload from checksum, so the payload may contain any
        // character except '*' itself.
        portFor(tx, baud, true).writeLine(text + "*" + hex2(crc8(text)));
    }

    /**
     * Run code whenever a complete, checksum-verified message arrives.
     * Messages that fail the checksum are dropped and counted.
     */
    //% blockId=softserial_on_checked_line
    //% block="on soft serial|pin %rx|baud %baud|checked line received"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% draggableParameters=reporter
    //% inlineInputMode=inline
    //% group="Checksum" weight=69
    export function onCheckedLine(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800,
                                  handler: (line: string) => void): void {
        const port = portFor(rx, baud, false);
        control.inBackground(() => {
            while (true) {
                const raw = port.readUntil("\n");
                if (raw.length == 0) {
                    basic.pause(5);
                    continue;
                }
                const line = trimEol(raw);
                const star = lastIndexOfChar(line, "*");
                if (star < 0) { badChecksums++; continue; }

                const payload = line.substr(0, star);
                const digits = line.substr(star + 1, line.length - star - 1);
                // Require exactly two digits. Without the length check a
                // message whose checksum was lost in transit ("f5*") would
                // parse as 0 and be accepted whenever the payload's CRC is
                // also 0 — precisely the truncation this block exists to catch.
                if (digits.length != 2) { badChecksums++; continue; }

                const got = fromHex2(digits);
                if (got < 0 || got != crc8(payload)) {
                    badChecksums++;
                    continue;
                }
                handler(payload);
            }
        });
    }

    function lastIndexOfChar(s: string, ch: string): number {
        const c = ch.charCodeAt(0);
        for (let i = s.length - 1; i >= 0; i--) {
            if (s.charCodeAt(i) == c) return i;
        }
        return -1;
    }

    let badChecksums = 0;

    /** Messages dropped because their checksum did not match. */
    //% blockId=softserial_bad_checksums
    //% block="soft serial failed checksum count"
    //% group="Checksum" weight=68 advanced=true
    export function badChecksumCount(): number {
        return badChecksums;
    }

    // ------------------------------------------------------------ diagnostics

    /** Bytes lost because the receive buffer was full. */
    //% blockId=softserial_overflows
    //% block="soft serial|pin %rx|baud %baud|overflow count"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Diagnostics" weight=30 advanced=true
    export function overflowCount(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): number {
        return portFor(rx, baud, false).overflowCount();
    }

    /** Frames rejected because the stop bit was not high. */
    //% blockId=softserial_framing
    //% block="soft serial|pin %rx|baud %baud|framing error count"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Diagnostics" weight=29 advanced=true
    export function framingErrorCount(rx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): number {
        return portFor(rx, baud, false).framingErrorCount();
    }

    /**
     * Transmitted bytes whose bit timing slipped far enough that the peer may
     * have received them corrupted.
     */
    //% blockId=softserial_tx_glitches
    //% block="soft serial|pin %tx|baud %baud|tx glitch count"
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=4
    //% baud.defl=softSerial.BaudRate.Baud4800
    //% inlineInputMode=inline
    //% group="Diagnostics" weight=28 advanced=true
    export function txGlitchCount(tx: DigitalPin, baud: BaudRate = BaudRate.Baud4800): number {
        return portFor(tx, baud, true).txGlitchCount();
    }
}
