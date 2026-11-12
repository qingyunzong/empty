export const START_BYTE = 0x68;
export const MIN_APDU_LENGTH = 4;
export const MAX_APDU_LENGTH = 253;
export const MIN_INFORMATION_LENGTH = 10;
export const CONTROL_FIELD_LENGTH = 4;
export const SEQUENCE_MODULUS = 32768;

export class TelemetryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryProtocolError";
  }
}

export interface InformationFrame {
  readonly kind: "information";
  readonly sendSequence: number;
  readonly receiveSequence: number;
  readonly data: Uint8Array;
}

export interface SupervisoryFrame {
  readonly kind: "supervisory";
  readonly receiveSequence: number;
}

export interface ControlFrame {
  readonly kind: "control";
  readonly functionBits: number;
}

export type TelemetryFrame = InformationFrame | SupervisoryFrame | ControlFrame;

export interface TelemetryDecoderOptions {
  maxApdu: number;
  expectedSendSequence?: number;
  onFrame?: (frame: TelemetryFrame) => void;
}

export class TelemetryDecoder {
  #maxApdu: number;
  #expectedSendSequence: number;
  #onFrame: ((frame: TelemetryFrame) => void) | undefined;
  #pending: number[] = [];
  #failure: TelemetryProtocolError | null = null;

  constructor(options: TelemetryDecoderOptions) {
    const { maxApdu, expectedSendSequence = 0, onFrame } = options;
    if (!Number.isInteger(maxApdu) || maxApdu < MIN_APDU_LENGTH) {
      throw new RangeError(`maxApdu must be an integer >= ${MIN_APDU_LENGTH}`);
    }
    if (
      !Number.isInteger(expectedSendSequence) ||
      expectedSendSequence < 0 ||
      expectedSendSequence >= SEQUENCE_MODULUS
    ) {
      throw new RangeError("expectedSendSequence must be an integer in [0, 32768)");
    }
    this.#maxApdu = maxApdu;
    this.#expectedSendSequence = expectedSendSequence;
    this.#onFrame = onFrame;
  }

  get expectedSendSequence(): number {
    return this.#expectedSendSequence;
  }

  get failed(): boolean {
    return this.#failure !== null;
  }

  push(chunk: Uint8Array): TelemetryFrame[] {
    this.#assertRunning();
    const delivered: TelemetryFrame[] = [];
    for (const byte of chunk) {
      this.#pending.push(byte);
    }
    this.#drain(delivered);
    return delivered;
  }

  end(): void {
    this.#assertRunning();
    if (this.#pending.length !== 0) {
      this.#fail(
        `stream ended with an incomplete frame (${this.#pending.length} byte(s) buffered)`,
      );
    }
  }

  #assertRunning(): void {
    if (this.#failure !== null) {
      throw this.#failure;
    }
  }

  #fail(message: string): never {
    this.#failure = new TelemetryProtocolError(message);
    throw this.#failure;
  }

  #drain(delivered: TelemetryFrame[]): void {
    for (;;) {
      if (this.#pending.length === 0) {
        return;
      }
      const start = this.#pending[0];
      if (start !== START_BYTE) {
        this.#fail(
          `expected start byte 0x68, got 0x${start.toString(16).padStart(2, "0")}`,
        );
      }
      if (this.#pending.length < 2) {
        return;
      }
      const length = this.#pending[1];
      if (
        length < MIN_APDU_LENGTH ||
        length > MAX_APDU_LENGTH ||
        length > this.#maxApdu
      ) {
        this.#fail(`rejected declared APDU length ${length}`);
      }
      if (this.#pending.length < 2 + length) {
        return;
      }
      const apdu = this.#pending.splice(0, 2 + length).slice(2);
      const frame = this.#parseApdu(apdu, length);
      delivered.push(frame);
      this.#onFrame?.(frame);
    }
  }

  #parseApdu(apdu: number[], length: number): TelemetryFrame {
    const c0 = apdu[0];
    const c1 = apdu[1];
    const c2 = apdu[2];
    const c3 = apdu[3];

    if ((c0 & 0x01) === 0) {
      if (length < MIN_INFORMATION_LENGTH) {
        this.#fail(`information frame length ${length} is below ${MIN_INFORMATION_LENGTH}`);
      }
      if ((c2 & 0x01) !== 0) {
        this.#fail("information frame receive sequence has its format bit set");
      }
      const sendSequence = ((c1 << 8) | c0) >>> 1;
      const receiveSequence = ((c3 << 8) | c2) >>> 1;
      if (sendSequence !== this.#expectedSendSequence) {
        this.#fail(
          `out-of-sequence information frame: got send sequence ${sendSequence}, expected ${this.#expectedSendSequence}`,
        );
      }
      this.#expectedSendSequence =
        (this.#expectedSendSequence + 1) % SEQUENCE_MODULUS;
      return {
        kind: "information",
        sendSequence,
        receiveSequence,
        data: Uint8Array.from(apdu.slice(CONTROL_FIELD_LENGTH)),
      };
    }

    if ((c0 & 0x03) === 0x01) {
      if (length !== CONTROL_FIELD_LENGTH) {
        this.#fail(`supervisory frame length ${length} is not ${CONTROL_FIELD_LENGTH}`);
      }
      if (c1 !== 0) {
        this.#fail("supervisory frame second control byte is not zero");
      }
      if ((c2 & 0x01) !== 0) {
        this.#fail("supervisory frame receive sequence has its format bit set");
      }
      return {
        kind: "supervisory",
        receiveSequence: ((c3 << 8) | c2) >>> 1,
      };
    }

    if (length !== CONTROL_FIELD_LENGTH) {
      this.#fail(`control frame length ${length} is not ${CONTROL_FIELD_LENGTH}`);
    }
    const functionBits = c0 >>> 2;
    if (functionBits === 0 || (functionBits & (functionBits - 1)) !== 0) {
      this.#fail(
        `control frame must set exactly one function bit, got 0b${functionBits
          .toString(2)
          .padStart(6, "0")}`,
      );
    }
    if (c1 !== 0 || c2 !== 0 || c3 !== 0) {
      this.#fail("control frame trailing control bytes are not zero");
    }
    return { kind: "control", functionBits };
  }
}
