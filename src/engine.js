// Payment mid-platform event engine.
// Ops: init, freeze, capture, void, reverse, branch, merge, rollback, use.
// Invariant: frozen + captured <= limit  (available balance never negative).

import { Frac, roundHalfEvenCents } from './rational.js';

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export const E_PARSE = 'E_PARSE', E_REF = 'E_REF', E_STATE = 'E_STATE', E_IO = 'E_IO';

const OPS = new Set(['init', 'freeze', 'capture', 'void', 'reverse', 'branch', 'merge', 'rollback', 'use']);

function parseAmt(v, field) {
  try { return Frac.parse(v); }
  catch { throw new AppError(E_PARSE, `invalid amount for ${field}: ${JSON.stringify(v)}`); }
}

function freshState() { return { holds: new Map(), captures: new Map(), frozen: Frac.zero(), captured: Frac.zero() }; }

export function snapshotState(st, limit) {
  const holds = {}, captures = {};
  for (const [k, v] of st.holds) holds[k] = v.toString();
  for (const [k, v] of st.captures) captures[k] = { tx: v.tx, exact: v.exact.toString(), settled: v.settled.toString() };
  return {
    limit: limit.toString(),
    frozen: st.frozen.toString(),
    captured: st.captured.toString(),
    available: limit.sub(st.frozen).sub(st.captured).toString(),
    holds, captures,
  };
}

// Mutates st. Throws AppError on any violated rule; on throw, st may be
// partially read but is never mutated before all checks pass.
function applyData(limit, st, ev) {
  switch (ev.op) {
    case 'freeze': {
      if (st.holds.has(ev.tx)) throw new AppError(E_STATE, `duplicate hold tx ${ev.tx}`);
      const amt = parseAmt(ev.amt, 'amt');
      if (amt.sign() <= 0) throw new AppError(E_STATE, 'freeze amount must be positive');
      const avail = limit.sub(st.frozen).sub(st.captured);
      if (amt.cmp(avail) > 0) {
        throw new AppError(E_STATE, 'freeze exceeds available', { available: avail.toString(), requested: amt.toString() });
      }
      st.holds.set(ev.tx, amt);
      st.frozen = st.frozen.add(amt);
      return;
    }
    case 'capture': {
      const hold = st.holds.get(ev.tx);
      if (!hold) throw new AppError(E_REF, `no open hold for tx ${ev.tx}`);
      const amt = parseAmt(ev.amt, 'amt');
      if (amt.sign() <= 0) throw new AppError(E_STATE, 'capture amount must be positive');
      if (amt.cmp(hold) > 0) {
        throw new AppError(E_STATE, 'capture exceeds hold', { hold: hold.toString(), requested: amt.toString() });
      }
      // Rounding coupling: trial-settle with ROUND_HALF_EVEN first; if the
      // rounded settlement would break the invariant (unrecoverable), the
      // whole capture fails with E_STATE and nothing is applied.
      const settled = roundHalfEvenCents(amt);
      if (settled.sign() <= 0) {
        throw new AppError(E_STATE, 'capture rounds to zero cents', { requested: amt.toString() });
      }
      const frozen2 = st.frozen.sub(amt);
      const captured2 = st.captured.add(settled);
      if (frozen2.add(captured2).cmp(limit) > 0) {
        throw new AppError(E_STATE, 'capture rounding makes state unrecoverable', {
          requested: amt.toString(), settled: settled.toString(), limit: limit.toString(),
        });
      }
      st.frozen = frozen2;
      st.captured = captured2;
      const rem = hold.sub(amt);
      if (rem.isZero()) st.holds.delete(ev.tx); else st.holds.set(ev.tx, rem);
      st.captures.set(ev.capId, { tx: ev.tx, exact: amt, settled });
      return;
    }
    case 'void': {
      const hold = st.holds.get(ev.tx);
      if (!hold) throw new AppError(E_REF, `no open hold for tx ${ev.tx}`);
      st.frozen = st.frozen.sub(hold);
      st.holds.delete(ev.tx);
      return;
    }
    case 'reverse': {
      // Parallel-reversible captures: exact id, else prefix match; ties broken
      // by smallest settled amount, then lexicographic id.
      const cands = [...st.captures.entries()]
        .filter(([id]) => id === ev.captureId || id.startsWith(ev.captureId));
      if (cands.length === 0) throw new AppError(E_REF, `no reversible capture ${ev.captureId}`);
      cands.sort((a, b) => {
        const c = a[1].settled.cmp(b[1].settled);
        return c !== 0 ? c : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      });
      const [id, cap] = cands[0];
      st.captured = st.captured.sub(cap.settled);
      st.captures.delete(id);
      return;
    }
    default:
      throw new AppError(E_PARSE, `not a data op: ${ev.op}`);
  }
}

