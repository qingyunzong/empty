export type ItemId = string;

/** A bounded storage for items. Capacity counts total units across item types. */
export class Buffer {
  readonly id: string;
  readonly capacity: number;
  private readonly contents = new Map<ItemId, number>();

  constructor(id: string, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error(`buffer ${id}: capacity must be a non-negative integer`);
    }
    this.id = id;
    this.capacity = capacity;
  }

  get used(): number {
    let total = 0;
    for (const qty of this.contents.values()) total += qty;
    return total;
  }

  get free(): number {
    return this.capacity - this.used;
  }

  quantity(item: ItemId): number {
    return this.contents.get(item) ?? 0;
  }

  hasAll(requirements: Readonly<Record<ItemId, number>>): boolean {
    for (const [item, qty] of Object.entries(requirements)) {
      if (this.quantity(item) < qty) return false;
    }
    return true;
  }

  canFitAll(items: Readonly<Record<ItemId, number>>): boolean {
    let total = 0;
    for (const qty of Object.values(items)) total += qty;
    return total <= this.free;
  }

  add(item: ItemId, qty: number): void {
    if (qty <= 0) throw new Error(`buffer ${this.id}: add qty must be positive`);
    if (qty > this.free) {
      throw new Error(`buffer ${this.id}: cannot add ${qty} of ${item}, only ${this.free} free`);
    }
    this.contents.set(item, this.quantity(item) + qty);
  }

  remove(item: ItemId, qty: number): void {
    if (qty <= 0) throw new Error(`buffer ${this.id}: remove qty must be positive`);
    const have = this.quantity(item);
    if (have < qty) {
      throw new Error(`buffer ${this.id}: cannot remove ${qty} of ${item}, only ${have} present`);
    }
    if (have === qty) this.contents.delete(item);
    else this.contents.set(item, have - qty);
  }

  snapshot(): Record<ItemId, number> {
    const out: Record<ItemId, number> = {};
    for (const [item, qty] of this.contents) out[item] = qty;
    return out;
  }
}
