import type { AckRange } from './types.ts';

export const MAX_PACKET_NUMBER = Number.MAX_SAFE_INTEGER;

function assertPacketNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PACKET_NUMBER) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/**
 * Validate, sort (descending) and coalesce overlapping/adjacent ACK ranges.
 * The returned array never allocates per-packet-number storage, so a peer
 * cannot force a large allocation with a wide ACK range.
 */
export function normalizeAckRanges(
  ranges: readonly AckRange[],
): readonly AckRange[] {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new RangeError('an ACK frame must contain at least one range');
  }

  const sorted = ranges.map((range) => {
    assertPacketNumber(range.smallest, 'ACK range smallest');
    assertPacketNumber(range.largest, 'ACK range largest');
    if (range.smallest > range.largest) {
      throw new RangeError('ACK range smallest must not exceed largest');
    }
    return { smallest: range.smallest, largest: range.largest };
  });

  sorted.sort((a, b) => b.largest - a.largest || b.smallest - a.smallest);

  const merged: AckRange[] = [];
  const first = sorted[0];
  if (first === undefined) {
    throw new RangeError('an ACK frame must contain at least one range');
  }
  let current: { smallest: number; largest: number } = { ...first };

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (next === undefined) {
      continue;
    }
    if (next.largest >= current.smallest - 1) {
      current.smallest = Math.min(current.smallest, next.smallest);
    } else {
      merged.push(Object.freeze(current));
      current = { ...next };
    }
  }
  merged.push(Object.freeze(current));

  return Object.freeze(merged);
}

export class AckRangeSet {
  readonly #ranges: readonly AckRange[];

  constructor(ranges: readonly AckRange[]) {
    this.#ranges = normalizeAckRanges(ranges);
  }

  get largest(): number {
    return this.#ranges[0]!.largest;
  }

  get smallest(): number {
    return this.#ranges[this.#ranges.length - 1]!.smallest;
  }

  get ranges(): readonly AckRange[] {
    return this.#ranges;
  }

  has(packetNumber: number): boolean {
    if (
      !Number.isSafeInteger(packetNumber) ||
      packetNumber < this.smallest ||
      packetNumber > this.largest
    ) {
      return false;
    }

    let low = 0;
    let high = this.#ranges.length - 1;

    while (low <= high) {
      const middle = (low + high) >>> 1;
      const range = this.#ranges[middle]!;

      if (packetNumber > range.largest) {
        high = middle - 1;
      } else if (packetNumber < range.smallest) {
        low = middle + 1;
      } else {
        return true;
      }
    }

    return false;
  }
}
