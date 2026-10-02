// Lamport causal clock: every plan operation carries a {node, counter} stamp
// and records the stamps it causally depends on.
export class LamportClock {
  constructor(node = 'node-0', counter = 0) {
    this.node = node;
    this.counter = counter;
  }
  tick() {
    this.counter += 1;
    return { node: this.node, counter: this.counter };
  }
  observe(stamp) {
    if (stamp && stamp.counter > this.counter) this.counter = stamp.counter;
  }
}

export function compareClock(a, b) {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

// true when `stamp` is covered by the causal context `seen` (array of stamps)
export function causallyBefore(stamp, seen) {
  return seen.some((s) => s.node === stamp.node && s.counter >= stamp.counter);
}
