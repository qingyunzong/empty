import type { Frame, FrameId } from './types.ts';

export interface FrameLedgerEntrySnapshot {
  readonly key: string;
  readonly id: FrameId;
  readonly size: number;
  readonly delivered: boolean;
  readonly copies: readonly number[];
}

interface LedgerEntry {
  readonly id: FrameId;
  readonly size: number;
  readonly copies: Set<number>;
  delivered: boolean;
}

export function frameKey(id: FrameId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

/**
 * Counts each logical frame at most once, even when it is present in several
 * in-flight packets (for example, a PTO probe that reuses an outstanding
 * STREAM frame).  Packet overhead is accounted separately by the recovery
 * component and is intentionally per packet.
 */
export class FrameLedger {
  readonly #entries = new Map<string, LedgerEntry>();
  #bytes = 0;

  get bytes(): number {
    return this.#bytes;
  }

  add(packetNumber: number, frame: Frame): number {
    const key = frameKey(frame.id);
    const existing = this.#entries.get(key);

    if (existing !== undefined) {
      if (existing.size !== frame.size) {
        throw new RangeError(
          `frame ${key} was retransmitted with a different size`,
        );
      }
      existing.copies.add(packetNumber);
      return 0;
    }

    this.#entries.set(key, {
      id: frame.id,
      size: frame.size,
      copies: new Set([packetNumber]),
      delivered: false,
    });
    this.#bytes += frame.size;
    return frame.size;
  }

  /**
   * Acknowledging one copy delivers the logical frame.  Any other in-flight
   * copies stop contributing bytes immediately; later ACK/loss events for
   * those copies are idempotent.
   */
  acknowledge(packetNumber: number, frame: Frame): number {
    const key = frameKey(frame.id);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return 0;
    }

    entry.copies.delete(packetNumber);
    let delta = 0;

    if (!entry.delivered) {
      entry.delivered = true;
      this.#bytes -= entry.size;
      delta = -entry.size;
    }

    if (entry.copies.size === 0) {
      this.#entries.delete(key);
    }

    return delta;
  }

  lose(packetNumber: number, frame: Frame): number {
    const key = frameKey(frame.id);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return 0;
    }

    entry.copies.delete(packetNumber);
    let delta = 0;

    if (!entry.delivered && entry.copies.size === 0) {
      this.#bytes -= entry.size;
      delta = -entry.size;
    }

    if (entry.copies.size === 0) {
      this.#entries.delete(key);
    }

    return delta;
  }

  clear(): number {
    const bytes = this.#bytes;
    this.#entries.clear();
    this.#bytes = 0;
    return bytes;
  }

  snapshot(): readonly FrameLedgerEntrySnapshot[] {
    return [...this.#entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => ({
        key,
        id: entry.id,
        size: entry.size,
        delivered: entry.delivered,
        copies: [...entry.copies].sort((a, b) => a - b),
      }));
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  sizeOf(key: string): number | undefined {
    return this.#entries.get(key)?.size;
  }

  copyNumbers(key: string): readonly number[] {
    return [...(this.#entries.get(key)?.copies ?? [])];
  }
}
