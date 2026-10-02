import { recordHash, sha256hex } from './hash.js';
import { canonical } from './canon.js';

export class VerifyError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'VerifyError';
    this.exitCode = exitCode;
  }
}

export const EXIT_BROKEN_CHAIN = 15;
export const EXIT_LOW_EPOCH = 16;

function brokenChain(msg) {
  return new VerifyError(`broken chain: ${msg}`, EXIT_BROKEN_CHAIN);
}
function lowEpoch(msg) {
  return new VerifyError(`low-epoch backfill rejected: ${msg}`, EXIT_LOW_EPOCH);
}

const REQUIRED_FIELDS = ['v', 'site', 'seq', 'epoch', 'type', 'prev', 'vc', 'hash'];

// Validate structure + self-hash of every record. Dedupes by hash.
export function loadRecords(records) {
  const byHash = new Map();
  for (const rec of records) {
    for (const f of REQUIRED_FIELDS) {
      if (!(f in rec)) throw brokenChain(`record missing field ${f}`);
    }
    if (typeof rec.site !== 'string' || rec.site === '') throw brokenChain('bad site');
    if (!Number.isInteger(rec.seq) || rec.seq < 1) throw brokenChain('bad seq');
    if (!Number.isInteger(rec.epoch) || rec.epoch < 0) throw brokenChain('bad epoch');
    if (typeof rec.hash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.hash)) {
      throw brokenChain('bad hash format');
    }
    if (recordHash(rec) !== rec.hash) {
      throw brokenChain(`hash mismatch for record ${rec.hash.slice(0, 12)} (site ${rec.site} seq ${rec.seq})`);
    }
    if (byHash.has(rec.hash)) {
      const prev = byHash.get(rec.hash);
      if (canonical(prev) !== canonical(rec)) throw brokenChain(`conflicting records for hash ${rec.hash}`);
      continue; // exact duplicate from another input file
    }
    byHash.set(rec.hash, rec);
  }
  return byHash;
}

// Per-site chain checks: seq uniqueness, prev linkage, epoch monotonicity,
// exit-epoch rule. Returns { bySite, missing }.
export function checkChains(byHash) {
  const bySite = new Map();
  for (const rec of byHash.values()) {
    if (!bySite.has(rec.site)) bySite.set(rec.site, new Map());
    const seqs = bySite.get(rec.site);
    if (seqs.has(rec.seq)) {
      throw brokenChain(`duplicate seq ${rec.seq} at site ${rec.site}`);
    }
    seqs.set(rec.seq, rec);
  }

  const missing = [];
  const missingKey = new Set();
  const addMissing = (entry) => {
    const key = canonical(entry);
    if (!missingKey.has(key)) {
      missingKey.add(key);
      missing.push(entry);
    }
  };

  for (const [site, seqs] of bySite) {
    const maxSeq = Math.max(...seqs.keys());
    for (let s = 1; s <= maxSeq; s++) {
      if (!seqs.has(s)) addMissing({ kind: 'gap', site, seq: s });
    }
    const ordered = [...seqs.values()].sort((a, b) => a.seq - b.seq);
    let prevRec = null;
    let currentEpoch = 0;
    let exited = false;
    let exitEpoch = null;
    for (const rec of ordered) {
      if (rec.seq === 1) {
        if (rec.prev !== null) throw brokenChain(`genesis record at ${site} has non-null prev`);
      } else if (prevRec && rec.seq === prevRec.seq + 1) {
        if (rec.prev !== prevRec.hash) {
          throw brokenChain(`prev link mismatch at ${site} seq ${rec.seq}`);
        }
      } else if (prevRec) {
        // previous seq is a known gap: the prev pointer references a record we
        // do not hold. That is a missing record, not a broken chain.
        addMissing({ kind: 'prev', site, seq: rec.seq, hash: rec.prev });
      }
      if (rec.epoch < currentEpoch) {
        throw lowEpoch(`site ${site} seq ${rec.seq}: epoch ${rec.epoch} < current epoch ${currentEpoch}`);
      }
      if (exited && rec.epoch <= exitEpoch) {
        throw lowEpoch(`site ${site} seq ${rec.seq}: epoch ${rec.epoch} <= exit epoch ${exitEpoch}`);
      }
      currentEpoch = rec.epoch;
      if (rec.type === 'exit') {
        exited = true;
        exitEpoch = rec.epoch;
      }
      prevRec = rec;
    }
  }

  // Vector-clock references to sites/records we do not hold at all.
  for (const rec of byHash.values()) {
    for (const [site, n] of Object.entries(rec.vc)) {
      const seqs = bySite.get(site);
      for (let s = 1; s <= n; s++) {
        if (!seqs || !seqs.has(s)) addMissing({ kind: 'vc', site, seq: s });
      }
    }
    if (rec.type === 'revoke' && !byHash.has(rec.target)) {
      addMissing({ kind: 'target', hash: rec.target });
    }
  }

  return { bySite, missing };
}

