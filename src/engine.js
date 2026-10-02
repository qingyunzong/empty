'use strict';

const { sha256hex } = require('./canon');
const { PacklineError, EXIT, frameError, refError, terminalError } = require('./errors');

const HASH_DOMAIN = 'packline-trace/1';
const STATUS = { PACK: 'PACKED', REWORK: 'REWORK', SCRAP: 'SCRAPPED' };
const AUDIT_REASON = 'audit';

function cmpEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Application layer. Events are applied in arrival order (the protocol layer
// below may deliver duplicates and out-of-order frames); every derived view
// is a deterministic function of the full event set, so any arrival order
// converges to the same final state.
//
// The content hash is maintained incrementally as a multiset (XOR) hash over
// the ids of the currently-valid events plus a valid-event counter. That is
// the entire hidden state, and it is fully re-derivable from the event log:
// recomputeContentHash() recomputes it from scratch and must always agree.
class Engine {
  #events = new Map(); // id -> { event, superseded }
  #children = new Map(); // ref id -> Set of CORRECT event ids referencing it
  #byItem = new Map(); // item -> Set of event ids
  #xor = Buffer.alloc(32);
  #validCount = 0;
  #finalized = false;

  get size() {
    return this.#events.size;
  }

  get validCount() {
    return this.#validCount;
  }

  has(id) {
    return this.#events.has(id);
  }

  // Returns 'duplicate' or 'applied'.
  apply(event) {
    if (this.#finalized) throw new PacklineError('engine already finalized', EXIT.GENERAL);
    const id = event.id;
    if (this.#events.has(id)) return 'duplicate';
    const rec = { event, superseded: true }; // #refresh settles the real flag
    this.#events.set(id, rec);
    if (!this.#byItem.has(event.item)) this.#byItem.set(event.item, new Set());
    this.#byItem.get(event.item).add(id);
    if (event.kind === 'CORRECT') {
      if (!this.#children.has(event.ref)) this.#children.set(event.ref, new Set());
      this.#children.get(event.ref).add(id);
    }
    const affected = new Set([id]);
    const kids = this.#children.get(id);
    if (kids) for (const kid of kids) affected.add(kid);
    if (event.kind === 'CORRECT') {
      affected.add(event.ref);
      const siblings = this.#children.get(event.ref);
      if (siblings) for (const sib of siblings) affected.add(sib);
    }
    this.#refresh(affected);
    return 'applied';
  }

  // An event is superseded when a CORRECT references it, or (for a CORRECT)
  // when a sibling correction of the same referent is logically later.
  #computeSuperseded(id) {
    const rec = this.#events.get(id);
    const kids = this.#children.get(id);
    if (kids && kids.size > 0) return true;
    const event = rec.event;
    if (event.kind === 'CORRECT') {
      const siblings = this.#children.get(event.ref);
      if (siblings) {
        for (const sibId of siblings) {
          if (sibId === id) continue;
          const sib = this.#events.get(sibId).event;
          if (cmpEvents(sib, event) > 0) return true;
        }
      }
    }
    return false;
  }

  #refresh(affected) {
    for (const id of affected) {
      const rec = this.#events.get(id);
      if (!rec) continue;
      const superseded = this.#computeSuperseded(id);
      if (superseded !== rec.superseded) {
        rec.superseded = superseded;
        this.#accXor(rec.event.id);
        this.#validCount += superseded ? -1 : 1;
      }
    }
  }

  #accXor(idHex) {
    const bytes = Buffer.from(idHex, 'hex');
    for (let i = 0; i < 32; i++) this.#xor[i] ^= bytes[i];
  }

  contentHash() {
    return sha256hex(HASH_DOMAIN + '\n' + this.#validCount + '\n' + this.#xor.toString('hex'));
  }

  // Full recompute from the event log; must always equal contentHash().
  recomputeContentHash() {
    const acc = Buffer.alloc(32);
    let count = 0;
    for (const rec of this.#events.values()) {
      if (rec.superseded) continue;
      const bytes = Buffer.from(rec.event.id, 'hex');
      for (let i = 0; i < 32; i++) acc[i] ^= bytes[i];
      count++;
    }
    return sha256hex(HASH_DOMAIN + '\n' + count + '\n' + acc.toString('hex'));
  }

  finalize() {
    // 1. Reference integrity: every CORRECT must reference a known event of
    //    the same item and batch (corrections may only touch qty/reason).
    for (const rec of this.#events.values()) {
      const event = rec.event;
      if (event.kind !== 'CORRECT') continue;
      const target = this.#events.get(event.ref);
      if (!target) {
        throw refError('CORRECT ' + event.id + ' references unknown event ' + event.ref);
      }
      if (target.event.item !== event.item || target.event.batch !== event.batch) {
        throw frameError('CORRECT ' + event.id + ' attempts to change item/batch of ' + event.ref);
      }
    }
    // 2. Correction graph must be acyclic.
    for (const rec of this.#events.values()) {
      if (rec.event.kind !== 'CORRECT') continue;
      const seen = new Set();
      let cur = rec.event;
      while (cur.kind === 'CORRECT') {
        if (seen.has(cur.id)) throw frameError('correction cycle detected at ' + cur.id);
        seen.add(cur.id);
        cur = this.#events.get(cur.ref).event;
      }
    }
    // 3. SCRAP terminal state: after a SCRAP (in lamport order) an item only
    //    accepts further SCRAP events or admin CORRECT events (reason=audit).
    for (const [item, ids] of this.#byItem) {
      const scraps = [];
      for (const id of ids) {
        const event = this.#events.get(id).event;
        if (event.kind === 'SCRAP') scraps.push(event);
      }
      if (scraps.length === 0) continue;
      for (const id of ids) {
        const event = this.#events.get(id).event;
        if (event.kind === 'SCRAP') continue;
        const afterScrap = scraps.some((scrap) => cmpEvents(scrap, event) < 0);
        if (!afterScrap) continue;
        if (event.kind === 'CORRECT' && event.reason === AUDIT_REASON) continue;
        throw terminalError(
          'event ' + event.id + ' (' + event.kind + ') violates SCRAP terminal state of item "' + item + '"'
        );
      }
    }
    this.#finalized = true;
    return this;
  }

  // The effective record of a root (non-CORRECT) event: the logically latest
  // valid correction in its correction tree, or the root itself.
  #effectiveRecord(rootEvent) {
    const validCorrections = [];
    const stack = [rootEvent.id];
    const seen = new Set([rootEvent.id]);
    while (stack.length > 0) {
      const cur = stack.pop();
      const kids = this.#children.get(cur);
      if (!kids) continue;
      for (const childId of kids) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const childRec = this.#events.get(childId);
        if (!childRec.superseded) validCorrections.push(childRec.event);
        stack.push(childId);
      }
    }
    if (validCorrections.length === 0) return rootEvent;
    validCorrections.sort(cmpEvents);
    return validCorrections[validCorrections.length - 1];
  }

  getItemState(item) {
    const ids = this.#byItem.get(item);
    if (!ids) return null;
    const roots = [];
    for (const id of ids) {
      const event = this.#events.get(id).event;
      if (event.kind !== 'CORRECT') roots.push(event);
    }
    if (roots.length === 0) return null;
    roots.sort(cmpEvents);
    const root = roots[roots.length - 1];
    const effective = this.#effectiveRecord(root);
    return {
      item,
      batch: root.batch,
      status: STATUS[root.kind],
      qty: effective.qty,
      reason: effective.reason,
      scrapped: root.kind === 'SCRAP',
      lamport: root.lamport,
      rootEvent: root.id,
      effectiveEvent: effective.id,
    };
  }

  items() {
    return [...this.#byItem.keys()].sort();
  }

  snapshot() {
    const items = {};
    for (const item of this.items()) {
      const state = this.getItemState(item);
      if (state) {
        items[item] = { status: state.status, qty: state.qty, reason: state.reason, batch: state.batch };
      }
    }
    return { items, validCount: this.#validCount, contentHash: this.contentHash() };
  }

  exportPackage() {
    if (!this.#finalized) this.finalize();
    const all = [...this.#events.values()].map((rec) => rec.event).sort(cmpEvents);
    const events = all.map((event) => ({ ...event, superseded: this.#events.get(event.id).superseded }));
    const validEvents = events.filter((event) => !event.superseded).map((event) => event.id);
    const supersededChains = [];
    for (const event of all) {
      if (event.kind === 'CORRECT') continue;
      const kids = this.#children.get(event.id);
      if (!kids || kids.size === 0) continue;
      const tree = [];
      const stack = [event.id];
      const seen = new Set([event.id]);
      while (stack.length > 0) {
        const cur = stack.pop();
        for (const childId of this.#children.get(cur) ?? []) {
          if (seen.has(childId)) continue;
          seen.add(childId);
          tree.push(this.#events.get(childId).event);
          stack.push(childId);
        }
      }
      tree.sort(cmpEvents);
      const chainIds = [event.id, ...tree.map((node) => node.id)];
      supersededChains.push({
        root: event.id,
        chain: chainIds,
        effective: this.#effectiveRecord(event).id,
        superseded: chainIds.filter((id) => this.#events.get(id).superseded),
      });
    }
    const items = {};
    for (const item of this.items()) {
      const state = this.getItemState(item);
      if (state) items[item] = state;
    }
    return {
      format: 'packline-trace/1',
      contentHash: this.contentHash(),
      validCount: this.#validCount,
      eventCount: this.#events.size,
      items,
      validEvents,
      supersededChains,
      events,
    };
  }
}

module.exports = { Engine, cmpEvents, AUDIT_REASON };
