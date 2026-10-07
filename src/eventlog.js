// Append-only event log with undo / correct and an incremental history hash.
//
// The history hash is a homomorphic multiset hash (LtHash-style):
//   H = sum of sha256(canonical(effectiveEvent)) mod 2^256
// Undo removes one term, correct swaps one term, so both are O(1) and never
// trigger recomputation of the prefix (stats.hashRecomputations stays 0,
// far below the N=2000 full-recompute budget).

import { createHash } from 'node:crypto';
import { parseNumDen, toString as ratToString } from './rational.js';

export class CodedError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const OPS = ['addInvoice', 'setRate', 'correct', 'undo'];
const CCY_RE = /^[A-Z0-9]{2,8}$/;
const PAIR_RE = /^([A-Z0-9]{2,8})\/([A-Z0-9]{2,8})$/;
const MOD = 1n << 256n;

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
      .join(',') +
    '}'
  );
}

function assertString(x, name) {
  if (typeof x !== 'string' || x.length === 0)
    throw new Error(`field "${name}" must be a non-empty string`);
}

// Parses one JSONL line into an internal event. Throws CodedError E_PARSE.
export function parseEvent(line, lineno) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    throw new CodedError('E_PARSE', `line ${lineno}: invalid JSON: ${e.message}`, { line: lineno });
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
    throw new CodedError('E_PARSE', `line ${lineno}: event must be an object`, { line: lineno });

  let op, fields;
  if (typeof obj.op === 'string') {
    op = obj.op;
    const { op: _drop, ...rest } = obj;
    fields = rest;
  } else {
    const keys = Object.keys(obj).filter((k) => OPS.includes(k));
    if (keys.length !== 1 || Object.keys(obj).length !== 1)
      throw new CodedError('E_PARSE', `line ${lineno}: cannot determine event op`, { line: lineno });
    op = keys[0];
    fields = obj[op];
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields))
      throw new CodedError('E_PARSE', `line ${lineno}: payload must be an object`, { line: lineno });
  }
  if (!OPS.includes(op))
    throw new CodedError('E_PARSE', `line ${lineno}: unknown op "${op}"`, { line: lineno });

  const eid = `evt:${lineno}`;
  try {
    switch (op) {
      case 'addInvoice': {
        const { id, ccy, num, den } = fields;
        assertString(id, 'id');
        assertString(ccy, 'ccy');
        if (!CCY_RE.test(ccy)) throw new Error(`bad currency code "${ccy}"`);
        const amount = parseNumDen(num, den ?? 1);
        return { eid, lineno, type: 'addInvoice', id, ccy, amount };
      }
      case 'setRate': {
        const { pair, num, den } = fields;
        assertString(pair, 'pair');
        const m = PAIR_RE.exec(pair);
        if (!m) throw new Error(`pair must look like "USD/CNY", got "${pair}"`);
        const rate = parseNumDen(num, den ?? 1);
        if (rate.n <= 0n) throw new Error('rate must be positive');
        return { eid, lineno, type: 'setRate', pair, from: m[1], to: m[2], rate };
      }
      case 'correct': {
        const { refId, newNum, newDen } = fields;
        assertString(refId, 'refId');
        const amount = parseNumDen(newNum, newDen ?? 1);
        return { eid, lineno, type: 'correct', refId, amount };
      }
      case 'undo': {
        const { eventId } = fields;
        assertString(eventId, 'eventId');
        return { eid, lineno, type: 'undo', eventId };
      }
    }
  } catch (e) {
    if (e instanceof CodedError) throw e;
    throw new CodedError('E_PARSE', `line ${lineno}: ${e.message}`, { line: lineno });
  }
}

// Canonical string of an effective (post-correction) event, for hashing.
function canonicalOf(eff) {
  const base = { eid: eff.eid, type: eff.type };
  if (eff.type === 'addInvoice') {
    base.id = eff.id;
    base.ccy = eff.ccy;
    base.amount = ratToString(eff.amount);
  } else {
    base.pair = eff.pair;
    base.rate = ratToString(eff.rate);
  }
  return stableStringify(base);
}

function hashTerm(eff) {
  return BigInt('0x' + sha256hex(canonicalOf(eff)));
}

export class EventLog {
  constructor() {
    this.entries = []; // every appended event, in order
    this.byEid = new Map();
    this.byInvoiceId = new Map();
    this.active = new Map(); // eid -> bool
    this.corrections = new Map(); // target eid -> [{ correctEid, amount }]
    this.effective = []; // effective addInvoice/setRate entries, lineno order
    this.headBig = 0n; // multiset hash of effective events
    this.hashTrail = []; // head (hex) after every appended raw event
    this.stats = { appended: 0, undone: 0, corrected: 0, hashRecomputations: 0 };
  }

  get head() {
    return this.headBig.toString(16).padStart(64, '0');
  }

