// Naive reference implementation: "copy array + visibility rules".
// Every commit appends a FULL copy of the key/value map to a versions array.
// A transaction sees the array element pinned at begin() plus its own writes.
// Written independently from src/store.js so the enumeration test is a real
// differential check.

class RefError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function indexKeyOf(value) {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.workcenter === 'string' &&
    typeof value.timeSlot === 'string'
  ) {
    return JSON.stringify([value.workcenter, value.timeSlot]);
  }
  return null;
}

export class RefStore {
  constructor() {
    this.versions = [{ data: {}, keys: [] }]; // versions[i].data is a full copy
    this.txs = new Map();
    this.nextTx = 1;
  }

  begin() {
    const id = 'tx' + this.nextTx++;
    this.txs.set(id, { base: this.versions.length - 1, writes: {}, done: false });
    return id;
  }

  baseVersionOf(id) {
    return this._tx(id).base;
  }

  _tx(id) {
    const tx = this.txs.get(id);
    if (!tx || tx.done) throw new RefError('E_USAGE', `unknown or finished transaction: ${id}`);
    return tx;
  }

  get(id, key) {
    const tx = this._tx(id);
    if (Object.hasOwn(tx.writes, key)) return structuredClone(tx.writes[key]);
    const snap = this.versions[tx.base].data;
    return Object.hasOwn(snap, key) ? structuredClone(snap[key]) : null;
  }

  put(id, key, value) {
    const tx = this._tx(id);
    tx.writes[key] = structuredClone(value);
  }

  commit(id) {
    const tx = this._tx(id);
    const written = new Set(Object.keys(tx.writes));

    // 1. Snapshot rule: any committed version after base that touched a key
    //    this tx wrote makes the commit illegal.
    for (let v = tx.base + 1; v < this.versions.length; v++) {
      for (const key of this.versions[v].keys) {
        if (written.has(key)) {
          throw new RefError('E_SNAPSHOT', `key ${JSON.stringify(key)} modified after begin`);
        }
      }
    }

    // 2. Unique index over the latest committed copy plus this tx's writes.
    const latest = this.versions[this.versions.length - 1].data;
    const merged = { ...latest, ...tx.writes };
    const seen = new Map();
    for (const [key, value] of Object.entries(merged)) {
      const ik = indexKeyOf(value);
      if (ik === null) continue;
      if (seen.has(ik) && seen.get(ik) !== key) {
        throw new RefError('E_UNIQUE', `slot occupied by ${JSON.stringify(seen.get(ik))}`);
      }
      seen.set(ik, key);
    }

    // 3. Append a full copy.
    this.versions.push({ data: merged, keys: [...written] });
    tx.done = true;
    return this.versions.length - 1;
  }

  abort(id) {
    this._tx(id).done = true;
  }
}