// Deterministic causal order: Kahn's algorithm, ties broken by smallest hash.
export function causalOrder(byHash) {
  const deps = new Map(); // hash -> Set of hashes it depends on
  const users = new Map(); // hash -> Set of hashes depending on it
  for (const rec of byHash.values()) {
    const d = new Set();
    if (rec.prev !== null && byHash.has(rec.prev)) d.add(rec.prev);
    if (rec.type === 'revoke' && byHash.has(rec.target)) d.add(rec.target);
    for (const [site, n] of Object.entries(rec.vc)) {
      for (const other of byHash.values()) {
        if (other.site === site && other.seq === n) d.add(other.hash);
      }
    }
    d.delete(rec.hash);
    deps.set(rec.hash, d);
  }
  for (const [h, d] of deps) {
    for (const dep of d) {
      if (!users.has(dep)) users.set(dep, new Set());
      users.get(dep).add(h);
    }
  }
  const ready = [...byHash.keys()].filter((h) => deps.get(h).size === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const h = ready.shift();
    order.push(h);
    for (const user of users.get(h) || []) {
      const d = deps.get(user);
      d.delete(h);
      if (d.size === 0) {
        // insert keeping `ready` sorted by hash
        const i = ready.findIndex((x) => x > user);
        if (i === -1) ready.push(user);
        else ready.splice(i, 0, user);
      }
    }
  }
  if (order.length !== byHash.size) {
    throw brokenChain('causal cycle detected');
  }
  return order.map((h) => byHash.get(h));
}

// Tombstone semantics. A revoke shadows its target. A revoke of a revoke cancels
// it only when issued at a strictly higher epoch; otherwise it is inert.
// Shadowed records stay in the log and remain auditable.
export function computeShadowed(ordered, byHash) {
  const active = new Map(); // revoke hash -> { epoch, target }
  for (const rec of ordered) {
    if (rec.type !== 'revoke') continue;
    const target = byHash.get(rec.target);
    if (target && target.type === 'revoke' && active.has(target.hash)) {
      if (rec.epoch > target.epoch) {
        active.delete(target.hash); // cancel the older revoke
      } else {
        continue; // inert: same-or-lower epoch cannot revoke a revoke
      }
    }
    active.set(rec.hash, { epoch: rec.epoch, target: rec.target });
  }
  const shadowed = new Set();
  for (const { target } of active.values()) {
    if (byHash.has(target)) shadowed.add(target);
  }
  return [...shadowed].sort();
}

// Full verification. Returns the certificate.
export function verify(records) {
  const byHash = loadRecords(records);
  const { bySite, missing } = checkChains(byHash);
  const ordered = causalOrder(byHash);
  const shadowed = computeShadowed(ordered, byHash);

  const sites = {};
  for (const [site, seqs] of [...bySite.entries()].sort()) {
    const recs = [...seqs.values()];
    const maxEpoch = Math.max(...recs.map((r) => r.epoch));
    const exitRec = recs.filter((r) => r.type === 'exit').pop();
    sites[site] = {
      count: recs.length,
      maxSeq: Math.max(...recs.map((r) => r.seq)),
      maxEpoch,
      exited: Boolean(exitRec),
      exitEpoch: exitRec ? exitRec.epoch : null,
    };
  }

  missing.sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);
  const head = sha256hex(canonical(ordered.map((r) => r.hash)));
  return {
    head,
    count: ordered.length,
    sites,
    missing,
    shadowed,
    // Missing data means we cannot judge compliance: unknown, never failure.
    status: missing.length > 0 ? 'unknown' : 'ok',
  };
}