  resolve(ref) {
    if (this.byEid.has(ref)) return this.byEid.get(ref);
    if (this.byInvoiceId.has(ref)) return this.byInvoiceId.get(ref);
    if (PAIR_RE.test(ref)) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (e.type === 'setRate' && e.pair === ref && this.active.get(e.eid)) return e;
      }
    }
    return undefined;
  }

  append(evt) {
    switch (evt.type) {
      case 'addInvoice': {
        if (this.byInvoiceId.has(evt.id))
          throw new CodedError('E_REF', `duplicate invoice id "${evt.id}"`);
        break;
      }
      case 'correct': {
        const target = this.resolve(evt.refId);
        if (!target || !this.active.get(target.eid))
          throw new CodedError('E_REF', `correct: unknown or inactive refId "${evt.refId}"`);
        if (target.type !== 'addInvoice' && target.type !== 'setRate')
          throw new CodedError('E_REF', `correct: "${evt.refId}" is not an invoice or rate`);
        if (target.type === 'setRate' && evt.amount.n <= 0n)
          throw new CodedError('E_PARSE', `correct: rate must be positive`);
        evt.targetEid = target.eid;
        break;
      }
      case 'undo': {
        const target = this.resolve(evt.eventId);
        if (!target)
          throw new CodedError('E_REF', `undo: unknown eventId "${evt.eventId}"`);
        if (!this.active.get(target.eid))
          throw new CodedError('E_REF', `undo: event "${evt.eventId}" is already undone`);
        evt.targetEid = target.eid;
        break;
      }
    }

    this.entries.push(evt);
    this.byEid.set(evt.eid, evt);
    this.active.set(evt.eid, true);
    if (evt.type === 'addInvoice') this.byInvoiceId.set(evt.id, evt);

    if (evt.type === 'addInvoice' || evt.type === 'setRate') {
      this._insertEffective(evt);
    } else if (evt.type === 'correct') {
      this.stats.corrected++;
      const list = this.corrections.get(evt.targetEid) ?? [];
      list.push({ correctEid: evt.eid, amount: evt.amount });
      this.corrections.set(evt.targetEid, list);
      this._refreshEffective(evt.targetEid);
    } else if (evt.type === 'undo') {
      this.stats.undone++;
      this._deactivate(this.byEid.get(evt.targetEid));
    }

    this.stats.appended++;
    this.hashTrail.push(this.head);
    return evt;
  }

  _effectivePayload(entry) {
    const eff = { eid: entry.eid, lineno: entry.lineno, type: entry.type };
    let override;
    for (const c of this.corrections.get(entry.eid) ?? []) {
      if (this.active.get(c.correctEid)) override = c.amount;
    }
    if (entry.type === 'addInvoice') {
      eff.id = entry.id;
      eff.ccy = entry.ccy;
      eff.amount = override ?? entry.amount;
    } else {
      eff.pair = entry.pair;
      eff.from = entry.from;
      eff.to = entry.to;
      eff.rate = override ?? entry.rate;
    }
    return eff;
  }

  _insertEffective(entry) {
    const eff = this._effectivePayload(entry);
    let i = this.effective.length;
    while (i > 0 && this.effective[i - 1].lineno > entry.lineno) i--;
    this.effective.splice(i, 0, eff);
    this.headBig = (this.headBig + hashTerm(eff)) % MOD;
  }

  _removeEffective(eid) {
    const i = this.effective.findIndex((e) => e.eid === eid);
    if (i < 0) return;
    this.headBig = (this.headBig - hashTerm(this.effective[i]) + MOD) % MOD;
    this.effective.splice(i, 1);
  }

  _refreshEffective(eid) {
    const i = this.effective.findIndex((e) => e.eid === eid);
    if (i < 0) return; // target currently inactive: payload recomputed on reactivation
    const oldTerm = hashTerm(this.effective[i]);
    const fresh = this._effectivePayload(this.byEid.get(eid));
    this.effective[i] = fresh;
    this.headBig = (this.headBig - oldTerm + hashTerm(fresh) + MOD) % MOD;
  }

  _deactivate(entry) {
    this.active.set(entry.eid, false);
    if (entry.type === 'addInvoice' || entry.type === 'setRate') {
      this._removeEffective(entry.eid);
    } else if (entry.type === 'correct') {
      this._refreshEffective(entry.targetEid);
    } else if (entry.type === 'undo') {
      // Undoing an undo reactivates its target.
      const target = this.byEid.get(entry.targetEid);
      this.active.set(target.eid, true);
      if (target.type === 'addInvoice' || target.type === 'setRate') {
        this._insertEffective(target);
      } else if (target.type === 'correct') {
        this._refreshEffective(target.targetEid);
      }
    }
  }

  invoices() {
    return this.effective.filter((e) => e.type === 'addInvoice');
  }

  rates() {
    return this.effective.filter((e) => e.type === 'setRate');
  }
}

// Loads a JSONL file text into an EventLog.
export function loadLog(text) {
  const log = new EventLog();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    log.append(parseEvent(lines[i], i + 1));
  }
  return log;
}

export function partyOf(invoiceId) {
  const i = invoiceId.indexOf(':');
  return i < 0 ? invoiceId : invoiceId.slice(0, i);
}

// Recomputes the history hash from scratch over the effective events.
// Auditors (and tests) can cross-check the incrementally maintained head.
export function referenceHash(effectiveEvents) {
  let h = 0n;
  for (const e of effectiveEvents) h = (h + hashTerm(e)) % MOD;
  return h.toString(16).padStart(64, '0');
}