function foldEvents(limit, events) {
  const st = freshState();
  for (const ev of events) applyData(limit, st, ev);
  return st;
}

function needStr(v, field) {
  if (typeof v !== 'string' || v.length === 0) throw new AppError(E_PARSE, `missing/invalid ${field}`);
  return v;
}

export class Engine {
  constructor() {
    this.limit = null;
    this.trunk = [];              // main branch events
    this.branches = new Map();    // name -> {parent, base, events, merged}
    this.current = null;          // null = main
    this.captureSeq = 0;
    this.branchSeq = 0;
  }

  // ---- log structure ----
  effective(name) {
    if (name === null) return this.trunk;
    const b = this.branches.get(name);
    if (!b) throw new AppError(E_REF, `unknown branch ${name}`);
    return this.effective(b.parent).slice(0, b.base).concat(b.events);
  }
  ctxList(name) {
    if (name === null) return this.trunk;
    return this.branches.get(name).events;
  }
  currentState() {
    if (!this.limit) throw new AppError(E_STATE, 'engine not initialized');
    return foldEvents(this.limit, this.effective(this.current));
  }

  // ---- op normalization (E_PARSE) ----
  normalize(raw) {
    if (typeof raw !== 'object' || raw === null || !OPS.has(raw.op)) {
      throw new AppError(E_PARSE, `unknown or malformed op: ${JSON.stringify(raw)}`);
    }
    switch (raw.op) {
      case 'init': {
        const limit = parseAmt(raw.limit, 'limit');
        if (limit.sign() < 0) throw new AppError(E_STATE, 'limit must be >= 0');
        return { op: 'init', limit: limit.toString() };
      }
      case 'freeze':
      case 'capture': {
        const tx = needStr(raw.tx, 'tx');
        const amt = parseAmt(raw.amt, 'amt').toString();
        const op = { op: raw.op, tx, amt };
        if (raw.op === 'capture' && typeof raw.capId === 'string') op.capId = raw.capId;
        return op;
      }
      case 'void':
        return { op: 'void', tx: needStr(raw.tx, 'tx') };
      case 'reverse':
        return { op: 'reverse', captureId: needStr(raw.captureId, 'captureId') };
      case 'branch': {
        if (!Number.isInteger(raw.fromEvent)) throw new AppError(E_PARSE, 'fromEvent must be an integer');
        const op = { op: 'branch', fromEvent: raw.fromEvent };
        if (raw.name !== undefined) op.name = needStr(raw.name, 'name');
        return op;
      }
      case 'merge':
      case 'rollback':
      case 'use':
        return { op: raw.op, branch: needStr(raw.branch, 'branch') };
    }
  }

