import { zeroCounts, accumulate } from './summarize.js';

const DIMS = [
  'weightSum',
  'weightedValueSum',
  'usedCount',
  'nullCount',
  'deletedCount',
  'badCount',
  'unknownCount',
];

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Per-site incremental window index: sorted valid-time coordinates plus a
// Fenwick (binary indexed) tree over the seven aggregate counters.
//   - new coordinate      -> splice + rebuild, O(n)
//   - correction to a key -> point update,     O(log n)
//   - window query        -> two prefix sums,  O(log n)
// Corrections dominate an archive's write workload, so the common path is
// logarithmic and never rescans the window.
export class SiteAgg {
  constructor() {
    this.times = []; // sorted unique epoch-ms coordinates
    this.slots = new Map(); // timeMs -> Float64Array current counter vector
    this.tree = []; // 1-based Fenwick nodes
  }

  set(timeMs, version) {
    const counts = accumulate(zeroCounts(), version);
    const vec = Float64Array.from(DIMS.map((d) => counts[d]));
    const old = this.slots.get(timeMs);
    if (old) {
      const delta = vec.map((x, i) => x - old[i]);
      this.slots.set(timeMs, vec);
      this._add(lowerBound(this.times, timeMs), delta);
    } else {
      const at = lowerBound(this.times, timeMs);
      this.times.splice(at, 0, timeMs);
      this.slots.set(timeMs, vec);
      this._rebuild();
    }
  }

  query(fromMs, toMs) {
    const hi = lowerBound(this.times, toMs + 1); // count of coords <= toMs
    const lo = lowerBound(this.times, fromMs); // count of coords < fromMs
    const a = this._prefix(hi);
    const b = this._prefix(lo);
    const counts = zeroCounts();
    DIMS.forEach((d, i) => {
      counts[d] = a[i] - b[i];
    });
    return counts;
  }

  _rebuild() {
    this.tree = Array.from({ length: this.times.length + 1 }, () => new Float64Array(DIMS.length));
    this.times.forEach((t, i) => this._add(i, this.slots.get(t)));
  }

  _add(idx0, vec) {
    for (let i = idx0 + 1; i < this.tree.length; i += i & -i) {
      const node = this.tree[i];
      for (let d = 0; d < vec.length; d += 1) node[d] += vec[d];
    }
  }

  _prefix(k) {
    const out = new Float64Array(DIMS.length);
    for (let i = k; i > 0; i -= i & -i) {
      const node = this.tree[i];
      for (let d = 0; d < DIMS.length; d += 1) out[d] += node[d];
    }
    return out;
  }
}
