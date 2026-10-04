'use strict';

const crypto = require('crypto');
const { canonicalize } = require('./canonical');
const { eventId } = require('./event');
const { FrameError, RefNotFoundError, TerminalViolationError } = require('./errors');

const KIND_TO_STATE = { PACK: 'PACKED', REWORK: 'REWORK', SCRAP: 'SCRAPPED' };
const HASH_BYTES = 32;

function compareEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.seq !== b.seq) return a.seq - b.seq;
  const ia = eventId(a);
  const ib = eventId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

// Canonical record hashed into the content hash. The hash state is a pure
// function of the ingested event set -- no hidden state beyond full recompute.
function recordForHash(event, status) {
  return {
    id: eventId(event),
    batch: event.batch,
    item: event.item,
    seq: event.seq,
    lamport: event.lamport,
    kind: event.kind,
    ref: event.ref,
    qty: event.qty,
    reason: event.reason,
    sig: event.sig,
    status,
  };
}

function hashRecord(event, status) {
  return crypto.createHash('sha256').update(canonicalize(recordForHash(event, status)), 'utf8').digest();
}

class Ledger {
  constructor() {
    this.events = new Map();      // id -> validated event
    this.correctors = new Map();  // refId -> Set of CORRECT event ids referencing it
    this.hashState = Buffer.alloc(HASH_BYTES); // XOR accumulator, updated incrementally
  }

  // Ingests a validated event. Duplicate delivery is idempotent.
  // Returns true if the event was new.
  ingest(event) {
    const id = eventId(event);
    const existing = this.events.get(id);
    if (existing) {
      if (canonicalize(existing) !== canonicalize(event)) {
        throw new FrameError(`conflicting events share id ${id}`);
      }
      return false; // duplicate: no state change, hash untouched
    }

    if (event.kind === 'CORRECT') {
      let set = this.correctors.get(event.ref);
      if (!set) { set = new Set(); this.correctors.set(event.ref, set); }
      const target = this.events.get(event.ref);
      if (target && set.size === 0) {
        // target flips effective -> superseded
        this.#xorOut(hashRecord(target, 'effective'));
        this.#xorIn(hashRecord(target, 'superseded'));
      }
      set.add(id);
    }

    this.events.set(id, event);
    const status = this.#isReferenced(id) ? 'superseded' : 'effective';
    this.#xorIn(hashRecord(event, status));
    return true;
  }

