// Secondary indexes: by sample type and by collection date.
// Both serialize to plain JSON-able objects for persistence.

export class TypeIndex {
  constructor() {
    this.byType = new Map(); // type -> Set<id>
  }
  add(type, id) {
    let set = this.byType.get(type);
    if (!set) this.byType.set(type, (set = new Set()));
    set.add(id);
  }
  remove(type, id) {
    const set = this.byType.get(type);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.byType.delete(type);
  }
  ids(type) {
    const set = this.byType.get(type);
    return set ? [...set] : [];
  }
  toJSON() {
    const out = {};
    for (const [type, set] of this.byType) out[type] = [...set].sort();
    return out;
  }
  static fromJSON(data) {
    const idx = new TypeIndex();
    for (const [type, ids] of Object.entries(data || {})) {
      idx.byType.set(type, new Set(ids));
    }
    return idx;
  }
}

export class DateIndex {
  constructor() {
    this.byDate = new Map(); // date -> Set<id>
    this.dates = []; // sorted unique dates (YYYY-MM-DD sorts lexicographically)
  }
  #locate(date) {
    let lo = 0;
    let hi = this.dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dates[mid] < date) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  add(date, id) {
    let set = this.byDate.get(date);
    if (!set) {
      set = new Set();
      this.byDate.set(date, set);
      this.dates.splice(this.#locate(date), 0, date);
    }
    set.add(id);
  }
  remove(date, id) {
    const set = this.byDate.get(date);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) {
      this.byDate.delete(date);
      this.dates.splice(this.#locate(date), 1);
    }
  }
  // Inclusive [from, to] range scan; either bound may be null/undefined.
  idsInRange(from, to) {
    const out = [];
    for (const date of this.dates) {
      if (from != null && date < from) continue;
      if (to != null && date > to) break;
      for (const id of this.byDate.get(date)) out.push(id);
    }
    return out;
  }
  toJSON() {
    const byDate = {};
    for (const date of this.dates) byDate[date] = [...this.byDate.get(date)].sort();
    return { dates: [...this.dates], byDate };
  }
  static fromJSON(data) {
    const idx = new DateIndex();
    for (const date of data?.dates || []) {
      idx.dates.push(date);
      idx.byDate.set(date, new Set(data.byDate[date] || []));
    }
    return idx;
  }
}