  // Applies one op. Returns {record, result}; record is what must be persisted.
  apply(raw) {
    const op = this.normalize(raw);
    switch (op.op) {
      case 'init': {
        const limit = Frac.parse(op.limit);
        if (this.limit && this.limit.cmp(limit) !== 0) {
          throw new AppError(E_STATE, 'conflicting init limit', { have: this.limit.toString(), got: op.limit });
        }
        this.limit = limit;
        return { record: op, result: { ok: true } };
      }
      case 'freeze':
      case 'void':
      case 'reverse': {
        const st = this.currentState();
        applyData(this.limit, st, op);
        this.ctxList(this.current).push(op);
        return { record: op, result: { ok: true } };
      }
      case 'capture': {
        const enriched = { ...op };
        if (!enriched.capId) enriched.capId = `c${this.captureSeq}`;
        const st = this.currentState();
        applyData(this.limit, st, enriched);   // throws before any commit on E_STATE
        const n = Number(enriched.capId.slice(1));
        if (Number.isInteger(n) && n >= this.captureSeq) this.captureSeq = n + 1;
        this.ctxList(this.current).push(enriched);
        return { record: enriched, result: { ok: true, capId: enriched.capId } };
      }
      case 'branch': {
        const eff = this.effective(this.current);
        if (op.fromEvent < 0 || op.fromEvent > eff.length) {
          throw new AppError(E_REF, `fromEvent ${op.fromEvent} out of range 0..${eff.length}`);
        }
        const name = op.name ?? `b${this.branchSeq}`;
        if (this.branches.has(name)) throw new AppError(E_STATE, `branch ${name} already exists`);
        const rec = { ...op, name };
        this.branchSeq = Math.max(this.branchSeq, this.branchSeq + 1);
        this.branches.set(name, { parent: this.current, base: op.fromEvent, events: [], merged: false });
        this.current = name;
        return { record: rec, result: { ok: true, branch: name } };
      }
      case 'use': {
        if (op.branch === 'main') this.current = null;
        else if (this.branches.has(op.branch)) this.current = op.branch;
        else throw new AppError(E_REF, `unknown branch ${op.branch}`);
        return { record: op, result: { ok: true } };
      }
      case 'merge': {
        const b = this.branches.get(op.branch);
        if (!b) throw new AppError(E_REF, `unknown branch ${op.branch}`);
        if (b.merged) throw new AppError(E_STATE, `branch ${op.branch} already merged`);
        const parentEff = this.effective(b.parent);
        const st = foldEvents(this.limit, parentEff);
        for (let i = 0; i < b.events.length; i++) {
          try {
            applyData(this.limit, st, b.events[i]);
          } catch (e) {
            if (e instanceof AppError) {
              throw new AppError(E_STATE, `merge conflict at branch event #${i}`, {
                counterexample: {
                  index: i,
                  event: b.events[i],
                  stateBefore: snapshotState(st, this.limit),
                  cause: { code: e.code, message: e.message, details: e.details },
                },
              });
            }
            throw e;
          }
        }
        const parentList = b.parent === null ? this.trunk : this.branches.get(b.parent).events;
        parentList.push(...b.events);
        b.merged = true;
        b.events = [];
        b.base = this.effective(b.parent).length;
        this.current = b.parent;
        return { record: op, result: { ok: true, merged: op.branch, into: b.parent ?? 'main' } };
      }
      case 'rollback': {
        const b = this.branches.get(op.branch);
        if (!b) throw new AppError(E_REF, `unknown branch ${op.branch}`);
        if (b.merged) throw new AppError(E_STATE, `branch ${op.branch} already merged`);
        for (const [name, child] of this.branches) {
          if (child.parent === op.branch && !child.merged) {
            throw new AppError(E_STATE, `rollback blocked by active child branch ${name}`);
          }
        }
        // Layered undo: only this branch's own unmerged events are dropped;
        // anything already merged into ancestors lives in their lists.
        b.events = [];
        if (this.current === op.branch) this.current = b.parent;
        return { record: op, result: { ok: true, rolledBack: op.branch } };
      }
    }
  }

  snapshot() {
    const st = this.currentState();
    return {
      branch: this.current ?? 'main',
      branches: [...this.branches.entries()].map(([name, b]) => ({
        name, parent: b.parent ?? 'main', base: b.base, pending: b.events.length, merged: b.merged,
      })),
      ...snapshotState(st, this.limit),
    };
  }
}
