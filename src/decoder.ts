import {
  DecoderStateError,
  RespProtocolError,
} from "./errors.js";
import { FrameParser, NeedMore } from "./internal/parser.js";
import {
  resolveLimits,
  type DecoderLimitOverrides,
  type DecoderLimits,
} from "./limits.js";
import type {
  DecodedMessage,
  FinishResult,
  TruncationReason,
} from "./types.js";

const EMPTY = new Uint8Array(0);

/**
 * Incremental byte-fed decoder for one RESP connection.
 *
 * `pushBytes` may be called with any fragment boundaries. `next` returns at
 * most one complete top-level value or push. Complete messages are retained
 * until consumed; bytes belonging to already returned messages are discarded.
 */
export class Decoder {
  readonly limits: DecoderLimits;

  private buffer: Uint8Array = EMPTY;
  private baseOffset = 0;
  private totalFed = 0;
  private queue: DecodedMessage[] = [];
  private fault: RespProtocolError | null = null;
  private incomplete: NeedMore | null = null;
  private finished = false;
  private finishResult: FinishResult | null = null;

  constructor(limits: DecoderLimitOverrides = {}) {
    this.limits = resolveLimits(limits);
  }

  /** Absolute offset immediately after all bytes fed so far. */
  get bytesFed(): number {
    return this.totalFed;
  }

  /** Bytes retained for the current, not-yet-complete top-level message. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** A permanent failure, if one has occurred. */
  get faultError(): RespProtocolError | null {
    return this.fault;
  }

  get pendingMessages(): number {
    return this.queue.length;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  pushBytes(fragment: Uint8Array): void {
    if (this.fault !== null) {
      throw this.fault;
    }
    if (this.finished) {
      throw new DecoderStateError(
        "decoder-finished",
        "cannot push bytes after finish()",
      );
    }
    if (!(fragment instanceof Uint8Array)) {
      throw new TypeError("pushBytes expects a Uint8Array fragment");
    }
    if (fragment.length === 0) {
      return;
    }
    this.totalFed += fragment.length;

    if (this.buffer.length === 0) {
      this.buffer = fragment.slice();
    } else {
      const merged = new Uint8Array(this.buffer.length + fragment.length);
      merged.set(this.buffer, 0);
      merged.set(fragment, this.buffer.length);
      this.buffer = merged;
    }

    this.pump();
  }

  /** Capitalized compatibility alias for the interface name in the spec. */
  PushBytes(fragment: Uint8Array): void {
    this.pushBytes(fragment);
  }

  /**
   * Returns the next complete message, or null if the current frame needs
   * more bytes. Once a permanent fault exists, queued complete messages are
   * returned first and then the fault is thrown on every later call.
   */
  next(): DecodedMessage | null {
    const message = this.queue.shift();
    if (message !== undefined) {
      return message;
    }
    if (this.fault !== null) {
      throw this.fault;
    }
    return null;
  }

  /** Capitalized compatibility alias for the interface name in the spec. */
  Next(): DecodedMessage | null {
    return this.next();
  }

  /**
   * Checks that the fed byte stream ends at a message boundary. Truncated
   * current frames are reported; protocol/budget faults are thrown.
   */
  finish(): FinishResult {
    if (this.fault !== null) {
      throw this.fault;
    }
    if (this.finished && this.finishResult !== null) {
      return this.finishResult;
    }
    if (this.buffer.length > 0) {
      this.pump();
    }
    if (this.fault !== null) {
      throw this.fault;
    }

    this.finished = true;
    if (this.buffer.length === 0) {
      this.finishResult = {
        clean: true,
        ok: true,
        pendingMessages: this.queue.length,
      };
      return this.finishResult;
    }

    const reason: TruncationReason =
      this.incomplete?.reason ?? "unclosed-container";
    this.finishResult = {
      clean: false,
      ok: false,
      reason,
      at: this.incomplete?.at ?? this.bytesFed,
      pendingMessages: this.queue.length,
      openContainers: this.incomplete?.openContainers ?? 0,
      pendingAttributes: this.incomplete?.pendingAttributes ?? false,
      detail:
        this.incomplete?.detail ??
        "the current top-level frame is incomplete at EOF",
    };
    return this.finishResult;
  }

  /** Capitalized compatibility alias for the interface name in the spec. */
  Finish(): FinishResult {
    return this.finish();
  }

  private pump(): void {
    while (this.fault === null && this.buffer.length > 0) {
      const parser = new FrameParser(this.buffer, this.limits, this.baseOffset);
      let outcome;
      try {
        outcome = parser.parseMessage();
      } catch (error) {
        if (error instanceof NeedMore) {
          this.incomplete = error;
          return;
        }
        if (error instanceof RespProtocolError) {
          this.fault = error;
          this.incomplete = null;
          // The faulty frame is never delivered. Release its raw bytes while
          // retaining every message that was already completed.
          this.buffer = EMPTY;
          return;
        }
        throw error;
      }

      this.queue.push(outcome.message);
      this.incomplete = null;
      this.consumeBytes(outcome.end);
    }
  }

  private consumeBytes(end: number): void {
    if (end >= this.buffer.length) {
      this.buffer = EMPTY;
    } else {
      // Copy the suffix rather than retaining a view of an older, potentially
      // much larger input fragment.
      this.buffer = this.buffer.slice(end);
    }
    this.baseOffset += end;
  }
}

export function createDecoder(limits: DecoderLimitOverrides = {}): Decoder {
  return new Decoder(limits);
}
