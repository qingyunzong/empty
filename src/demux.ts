import { Decoder } from "./decoder.js";
import { DemuxError } from "./errors.js";
import type { DecoderLimitOverrides } from "./limits.js";
import type {
  DecodedMessage,
  Delivery,
  FinishResult,
  PushMessage,
  ValueMessage,
} from "./types.js";

export type TicketState = "waiting" | "discarded" | "completed";

interface Registration<Ticket> {
  ticket: Ticket;
  state: TicketState;
}

/**
 * Matches complete top-level normal responses to registered tickets in FIFO
 * order. Pushes bypass the ticket queue.
 */
export class Demultiplexer<Ticket = string> {
  readonly decoder: Decoder;

  private readonly queue: Registration<Ticket>[] = [];
  private readonly registrations = new Map<Ticket, Registration<Ticket>>();

  constructor(
    decoder: Decoder | DecoderLimitOverrides = {},
  ) {
    if (decoder instanceof Decoder) {
      this.decoder = decoder;
    } else {
      this.decoder = new Decoder(decoder);
    }
  }

  get isFinished(): boolean {
    return this.decoder.isFinished;
  }

  get faultError(): Error | null {
    return this.decoder.faultError;
  }

  /** Waiting responses plus tombstones for cancelled requests. */
  get pendingCount(): number {
    return this.queue.length;
  }

  get waitingCount(): number {
    return this.queue.reduce(
      (count, entry) => count + (entry.state === "waiting" ? 1 : 0),
      0,
    );
  }

  pushBytes(fragment: Uint8Array): void {
    this.decoder.pushBytes(fragment);
  }

  PushBytes(fragment: Uint8Array): void {
    this.pushBytes(fragment);
  }

  register(ticket: Ticket): void {
    if (this.registrations.has(ticket)) {
      throw new DemuxError(
        "duplicate-ticket",
        "this ticket has already been registered",
        ticket,
      );
    }
    const entry: Registration<Ticket> = { ticket, state: "waiting" };
    this.registrations.set(ticket, entry);
    this.queue.push(entry);
  }

  Register(ticket: Ticket): void {
    this.register(ticket);
  }

  cancel(ticket: Ticket): void {
    const entry = this.registrations.get(ticket);
    if (entry === undefined) {
      throw new DemuxError(
        "unknown-ticket",
        "cannot cancel a ticket that was never registered",
        ticket,
      );
    }
    if (entry.state !== "waiting") {
      throw new DemuxError(
        "ticket-not-pending",
        `cannot cancel a ticket in state '${entry.state}'`,
        ticket,
      );
    }
    entry.state = "discarded";
  }

  Cancel(ticket: Ticket): void {
    this.cancel(ticket);
  }

  stateOf(ticket: Ticket): TicketState | undefined {
    return this.registrations.get(ticket)?.state;
  }

  /**
   * Matches one already-complete message. Hosts normally call `next`, which
   * combines decoder advancement and this method.
   */
  consume(message: DecodedMessage): Delivery<Ticket> {
    if (message.type === "push") {
      return {
        disposition: "push",
        ticket: null,
        message,
      };
    }

    const entry = this.queue.shift();
    if (entry === undefined) {
      return {
        disposition: "unsolicited",
        ticket: null,
        message,
      };
    }

    const wasDiscarded = entry.state === "discarded";
    entry.state = "completed";
    if (wasDiscarded) {
      return {
        disposition: "discarded",
        ticket: entry.ticket,
        message,
      };
    }
    return {
      disposition: "matched",
      ticket: entry.ticket,
      message,
    };
  }

  Consume(message: DecodedMessage): Delivery<Ticket> {
    return this.consume(message);
  }

  next(): Delivery<Ticket> | null {
    const message = this.decoder.next();
    if (message === null) {
      return null;
    }
    return this.consume(message);
  }

  Next(): Delivery<Ticket> | null {
    return this.next();
  }

  finish(): FinishResult {
    return this.decoder.finish();
  }

  Finish(): FinishResult {
    return this.finish();
  }
}

export function createDemultiplexer<Ticket = string>(
  limits: DecoderLimitOverrides = {},
): Demultiplexer<Ticket> {
  return new Demultiplexer<Ticket>(new Decoder(limits));
}
