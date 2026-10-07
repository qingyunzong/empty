// Offline multi-window clearing engine.
//
// - Base data: accounts (funds), instruments (clearing price), orders
//   (remaining quantity + limit). Every object carries a version; every
//   correction bumps the object version and the global base version.
// - A window holds at most one uncommitted trial. A trial snapshots its
//   read set: base version plus the versions of every account, order and
//   instrument it depended on.
// - commit revalidates the trial's read set; trials that read modified
//   objects fail with E_STALE and are never silently recomputed. Trials
//   whose read set is untouched remain committable.
// - undo only removes uncommitted trials; committed fills can only be
//   reversed once through a compensating transaction that references the
//   original fill. Compensation is atomic: insufficient seller funds or a
//   conflicting later order state fails the whole compensation.
// - commit and compensate are idempotent on their submission id.

import { frac, add, sub, mul, cmp, ZERO } from './fraction.js';
import { solve } from './solver.js';
import { verify } from './checker.js';

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function fail(code, detail, extra = {}) {
  return { ok: false, error: code, detail, ...extra };
}

export class Engine {
  constructor() {
    this.baseVersion = 0;
    this.accounts = new Map(); // id -> {funds, version}
    this.instruments = new Map(); // id -> {price, version}
    this.orders = new Map(); // id -> {account, side, instrument, limit, maxQty, remaining, version}
    this.windows = new Map(); // id -> {trial, committed}
    this.submissions = new Map(); // submitId -> {op, window, response}
  }

  // ---- base data -------------------------------------------------------

  setAccount(id, funds) {
    id = String(id);
    const existing = this.accounts.get(id);
    this.accounts.set(id, { funds, version: existing ? existing.version + 1 : 1 });
    this.baseVersion += 1;
    return ok({ account: id, version: this.accounts.get(id).version });
  }

  setInstrument(id, price) {
    id = String(id);
    if (cmp(price, ZERO) < 0) return fail('E_BAD_PRICE', 'clearing price must be >= 0');
    const existing = this.instruments.get(id);
    this.instruments.set(id, { price, version: existing ? existing.version + 1 : 1 });
    this.baseVersion += 1;
    return ok({ instrument: id, version: this.instruments.get(id).version });
  }

  setOrder(id, { account, side, instrument, qty, limit }) {
    id = String(id);
    account = String(account);
    instrument = String(instrument);
    if (side !== 'buy' && side !== 'sell') return fail('E_BAD_SIDE', 'side must be buy|sell');
    qty = BigInt(qty);
    if (qty < 0n) return fail('E_BAD_QTY', 'qty must be >= 0');
    if (!this.accounts.has(account)) return fail('E_NO_ACCOUNT', `unknown account ${account}`);
    if (!this.instruments.has(instrument)) {
      return fail('E_NO_INSTRUMENT', `unknown instrument ${instrument}`);
    }
    const existing = this.orders.get(id);
    this.orders.set(id, {
      account,
      side,
      instrument,
      limit,
      maxQty: qty,
      remaining: qty,
      version: existing ? existing.version + 1 : 1,
    });
    this.baseVersion += 1;
    return ok({ order: id, version: this.orders.get(id).version });
  }

  // ---- trials ----------------------------------------------------------

  trial(windowId, { budget = 100000, proof = true, instruments = null } = {}) {
    windowId = String(windowId);
    const w = this.windows.get(windowId);
    if (w && w.committed) return fail('E_COMMITTED', 'window already committed');
    const scope = instruments === null || instruments === undefined
      ? null
      : new Set(instruments.map(String));

    const orders = [];
    const readOrders = {};
    const readAccounts = {};
    const readInstruments = {};
    for (const [id, o] of this.orders) {
      if (o.remaining === 0n) continue;
      if (scope && !scope.has(o.instrument)) continue;
      const inst = this.instruments.get(o.instrument);
      if (!inst) continue;
      orders.push({
        id,
        account: o.account,
        side: o.side,
        instrument: o.instrument,
        qty: o.remaining,
        limit: o.limit,
      });
      readOrders[id] = o.version;
      readInstruments[o.instrument] = inst.version;
      const acc = this.accounts.get(o.account);
      readAccounts[o.account] = acc ? acc.version : 0;
    }
    const prices = {};
    for (const [iid, inst] of this.instruments) {
      if (scope && !scope.has(iid)) continue;
      prices[iid] = inst.price;
    }
    const funds = {};
    for (const [aid, a] of this.accounts) funds[aid] = a.funds;
    const problem = { orders, prices, funds };

    const result = solve(problem, { budget, proof });
    if (result.status !== 'OK') {
      // Budget exhaustion is surfaced as-is; never as a zero-fill trial.
      return fail(result.status, 'search budget exhausted', { nodes: result.nodes });
    }
    const readSet = {
      base: this.baseVersion,
      accounts: readAccounts,
      orders: readOrders,
      instruments: readInstruments,
    };
    const trial = { problem, result, readSet };
    this.windows.set(windowId, { trial, committed: null });
    return ok({
      window: windowId,
      volume: result.volume,
      spend: result.spend,
      count: result.count,
      vector: result.vector,
      readSet,
      proof: result.proof,
      stats: result.stats,
    });
  }

