'use strict';

const crypto = require('node:crypto');

const KINDS = new Set(['produce', 'split', 'merge', 'correct']);
const SEP = '\u001f';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

class ConservationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConservationError';
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function validateEvent(raw, lineNo) {
  const where = Number.isInteger(lineNo) ? `line ${lineNo}: ` : '';
  const bad = (msg) => new InputError(where + msg);
  if (!isPlainObject(raw)) throw bad('event must be a JSON object');
  for (const f of ['lot', 'mold', 'station']) {
    if (typeof raw[f] !== 'string' || raw[f].length === 0) throw bad(`${f} must be a non-empty string`);
  }
  if (!Number.isInteger(raw.seq) || raw.seq < 1) throw bad('seq must be an integer >= 1');
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) || raw.ts < 0) throw bad('ts must be a finite number >= 0');
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) throw bad(`kind must be one of ${[...KINDS].join(',')}`);
  if (!isNonNegInt(raw.qty)) throw bad('qty must be a non-negative integer');
  if (raw.kind === 'produce' && raw.qty === 0) throw bad('produce qty must be > 0');
  if (typeof raw.hash !== 'string' || raw.hash.length === 0) throw bad('hash must be a non-empty string');

  let parents = [];
  if (raw.parents !== undefined) {
    if (!Array.isArray(raw.parents) || raw.parents.some((p) => !Number.isInteger(p) || p < 1)) {
      throw bad('parents must be an array of integers >= 1');
    }
    parents = [...new Set(raw.parents)].sort((a, b) => a - b);
    if (parents.some((p) => p >= raw.seq)) throw bad('every parent seq must be < seq');
  }
  if (raw.kind === 'merge' && parents.length < 2) throw bad('merge requires >= 2 parents');
  if (raw.kind === 'split' && parents.length !== 1) throw bad('split requires exactly 1 parent');

  const future = raw.future === undefined ? false : raw.future;
  if (typeof future !== 'boolean') throw bad('future must be a boolean');

  let target = null;
  if (raw.kind === 'correct') {
    if (!Number.isInteger(raw.target) || raw.target < 1) throw bad('correct requires integer target >= 1');
    if (raw.target === raw.seq) throw bad('correct target must differ from its own seq');
    target = raw.target;
  } else if (raw.target !== undefined) {
    throw bad('target is only allowed for kind=correct');
  }

  return {
    lot: raw.lot,
    mold: raw.mold,
    station: raw.station,
    seq: raw.seq,
    ts: raw.ts,
    kind: raw.kind,
    qty: raw.qty,
    hash: raw.hash,
    parents,
    future,
    target,
  };
}

const streamKey = (e) => [e.lot, e.mold, e.station].join(SEP);
const lotMoldKey = (e) => [e.lot, e.mold].join(SEP);

