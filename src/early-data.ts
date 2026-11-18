import { equalConstantTime, hex } from "./bytes.ts";

export interface EarlyDataTicket {
  readonly id: string;
  readonly psk: Uint8Array;
  readonly issuedAt: number;
  readonly lifetimeMs: number;
  readonly maxEarlyData: number;
}

export interface TicketStore {
  get(ticketId: string): EarlyDataTicket | undefined;
}

export class InMemoryTicketStore implements TicketStore {
  private readonly tickets: Map<string, EarlyDataTicket>;

  constructor(tickets: readonly EarlyDataTicket[] = []) {
    this.tickets = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  }

  get(ticketId: string): EarlyDataTicket | undefined {
    return this.tickets.get(ticketId);
  }

  put(ticket: EarlyDataTicket): void {
    this.tickets.set(ticket.id, ticket);
  }
}

export type EarlyDataCheckReason =
  | "accepted"
  | "unknown_ticket"
  | "expired"
  | "replay";

export interface EarlyDataCheck {
  readonly accepted: boolean;
  readonly replay: boolean;
  readonly reason: EarlyDataCheckReason;
}

/**
 * Single-use ticket cache for 0-RTT. A ticket may be consumed once; a second
 * ClientHello carrying the same ticket, or the same client random with a
 * different ticket, is treated as a replay. Transport-level retransmission
 * must use Handshake.resend(), which never reaches this guard.
 */
export class EarlyDataReplayGuard {
  private readonly usedTickets: Map<string, { readonly random: string; readonly at: number }>;
  private readonly usedRandoms: Map<string, string>;

  constructor() {
    this.usedTickets = new Map();
    this.usedRandoms = new Map();
  }

  check(
    ticket: EarlyDataTicket | undefined,
    clientRandom: Uint8Array,
    now: number,
  ): EarlyDataCheck {
    if (ticket === undefined) {
      return { accepted: false, replay: false, reason: "unknown_ticket" };
    }
    if (now < ticket.issuedAt || now - ticket.issuedAt > ticket.lifetimeMs) {
      return { accepted: false, replay: false, reason: "expired" };
    }

    const random = hex(clientRandom);
    const ticketUse = this.usedTickets.get(ticket.id);
    const randomUse = this.usedRandoms.get(random);
    if (ticketUse !== undefined || randomUse !== undefined) {
      return { accepted: false, replay: true, reason: "replay" };
    }

    this.usedTickets.set(ticket.id, { random, at: now });
    this.usedRandoms.set(random, ticket.id);
    return { accepted: true, replay: false, reason: "accepted" };
  }

  hasSeenTicket(ticketId: string): boolean {
    return this.usedTickets.has(ticketId);
  }

  hasSeenRandom(clientRandom: Uint8Array): boolean {
    return this.usedRandoms.has(hex(clientRandom));
  }
}

export function ticketMatchesPsk(ticket: EarlyDataTicket, psk: Uint8Array): boolean {
  return equalConstantTime(ticket.psk, psk);
}