  verifyTrial(windowId) {
    windowId = String(windowId);
    const w = this.windows.get(windowId);
    const trial = w && (w.trial || (w.committed && w.committed.trial));
    if (!trial) return fail('E_NO_TRIAL', `no trial in window ${windowId}`);
    if (!trial.result.proof) return fail('E_NO_PROOF', 'trial was computed without a proof');
    const checked = verify(trial.problem, trial.result);
    return checked.ok ? ok({ window: windowId, nodes: checked.nodes }) : checked;
  }

  // ---- commit ------------------------------------------------------------

  commit(windowId, submitId) {
    windowId = String(windowId);
    if (submitId !== undefined && submitId !== null) {
      const prev = this.submissions.get(String(submitId));
      if (prev) {
        if (prev.op === 'commit' && prev.window === windowId) return prev.response;
        return fail('E_SUBMIT_CONFLICT', `submit id ${submitId} already used for ${prev.op}`);
      }
    }
    const w = this.windows.get(windowId);
    if (!w || !w.trial) return fail('E_NO_TRIAL', `no uncommitted trial in window ${windowId}`);
    if (w.committed) return fail('E_COMMITTED', 'window already committed');
    const t = w.trial;

    const stale = [];
    for (const [id, v] of Object.entries(t.readSet.orders)) {
      const o = this.orders.get(id);
      if (!o || o.version !== v) stale.push(`order:${id}`);
    }
    for (const [id, v] of Object.entries(t.readSet.accounts)) {
      const a = this.accounts.get(id);
      if (!a || a.version !== v) stale.push(`account:${id}`);
    }
    for (const [id, v] of Object.entries(t.readSet.instruments)) {
      const i = this.instruments.get(id);
      if (!i || i.version !== v) stale.push(`instrument:${id}`);
    }
    if (stale.length > 0) {
      const response = fail('E_STALE', 'trial read set is stale', { stale });
      if (submitId !== undefined && submitId !== null) {
        this.submissions.set(String(submitId), { op: 'commit', window: windowId, response });
      }
      return response;
    }

    // Atomic application: first compute and validate every mutation, then
    // apply. Decrement remaining quantities, debit buyers, credit sellers.
    const fills = t.result.vector;
    const orderVersionsAfter = {};
    const deltas = new Map(); // account -> frac delta
    for (const [oid, qty] of Object.entries(fills)) {
      if (qty === 0n) continue;
      const o = this.orders.get(oid);
      const price = t.problem.prices[o.instrument];
      const amount = mul(price, frac(qty));
      if (qty > o.remaining) return fail('E_STATE', `order ${oid} overfilled`);
      const cur = deltas.get(o.account) || ZERO;
      deltas.set(o.account, o.side === 'buy' ? sub(cur, amount) : add(cur, amount));
    }
    for (const [aid, delta] of deltas) {
      const acc = this.accounts.get(aid);
      if (!acc) return fail('E_STATE', `account ${aid} missing`);
      if (cmp(add(acc.funds, delta), ZERO) < 0) {
        // Unreachable while read-set validation holds; kept as an invariant
        // guard so a commit can never drive an account negative.
        return fail('E_STATE', `account ${aid} cannot cover spend`);
      }
    }
    for (const [oid, qty] of Object.entries(fills)) {
      if (qty === 0n) continue;
      const o = this.orders.get(oid);
      o.remaining -= qty;
      o.version += 1;
      orderVersionsAfter[oid] = o.version;
    }
    for (const [aid, delta] of deltas) {
      const acc = this.accounts.get(aid);
      acc.funds = add(acc.funds, delta);
      acc.version += 1;
    }
    const committed = {
      submitId: submitId === undefined || submitId === null ? null : String(submitId),
      fills: { ...fills },
      orderVersionsAfter,
      compensated: false,
      trial: t,
    };
    w.committed = committed;
    w.trial = null;
    const response = ok({
      window: windowId,
      submit: committed.submitId,
      fills: committed.fills,
      volume: t.result.volume,
      spend: t.result.spend,
    });
    if (committed.submitId !== null) {
      this.submissions.set(committed.submitId, { op: 'commit', window: windowId, response });
    }
    return response;
  }

