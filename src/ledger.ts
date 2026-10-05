import type { ItemId } from "./buffer.js";

/**
 * Per-item-type material ledger. Tracks every unit that enters or leaves the
 * system, plus net conversions performed by machines at job completion, so the
 * expected physical count of every item type is known at all times:
 *
 *   expected(item) = injected(item) - extracted(item) + convertedNet(item)
 *
 * where convertedNet accumulates (outputs - inputs) over completed jobs.
 */
export class MaterialLedger {
  private readonly injected = new Map<ItemId, number>();
  private readonly extracted = new Map<ItemId, number>();
  private readonly convertedNet = new Map<ItemId, number>();

  private bump(map: Map<ItemId, number>, item: ItemId, delta: number): void {
    map.set(item, (map.get(item) ?? 0) + delta);
  }

  recordInject(item: ItemId, qty: number): void {
    this.bump(this.injected, item, qty);
  }

  recordExtract(item: ItemId, qty: number): void {
    this.bump(this.extracted, item, qty);
  }

  recordConversion(
    inputs: Readonly<Record<ItemId, number>>,
    outputs: Readonly<Record<ItemId, number>>,
  ): void {
    for (const [item, qty] of Object.entries(inputs)) this.bump(this.convertedNet, item, -qty);
    for (const [item, qty] of Object.entries(outputs)) this.bump(this.convertedNet, item, qty);
  }

  expected(item: ItemId): number {
    return (
      (this.injected.get(item) ?? 0) -
      (this.extracted.get(item) ?? 0) +
      (this.convertedNet.get(item) ?? 0)
    );
  }

  items(): ItemId[] {
    const all = new Set<ItemId>([
      ...this.injected.keys(),
      ...this.extracted.keys(),
      ...this.convertedNet.keys(),
    ]);
    return [...all].sort();
  }

  /**
   * Compares the ledger against the physical count. Throws with a detailed
   * message on the first mismatch.
   */
  check(physical: ReadonlyMap<ItemId, number>): void {
    const items = new Set<ItemId>([...this.items(), ...physical.keys()]);
    for (const item of [...items].sort()) {
      const want = this.expected(item);
      const got = physical.get(item) ?? 0;
      if (want !== got) {
        throw new Error(
          `material conservation violated for "${item}": ledger expects ${want}, physical count is ${got}`,
        );
      }
    }
  }
}
