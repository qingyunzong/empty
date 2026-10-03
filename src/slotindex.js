// Predicate secondary index organized by (workcenter, start, end).
// Per workcenter keeps a slot -> total committed quantity map, so a
// predicate range [start, end) can be enumerated without scanning orders.
export class SlotIndex {
  constructor() {
    this.byWorkcenter = new Map(); // wc -> Map<slot, qty>
  }

  #wcMap(wc, create = false) {
    let m = this.byWorkcenter.get(wc);
    if (!m && create) {
      m = new Map();
      this.byWorkcenter.set(wc, m);
    }
    return m;
  }

  // delta may be negative; covers every 15-min slot in [start, end)
  apply(wc, start, end, delta) {
    const m = this.#wcMap(wc, true);
    for (let slot = start; slot < end; slot++) {
      const next = (m.get(slot) || 0) + delta;
      if (next === 0) m.delete(slot);
      else m.set(slot, next);
    }
  }

  quantityAt(wc, slot) {
    const m = this.#wcMap(wc);
    return m ? m.get(slot) || 0 : 0;
  }

  // Dense per-slot quantities for [start, end): array of length end-start.
  enumerate(wc, start, end) {
    const m = this.#wcMap(wc);
    const out = new Array(end - start).fill(0);
    if (m) {
      for (let i = 0; i < out.length; i++) out[i] = m.get(start + i) || 0;
    }
    return out;
  }
}