class EventCache {
  constructor({ now = 0, deadline = 1000 } = {}) {
    if (typeof now !== 'number' || !Number.isFinite(now)) throw new InputError('now must be a finite number');
    if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) {
      throw new InputError('deadline must be a finite number > 0');
    }
    this.now = now;
    this.deadline = deadline;
    this.streams = new Map(); // streamKey -> Map(seq -> event)
    this.corrections = [];
    this.stats = { added: 0, duplicates: 0, conflicts: 0 };
  }

  ingest(event) {
    if (event.kind === 'correct') {
      this.corrections.push(event);
      return 'correction';
    }
    const key = streamKey(event);
    let stream = this.streams.get(key);
    if (!stream) {
      stream = new Map();
      this.streams.set(key, stream);
    }
    const existing = stream.get(event.seq);
    if (existing) {
      if (existing.hash === event.hash) {
        this.stats.duplicates += 1;
        return 'duplicate';
      }
      this.stats.conflicts += 1;
      return 'conflict'; // keep first; kind=correct is the only rewrite path
    }
    stream.set(event.seq, event);
    this.stats.added += 1;
    return 'added';
  }

  // Missing interior seqs per stream. A missing seq becomes a gap once
  // now - refTs >= deadline (boundary inclusive); before that it is NAKed.
  missingSeqs() {
    const gaps = [];
    const naks = [];
    for (const [key, stream] of this.streams) {
      const seqs = [...stream.keys()].sort((a, b) => a - b);
      const [lot, mold, station] = key.split(SEP);
      const min = seqs[0];
      const max = seqs[seqs.length - 1];
      for (let s = min + 1; s < max; s += 1) {
        if (stream.has(s)) continue;
        let refTs = null;
        for (let p = s - 1; p >= min; p -= 1) {
          if (stream.has(p)) { refTs = stream.get(p).ts; break; }
        }
        if (refTs === null) {
          for (let p = s + 1; p <= max; p += 1) {
            if (stream.has(p)) { refTs = stream.get(p).ts; break; }
          }
        }
        const entry = { lot, mold, station, seq: s, refTs, waited: this.now - refTs };
        if (this.now - refTs >= this.deadline) gaps.push(entry);
        else naks.push(entry);
      }
    }
    const ord = (a, b) =>
      a.lot.localeCompare(b.lot) || a.mold.localeCompare(b.mold) ||
      a.station.localeCompare(b.station) || a.seq - b.seq;
    gaps.sort(ord);
    naks.sort(ord);
    return { gaps, naks };
  }

  // Canonical chain: events grouped by lot, topologically ordered by valid seq
  // (parents always carry a smaller seq, so seq order is the topological order).
  buildChains() {
    const byLotMold = new Map(); // lotMoldKey -> events[]
    for (const stream of this.streams.values()) {
      for (const e of stream.values()) {
        const key = lotMoldKey(e);
        if (!byLotMold.has(key)) byLotMold.set(key, []);
        byLotMold.get(key).push(e);
      }
    }
    const chains = new Map(); // lot -> events[]
    for (const events of byLotMold.values()) {
      events.sort((a, b) => a.seq - b.seq || a.station.localeCompare(b.station));
      const lot = events[0].lot;
      if (!chains.has(lot)) chains.set(lot, []);
      chains.get(lot).push(...events);
    }
    for (const events of chains.values()) {
      events.sort((a, b) =>
        a.mold.localeCompare(b.mold) || a.seq - b.seq || a.station.localeCompare(b.station));
    }
    return chains;
  }

  checkConservation(chains) {
    for (const [lot, events] of chains) {
      const byKey = new Map();
      for (const e of events) byKey.set(`${e.mold}${SEP}${e.seq}`, e);
      const childrenOf = new Map(); // parentKey -> child events
      for (const e of events) {
        for (const p of e.parents) {
          const pk = `${e.mold}${SEP}${p}`;
          if (!byKey.has(pk)) continue; // parent lost to a gap: cannot verify, skip
          if (!childrenOf.has(pk)) childrenOf.set(pk, []);
          childrenOf.get(pk).push(e);
        }
      }
      for (const [pk, kids] of childrenOf) {
        const parent = byKey.get(pk);
        const merges = kids.filter((k) => k.parents.length > 1);
        if (merges.length > 0) {
          if (kids.length !== 1) {
            throw new ConservationError(
              `lot ${lot} mold ${parent.mold} seq ${parent.seq}: merge child must be the sole child`);
          }
          const m = merges[0];
          const sum = m.parents.reduce((acc, p) => {
            const pe = byKey.get(`${m.mold}${SEP}${p}`);
            return pe ? acc + pe.qty : acc;
          }, 0);
          if (m.qty !== sum) {
            throw new ConservationError(
              `lot ${lot} mold ${m.mold} seq ${m.seq}: merge qty ${m.qty} != sum of parents ${sum}`);
          }
        } else {
          const sum = kids.reduce((acc, k) => acc + k.qty, 0);
          if (sum !== parent.qty) {
            throw new ConservationError(
              `lot ${lot} mold ${parent.mold} seq ${parent.seq}: children qty sum ${sum} != parent qty ${parent.qty}`);
          }
        }
      }
    }
  }

  applyCorrection(corr) {
    const key = [corr.lot, corr.mold, corr.station].join(SEP);
    const stream = this.streams.get(key);
    const target = stream ? stream.get(corr.target) : undefined;
    if (!target) return { applied: false, reason: 'target not found' };
    if (target.future) return { applied: false, reason: 'target is future=true' };
    const replaced = {
      ...target,
      qty: corr.qty,
      ts: corr.ts,
      hash: corr.hash,
      parents: corr.parents.length > 0 ? corr.parents : target.parents,
    };
    stream.set(target.seq, replaced);
    return { applied: true, target: target.seq, lot: target.lot };
  }
}

function certPayload(events) {
  return events.map((e) => ({
    lot: e.lot, mold: e.mold, station: e.station, seq: e.seq,
    kind: e.kind, qty: e.qty, hash: e.hash, parents: e.parents, future: e.future,
  }));
}

function run(events, { now = 0, deadline = 1000 } = {}) {
  const cache = new EventCache({ now, deadline });
  for (const e of events) cache.ingest(e);

  const certificates = [];
  const corrections = [];
  const versionByLot = new Map();

  const issueForLot = (lot, reason) => {
    const chains = cache.buildChains();
    const evts = chains.get(lot) || [];
    const version = (versionByLot.get(lot) || 0) + 1;
    versionByLot.set(lot, version);
    for (const c of certificates) {
      if (c.lot === lot && c.status === 'active') c.status = 'revoked';
    }
    certificates.push({
      lot,
      version,
      certHash: sha256(canonical({ lot, version, chain: certPayload(evts) })),
      status: 'active',
      reason,
      issuedAt: now,
    });
  };

  const initialChains = cache.buildChains();
  cache.checkConservation(initialChains);
  for (const lot of [...initialChains.keys()].sort()) issueForLot(lot, 'initial');

  const orderedCorrections = [...cache.corrections].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  for (const corr of orderedCorrections) {
    const res = cache.applyCorrection(corr);
    corrections.push({ seq: corr.seq, target: corr.target, lot: corr.lot, ...res });
    if (res.applied) issueForLot(res.lot, `correction seq=${corr.seq} target=${corr.target}`);
  }

  const chains = cache.buildChains();
  cache.checkConservation(chains);
  const chain = [];
  for (const lot of [...chains.keys()].sort()) {
    for (const e of chains.get(lot)) {
      chain.push({
        lot: e.lot, mold: e.mold, station: e.station, seq: e.seq, ts: e.ts,
        kind: e.kind, qty: e.qty, hash: e.hash, parents: e.parents, future: e.future,
      });
    }
  }

  const { gaps, naks } = cache.missingSeqs();
  return {
    now,
    deadline,
    stats: cache.stats,
    chain,
    gaps,
    naks,
    certificates,
    corrections,
  };
}

function parseJsonl(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      throw new InputError(`line ${i + 1}: invalid JSON: ${err.message}`);
    }
    events.push(validateEvent(raw, i + 1));
  });
  return events;
}

module.exports = {
  KINDS,
  InputError,
  ConservationError,
  canonical,
  sha256,
  validateEvent,
  EventCache,
  run,
  parseJsonl,
};