  // ---- undo --------------------------------------------------------------

  undo(windowId) {
    windowId = String(windowId);
    const w = this.windows.get(windowId);
    if (!w || (!w.trial && !w.committed)) return fail('E_NO_TRIAL', `nothing to undo in ${windowId}`);
    if (w.committed) {
      return fail('E_COMMITTED', 'committed fills can only be reversed via compensation');
    }
    this.windows.delete(windowId);
    return ok({ window: windowId, undone: true });
  }

  // ---- compensation --------------------------------------------------------

  compensate(windowId, submitId) {
    windowId = String(windowId);
    if (submitId !== undefined && submitId !== null) {
      const prev = this.submissions.get(String(submitId));
      if (prev) {
        if (prev.op === 'compensate' && prev.window === windowId) return prev.response;
        return fail('E_SUBMIT_CONFLICT', `submit id ${submitId} already used for ${prev.op}`);
      }
    }
    const w = this.windows.get(windowId);
    if (!w || !w.committed) return fail('E_NO_FILL', `no committed fill in window ${windowId}`);
    const c = w.committed;
    if (c.compensated) return fail('E_ALREADY_COMPENSATED', 'fill already compensated');

    // Conflict check: orders must not have been touched since the commit.
    for (const [oid, v] of Object.entries(c.orderVersionsAfter)) {
      const o = this.orders.get(oid);
      if (!o || o.version !== v) {
        return fail('E_CONFLICT', `order ${oid} changed since commit`);
      }
    }
    // Funds check: sellers must be able to return their proceeds. The whole
    // compensation fails atomically if any account would go negative.
    const deltas = new Map();
    for (const [oid, qty] of Object.entries(c.fills)) {
      if (qty === 0n) continue;
      const o = this.orders.get(oid);
      const price = c.trial.problem.prices[o.instrument];
      const amount = mul(price, frac(qty));
      const cur = deltas.get(o.account) || ZERO;
      deltas.set(o.account, o.side === 'buy' ? add(cur, amount) : sub(cur, amount));
    }
    for (const [aid, delta] of deltas) {
      const acc = this.accounts.get(aid);
      if (!acc) return fail('E_STATE', `account ${aid} missing`);
      if (cmp(add(acc.funds, delta), ZERO) < 0) {
        return fail('E_FUNDS', `account ${aid} cannot return proceeds`);
      }
    }
    // Apply: restore remaining quantities, refund buyers, debit sellers.
    for (const [oid, qty] of Object.entries(c.fills)) {
      if (qty === 0n) continue;
      const o = this.orders.get(oid);
      o.remaining += qty;
      if (o.remaining > o.maxQty) return fail('E_STATE', `order ${oid} exceeds max quantity`);
      o.version += 1;
    }
    for (const [aid, delta] of deltas) {
      const acc = this.accounts.get(aid);
      acc.funds = add(acc.funds, delta);
      acc.version += 1;
    }
    c.compensated = true;
    const response = ok({
      window: windowId,
      submit: submitId === undefined || submitId === null ? null : String(submitId),
      compensated: true,
      fills: c.fills,
    });
    if (submitId !== undefined && submitId !== null) {
      this.submissions.set(String(submitId), { op: 'compensate', window: windowId, response });
    }
    return response;
  }

  // ---- introspection -------------------------------------------------------

  state() {
    const accounts = {};
    for (const [id, a] of this.accounts) accounts[id] = { funds: a.funds, version: a.version };
    const instruments = {};
    for (const [id, i] of this.instruments) {
      instruments[id] = { price: i.price, version: i.version };
    }
    const orders = {};
    for (const [id, o] of this.orders) {
      orders[id] = {
        account: o.account,
        side: o.side,
        instrument: o.instrument,
        limit: o.limit,
        maxQty: o.maxQty,
        remaining: o.remaining,
        version: o.version,
      };
    }
    const windows = {};
    for (const [id, w] of this.windows) {
      windows[id] = {
        trial: w.trial ? { readSet: w.trial.readSet } : null,
        committed: w.committed
          ? {
              submitId: w.committed.submitId,
              fills: w.committed.fills,
              compensated: w.committed.compensated,
            }
          : null,
      };
    }
    return ok({ baseVersion: this.baseVersion, accounts, instruments, orders, windows });
  }
}