  #isReferenced(id) {
    const set = this.correctors.get(id);
    return !!set && set.size > 0;
  }

  #xorIn(digest) { for (let i = 0; i < HASH_BYTES; i++) this.hashState[i] ^= digest[i]; }
  #xorOut(digest) { this.#xorIn(digest); } // XOR is its own inverse

  // Incrementally maintained content hash.
  contentHash() {
    return this.hashState.toString('hex');
  }

  // Full recompute from the event set. Must always equal contentHash().
  recomputeHash() {
    const acc = Buffer.alloc(HASH_BYTES);
    for (const event of this.events.values()) {
      const status = this.#isReferenced(eventId(event)) ? 'superseded' : 'effective';
      const digest = hashRecord(event, status);
      for (let i = 0; i < HASH_BYTES; i++) acc[i] ^= digest[i];
    }
    return acc.toString('hex');
  }

  // Deterministic reduction of the current event set, ordered by (lamport, seq, id).
  // strict=true  -> throws RefNotFoundError (exit 9) / TerminalViolationError (exit 10)
  // strict=false -> unresolved CORRECTs are reported as pending instead of throwing
  finalize({ strict = true } = {}) {
    const byItem = new Map();
    for (const e of this.events.values()) {
      let list = byItem.get(e.item);
      if (!list) { list = []; byItem.set(e.item, list); }
      list.push(e);
    }

    const items = {};
    const validEvents = [];
    const supersededEvents = [];
    const supersededChains = [];
    const pending = [];

    for (const item of [...byItem.keys()].sort()) {
      const list = byItem.get(item).slice().sort(compareEvents);

      // --- validate corrections and build chain links ---
      const childOf = new Map(); // refId -> corrector event (valid ones only)
      for (const e of list) {
        if (e.kind !== 'CORRECT') continue;
        const target = e.ref ? this.events.get(e.ref) : null;
        if (!target) {
          if (strict) throw new RefNotFoundError(`CORRECT ${eventId(e)} references unknown event ${e.ref}`);
          pending.push(eventId(e));
          continue;
        }
        if (target.item !== e.item || target.batch !== e.batch) {
          throw new FrameError(`CORRECT ${eventId(e)} must not change item/batch of ${e.ref}`);
        }
        const refs = this.correctors.get(e.ref);
        if (refs && refs.size > 1) {
          throw new FrameError(`event ${e.ref} has multiple corrections; chain must be linear`);
        }
        childOf.set(e.ref, e);
      }

      // --- build chains rooted at non-CORRECT events ---
      const chainByMember = new Map(); // member event id -> chain
      const chains = [];
      for (const e of list) {
        if (e.kind === 'CORRECT') continue;
        const chain = { root: e, members: [e] };
        let cur = e;
        while (childOf.has(eventId(cur))) {
          cur = childOf.get(eventId(cur));
          chain.members.push(cur);
        }
        for (const m of chain.members) chainByMember.set(eventId(m), chain);
        chains.push(chain);
      }

      // --- terminal-state walk in canonical order ---
      let scrapped = false;
      let currentChain = null;
      for (const e of list) {
        if (e.kind === 'CORRECT') {
          if (!chainByMember.has(eventId(e))) continue; // pending (non-strict only)
          if (scrapped && e.reason !== 'audit') {
            throw new TerminalViolationError(
              `CORRECT ${eventId(e)} (reason=${e.reason}) rejected: item ${item} is in terminal SCRAP state`
            );
          }
        } else {
          if (scrapped) {
            throw new TerminalViolationError(
              `${e.kind} ${eventId(e)} rejected: item ${item} is in terminal SCRAP state`
            );
          }
          currentChain = chainByMember.get(eventId(e));
          scrapped = e.kind === 'SCRAP';
        }
      }

      // --- per-item final state ---
      let lastLamport = -1;
      for (const e of list) lastLamport = Math.max(lastLamport, e.lamport);
      if (currentChain) {
        const tip = currentChain.members[currentChain.members.length - 1];
        items[item] = {
          item,
          batch: currentChain.root.batch,
          state: KIND_TO_STATE[currentChain.root.kind],
          qty: tip.qty,
          reason: tip.reason,
          lastEventId: eventId(tip),
          lastLamport,
          eventCount: list.length,
          scrapped: currentChain.root.kind === 'SCRAP',
        };
      }

      // --- export views ---
      for (const chain of chains) {
        const tip = chain.members[chain.members.length - 1];
        validEvents.push({
          id: eventId(tip),
          kind: chain.root.kind,
          batch: chain.root.batch,
          item,
          seq: chain.root.seq,
          lamport: chain.root.lamport,
          qty: tip.qty,
          reason: tip.reason,
          corrections: chain.members.length - 1,
        });
        if (chain.members.length > 1) {
          supersededChains.push({
            root: eventId(chain.root),
            chain: chain.members.map(eventId),
            effective: eventId(tip),
          });
          for (let i = 0; i < chain.members.length - 1; i++) {
            const m = chain.members[i];
            supersededEvents.push({
              id: eventId(m),
              kind: m.kind,
              batch: m.batch,
              item: m.item,
              seq: m.seq,
              lamport: m.lamport,
              qty: m.qty,
              reason: m.reason,
              status: 'superseded',
              supersededBy: eventId(chain.members[i + 1]),
            });
          }
        }
      }
    }

    validEvents.sort((a, b) => a.lamport - b.lamport || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    supersededEvents.sort((a, b) => a.lamport - b.lamport || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    supersededChains.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));

    return { items, validEvents, supersededEvents, supersededChains, pending };
  }

  // Non-strict snapshot used to observe intermediate states during ingest.
  preview() {
    return this.finalize({ strict: false });
  }

  exportPackage() {
    const fin = this.finalize({ strict: true });
    return {
      version: 1,
      contentHash: this.contentHash(),
      eventCount: this.events.size,
      itemCount: Object.keys(fin.items).length,
      items: fin.items,
      validEvents: fin.validEvents,
      supersededEvents: fin.supersededEvents,
      supersededChains: fin.supersededChains,
    };
  }
}

module.exports = { Ledger, compareEvents, recordForHash, hashRecord, KIND_TO_STATE };
