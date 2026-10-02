// auditdb — bitemporal audit ledger core.
//
// Event shape (JSONL, one per line):
//   { id?, account, txSeq, validFrom, validTo|null, payload: {amount?, limit?}, supersedes? }
// Tombstone (delete request, append-only):
//   { id?, account, txSeq, tombstone: true, supersedes: <eventId> }
//
// Bitemporal semantics expressed relationally:
//   visible(e, T_valid, T_tx)  =  σ_asOf ⋉̸ σ_superseded
//   σ_asOf:      validFrom <= T_valid AND (validTo IS NULL OR validTo > T_valid)
//                AND txSeq <= T_tx
//   anti-join:   no superseding event s exists with s.supersedes = e.id AND s.txSeq <= T_tx
// Corrections never mutate old rows; a later correction "closes" a NULL validTo
// purely through the anti-join, so history stays auditable.

export const E_TIME_ORDER = 'E_TIME_ORDER';
export const E_TOMBSTONE = 'E_TOMBSTONE';
export const E_SUPERSEDES = 'E_SUPERSEDES';
export const E_TX_SEQ = 'E_TX_SEQ';
export const E_DUP_ID = 'E_DUP_ID';
export const E_SCHEMA = 'E_SCHEMA';

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

export function parseTime(value, field) {
  if (typeof value !== 'string') {
    throw new AuditError(E_SCHEMA, `${field} must be an ISO-8601 string, got ${JSON.stringify(value)}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new AuditError(E_SCHEMA, `${field} is not a valid timestamp: ${value}`);
  }
  return ms;
}

let autoId = 0;

export function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuditError(E_SCHEMA, 'event must be an object');
  }
  const e = { ...raw };
  if (typeof e.account !== 'string' || e.account.length === 0) {
    throw new AuditError(E_SCHEMA, 'event.account must be a non-empty string');
  }
  if (!Number.isInteger(e.txSeq)) {
    throw new AuditError(E_SCHEMA, 'event.txSeq must be an integer');
  }
  if (e.id == null) e.id = `evt-${++autoId}`;
  if (typeof e.id !== 'string') e.id = String(e.id);

  e.tombstone = e.tombstone === true;
  e.supersedes = e.supersedes == null ? null : String(e.supersedes);

  if (e.tombstone) {
    // A delete request is only a marker; it carries no business payload.
    e.validFromMs = null;
    e.validToMs = null;
    e.payload = null;
  } else {
    e.validFromMs = parseTime(e.validFrom, 'validFrom');
    e.validToMs = e.validTo == null ? null : parseTime(e.validTo, 'validTo');
    if (e.validToMs !== null && e.validToMs <= e.validFromMs) {
      throw new AuditError(
        E_TIME_ORDER,
        `validTo (${e.validTo}) must be after validFrom (${e.validFrom}) for event ${e.id}`,
      );
    }
    if (e.payload == null) e.payload = {};
    if (typeof e.payload !== 'object' || Array.isArray(e.payload)) {
      throw new AuditError(E_SCHEMA, 'event.payload must be an object');
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// Relational algebra primitives
// ---------------------------------------------------------------------------

// Selection σ
export function select(rows, predicate) {
  const out = [];
  for (const row of rows) if (predicate(row)) out.push(row);
  return out;
}

// Bitemporal selection predicate σ(validFrom <= T < validTo, txSeq <= N)
export function asOfPredicate(validTimeMs, txSeq) {
  return (e) =>
    !e.tombstone &&
    e.txSeq <= txSeq &&
    e.validFromMs <= validTimeMs &&
    (e.validToMs === null || e.validToMs > validTimeMs);
}

// Anti-join ⋉̸ : drop rows whose id was superseded at or before the query txSeq.
export function antiJoinSuperseded(rows, supersededIds) {
  return select(rows, (e) => !supersededIds.has(e.id));
}

// Aggregates: sum ignores NULL amount/limit; count counts versions.
export function aggregate(rows) {
  let balance = 0;
  let limitUsed = 0;
  let versions = 0;
  for (const e of rows) {
    versions += 1;
    const amount = e.payload?.amount;
    const limit = e.payload?.limit;
    if (amount != null) balance += amount;
    if (limit != null) limitUsed += limit;
  }
  return { balance, limitUsed, versions };
}

// ---------------------------------------------------------------------------
// Store: append-only log + incremental per-account version-chain index
// ---------------------------------------------------------------------------

export class AuditStore {
  constructor() {
    this.events = [];          // full append-only log (incl. tombstones)
    this.byAccount = new Map(); // account -> versions in txSeq order (the index)
    this.byId = new Map();      // id -> event
    this.supersededBy = new Map(); // superseded id -> superseding event id
    this.lastTxSeq = null;
    this.stats = { scanned: 0 }; // candidate rows touched by indexed queries
  }

  append(raw) {
    const e = normalizeEvent(raw);

    if (this.lastTxSeq !== null && e.txSeq <= this.lastTxSeq) {
      throw new AuditError(E_TX_SEQ, `txSeq must strictly increase (last=${this.lastTxSeq}, got ${e.txSeq})`);
    }
    if (this.byId.has(e.id)) {
      throw new AuditError(E_DUP_ID, `duplicate event id ${e.id}`);
    }
    if (e.tombstone && e.supersedes === null) {
      throw new AuditError(E_TOMBSTONE, `tombstone ${e.id} must supersede an existing event`);
    }
    if (e.supersedes !== null) {
      const target = this.byId.get(e.supersedes);
      if (target === undefined) {
        throw new AuditError(
          e.tombstone ? E_TOMBSTONE : E_SUPERSEDES,
          `${e.tombstone ? 'tombstone' : 'event'} ${e.id} supersedes unknown event ${e.supersedes}`,
        );
      }
      if (target.tombstone) {
        throw new AuditError(E_TOMBSTONE, `event ${e.id} supersedes tombstone ${target.id}`);
      }
      if (this.supersededBy.has(target.id)) {
        throw new AuditError(
          e.tombstone ? E_TOMBSTONE : E_SUPERSEDES,
          `event ${target.id} is already superseded by ${this.supersededBy.get(target.id)}`,
        );
      }
      if (target.account !== e.account) {
        throw new AuditError(E_SUPERSEDES, `event ${e.id} supersedes event of a different account`);
      }
    }

    // Append-only: old versions are never mutated or removed.
    this.events.push(e);
    this.byId.set(e.id, e);
    if (e.supersedes !== null) this.supersededBy.set(e.supersedes, e.id);
    let chain = this.byAccount.get(e.account);
    if (chain === undefined) {
      chain = [];
      this.byAccount.set(e.account, chain);
    }
    chain.push(e); // txSeq strictly increases => chain stays tx-ordered
    this.lastTxSeq = e.txSeq;
    return e;
  }

  // Indexed asOf query: only walks the account's version chain, never the full log.
  asOf(account, validTime, txSeq) {
    const validTimeMs = parseTime(validTime, 'validTime');
    if (!Number.isInteger(txSeq)) {
      throw new AuditError(E_SCHEMA, 'txSeq must be an integer');
    }
    const chain = this.byAccount.get(account) ?? [];
    this.stats.scanned += chain.length;

    const superseded = new Set();
    for (const e of chain) {
      if (e.supersedes !== null && e.txSeq <= txSeq) superseded.add(e.supersedes);
    }
    const rows = antiJoinSuperseded(select(chain, asOfPredicate(validTimeMs, txSeq)), superseded);
    return aggregate(rows);
  }

  toJSON() {
    return { events: this.events };
  }

  static fromJSON(data) {
    const store = new AuditStore();
    for (const raw of data.events ?? []) store.append(raw);
    return store;
  }
}
