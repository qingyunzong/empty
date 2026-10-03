// Offline multi-window clearing engine.
//
// - Base data (accounts, orders) is versioned per object; every correction
//   bumps the object version and the global base version.
// - A trial (试算) solves one window against a consistent snapshot and records
//   its read set: the versions of every order whose symbol is priced in the
//   window and of every account funding a buy order in those symbols.
// - commit validates the trial's read set against current versions
//   (E_STALE on any mismatch), then atomically decrements order remainders,
//   debits buyers and credits sellers. Commit ids are idempotent.
// - undo only removes uncommitted trials. Committed fills can only be
//   reversed once, by a compensating transaction referencing the original
//   commit; insufficient seller funds or a conflicting later order state
//   aborts the whole compensation atomically.

import * as F from './fraction.js';
import { solveProblem } from './solver.js';
import { verifyProof } from './checker.js';

function makeError(code, message) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  return e;
}

function compareIds(a, b) {
  const na = /^\d+$/.test(a) ? BigInt(a) : null;
  const nb = /^\d+$/.test(b) ? BigInt(b) : null;
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseFrac(value, code) {
  if (value === null || value === undefined) throw makeError(code, 'missing rational value');
  if (typeof value === 'object') {
    if (value.den === undefined || value.den === null) throw makeError(code, 'missing denominator');
    const den = BigInt(value.den);
    if (den <= 0n) throw makeError(code, 'denominator must be positive');
    return F.frac(BigInt(value.num), den);
  }
  return F.frac(BigInt(value));
}

export class Engine {
  constructor() {
    this.accounts = new Map(); // id -> { funds: frac, version }
    this.orders = new Map(); // id -> { account, symbol, side, qty, limit, version }
    this.trials = new Map(); // trialId -> trial record (kept after commit)
    this.commits = new Map(); // commitId -> commit record
    this.compensations = new Map(); // compensationId -> record
    this.baseVersion = 0;
    this.trialSeq = 0;
  }

  setAccount({ id, funds }) {
    if (id === undefined) throw makeError('E_INPUT', 'account id required');
    const parsed = parseFrac(funds, 'E_FUNDS_INPUT');
    if (F.cmp(parsed, F.ZERO) < 0) throw makeError('E_FUNDS_INPUT', 'funds must be non-negative');
    const prev = this.accounts.get(id);
    const version = prev ? prev.version + 1 : 0;
    this.accounts.set(id, { funds: parsed, version });
    this.baseVersion++;
    return { id, funds: parsed, version, baseVersion: this.baseVersion };
  }

  setOrder({ id, account, symbol, side, qty, limit }) {
    if (id === undefined || account === undefined || symbol === undefined) {
      throw makeError('E_INPUT', 'order id/account/symbol required');
    }
    if (side !== 'buy' && side !== 'sell') throw makeError('E_INPUT', 'side must be buy|sell');
    if (!this.accounts.has(account)) throw makeError('E_NOT_FOUND', `unknown account ${account}`);
    const q = BigInt(qty);
    if (q < 0n) throw makeError('E_QTY', 'qty must be non-negative');
    const lim = parseFrac(limit, 'E_PRICE');
    const prev = this.orders.get(id);
    const version = prev ? prev.version + 1 : 0;
    this.orders.set(id, { account, symbol, side, qty: q, limit: lim, version });
    this.baseVersion++;
    return { id, version, baseVersion: this.baseVersion };
  }

  correctAccount({ id, funds }) {
    if (!this.accounts.has(id)) throw makeError('E_NOT_FOUND', `unknown account ${id}`);
    return this.setAccount({ id, funds });
  }

  correctOrder(fields) {
    const prev = this.orders.get(fields.id);
    if (!prev) throw makeError('E_NOT_FOUND', `unknown order ${fields.id}`);
    return this.setOrder({
      id: fields.id,
      account: fields.account ?? prev.account,
      symbol: fields.symbol ?? prev.symbol,
      side: fields.side ?? prev.side,
      qty: fields.qty ?? prev.qty,
      limit: fields.limit ?? { num: prev.limit.num, den: prev.limit.den },
    });
  }

  trial({ window, prices, budget }) {
    if (window === undefined) throw makeError('E_INPUT', 'window required');
    if (!prices || typeof prices !== 'object') throw makeError('E_PRICE', 'prices required');
    const priceMap = new Map();
    for (const [sym, p] of Object.entries(prices)) {
      priceMap.set(sym, parseFrac(p, 'E_PRICE'));
    }
    // Read set: orders in priced symbols + accounts funding their buy orders.
    const reads = { orders: {}, accounts: {} };
    const eligible = [];
    for (const [oid, o] of this.orders) {
      if (!priceMap.has(o.symbol)) continue;
      reads.orders[oid] = o.version;
      if (o.side === 'buy') {
        const acc = this.accounts.get(o.account);
        reads.accounts[o.account] = acc ? acc.version : -1;
      }
      const price = priceMap.get(o.symbol);
      if (o.qty === 0n) continue;
      if (o.side === 'buy' && F.cmp(o.limit, price) < 0) continue;
      if (o.side === 'sell' && F.cmp(o.limit, price) > 0) continue;
      eligible.push({
        id: oid,
        account: o.account,
        side: o.side,
        symbol: o.symbol,
        cap: o.qty,
        price,
      });
    }
    eligible.sort((a, b) => compareIds(a.id, b.id));
    const fundsSnapshot = new Map();
    for (const o of eligible) {
      if (o.side === 'buy' && !fundsSnapshot.has(o.account)) {
        const acc = this.accounts.get(o.account);
        fundsSnapshot.set(o.account, acc ? acc.funds : F.ZERO);
      }
    }
    const solved = solveProblem(eligible, fundsSnapshot, budget ?? 1_000_000);
    const fillsMap = new Map();
    eligible.forEach((o, i) => {
      if (solved.vector[i] > 0n) fillsMap.set(o.id, solved.vector[i]);
    });
    const fullVector = [...this.orders.keys()]
      .sort(compareIds)
      .map((oid) => {
        const idx = eligible.findIndex((e) => e.id === oid);
        return idx >= 0 ? solved.vector[idx] : 0n;
      });
    const trialId = `t${++this.trialSeq}`;
    const record = {
      trialId,
      window,
      baseVersion: this.baseVersion,
      reads,
      prices: priceMap,
      problem: eligible,
      fundsSnapshot,
      fillsMap,
      proof: solved.proof,
      result: {
        qty: solved.qty,
        spend: solved.spend,
        count: solved.count,
        vector: fullVector,
        nodes: solved.nodes,
      },
      committed: false,
    };
    this.trials.set(trialId, record);
    return {
      trialId,
      window,
      baseVersion: record.baseVersion,
      reads,
      fills: Object.fromEntries([...fillsMap.entries()].map(([k, v]) => [k, v])),
      result: record.result,
      proof: solved.proof,
    };
  }

  checkTrial({ trial }) {
    const t = this.trials.get(trial);
    if (!t) throw makeError('E_NOT_FOUND', `unknown trial ${trial}`);
    return verifyProof(t.problem, t.fundsSnapshot, t.proof, {
      qty: t.result.qty,
      spend: t.result.spend,
      count: t.result.count,
      vector: t.problem.map((o) => t.fillsMap.get(o.id) ?? 0n),
    });
  }

  commit({ id, trial }) {
    if (id === undefined || trial === undefined) throw makeError('E_INPUT', 'commit id and trial required');
    const existing = this.commits.get(id);
    if (existing) {
      if (existing.trialId !== trial) {
        throw makeError('E_CONFLICT', `commit id ${id} already used for trial ${existing.trialId}`);
      }
      return { id, trial, status: 'committed', idempotent: true, fills: existing.fills };
    }
    const t = this.trials.get(trial);
    if (!t) throw makeError('E_NOT_FOUND', `unknown trial ${trial}`);
    if (t.committed) throw makeError('E_STATE', `trial ${trial} already committed`);
    // Re-validate read dependencies against current versions.
    for (const [oid, v] of Object.entries(t.reads.orders)) {
      const cur = this.orders.get(oid);
      if (!cur || cur.version !== v) {
        throw makeError('E_STALE', `order ${oid} changed since trial (read v${v})`);
      }
    }
    for (const [aid, v] of Object.entries(t.reads.accounts)) {
      const cur = this.accounts.get(aid);
      if (!cur || cur.version !== v) {
        throw makeError('E_STALE', `account ${aid} changed since trial (read v${v})`);
      }
    }
    // Simulate first: the whole commit is atomic.
    const spendByAccount = new Map();
    const proceedsByAccount = new Map();
    for (const [oid, fill] of t.fillsMap) {
      const o = this.orders.get(oid);
      if (fill > o.qty) throw makeError('E_CONFLICT', `order ${oid} remainder too small`);
      const price = t.prices.get(o.symbol);
      const amount = F.mul(price, F.frac(fill));
      if (o.side === 'buy') {
        spendByAccount.set(o.account, F.add(spendByAccount.get(o.account) ?? F.ZERO, amount));
      } else {
        proceedsByAccount.set(o.account, F.add(proceedsByAccount.get(o.account) ?? F.ZERO, amount));
      }
    }
    for (const [aid, spend] of spendByAccount) {
      const acc = this.accounts.get(aid);
      if (!acc || F.cmp(acc.funds, spend) < 0) {
        throw makeError('E_FUNDS', `account ${aid} has insufficient funds`);
      }
    }
    // Apply.
    const orderVersions = {};
    for (const [oid, fill] of t.fillsMap) {
      const o = this.orders.get(oid);
      o.qty -= fill;
      o.version++;
      orderVersions[oid] = o.version;
    }
    for (const [aid, spend] of spendByAccount) {
      const acc = this.accounts.get(aid);
      acc.funds = F.sub(acc.funds, spend);
      acc.version++;
    }
    for (const [aid, proceeds] of proceedsByAccount) {
      const acc = this.accounts.get(aid);
      if (acc) {
        acc.funds = F.add(acc.funds, proceeds);
        acc.version++;
      }
    }
    this.baseVersion++;
    t.committed = true;
    const fills = Object.fromEntries(t.fillsMap);
    this.commits.set(id, { trialId: trial, fills, fillsMap: new Map(t.fillsMap), orderVersions, prices: t.prices, compensated: false });
    return { id, trial, status: 'committed', idempotent: false, fills, baseVersion: this.baseVersion };
  }

  undo({ trial }) {
    const t = this.trials.get(trial);
    if (!t) throw makeError('E_NOT_FOUND', `unknown trial ${trial}`);
    if (t.committed) {
      throw makeError('E_STATE', 'committed fills can only be reversed via compensation');
    }
    this.trials.delete(trial);
    return { trial, status: 'undone' };
  }

  compensate({ id, commit }) {
    if (id === undefined || commit === undefined) {
      throw makeError('E_INPUT', 'compensation id and commit id required');
    }
    const existing = this.compensations.get(id);
    if (existing) {
      if (existing.commitId !== commit) {
        throw makeError('E_CONFLICT', `compensation id ${id} already used for commit ${existing.commitId}`);
      }
      return { id, commit, status: 'compensated', idempotent: true };
    }
    const c = this.commits.get(commit);
    if (!c) throw makeError('E_NOT_FOUND', `unknown commit ${commit}`);
    if (c.compensated) throw makeError('E_ALREADY_COMPENSATED', `commit ${commit} already compensated`);
    // Order state must not have changed since the commit.
    for (const [oid, v] of Object.entries(c.orderVersions)) {
      const cur = this.orders.get(oid);
      if (!cur || cur.version !== v) {
        throw makeError('E_CONFLICT', `order ${oid} changed after commit ${commit}`);
      }
    }
    const refundByAccount = new Map();
    const debitByAccount = new Map();
    for (const [oid, fill] of c.fillsMap) {
      const o = this.orders.get(oid);
      const price = c.prices.get(o.symbol);
      const amount = F.mul(price, F.frac(fill));
      if (o.side === 'buy') {
        refundByAccount.set(o.account, F.add(refundByAccount.get(o.account) ?? F.ZERO, amount));
      } else {
        debitByAccount.set(o.account, F.add(debitByAccount.get(o.account) ?? F.ZERO, amount));
      }
    }
    // Sellers must be able to return the proceeds; all-or-nothing.
    for (const [aid, debit] of debitByAccount) {
      const acc = this.accounts.get(aid);
      if (!acc || F.cmp(acc.funds, debit) < 0) {
        throw makeError('E_FUNDS', `account ${aid} cannot return sale proceeds`);
      }
    }
    for (const [oid, fill] of c.fillsMap) {
      const o = this.orders.get(oid);
      o.qty += fill;
      o.version++;
    }
    for (const [aid, refund] of refundByAccount) {
      const acc = this.accounts.get(aid);
      if (acc) {
        acc.funds = F.add(acc.funds, refund);
        acc.version++;
      }
    }
    for (const [aid, debit] of debitByAccount) {
      const acc = this.accounts.get(aid);
      acc.funds = F.sub(acc.funds, debit);
      acc.version++;
    }
    this.baseVersion++;
    c.compensated = true;
    this.compensations.set(id, { commitId: commit });
    return { id, commit, status: 'compensated', idempotent: false, baseVersion: this.baseVersion };
  }

  state() {
    return {
      baseVersion: this.baseVersion,
      accounts: Object.fromEntries(
        [...this.accounts.entries()].map(([id, a]) => [id, { funds: a.funds, version: a.version }]),
      ),
      orders: Object.fromEntries(
        [...this.orders.entries()].map(([id, o]) => [
          id,
          { account: o.account, symbol: o.symbol, side: o.side, qty: o.qty, limit: o.limit, version: o.version },
        ]),
      ),
      commits: Object.fromEntries(
        [...this.commits.entries()].map(([id, c]) => [
          id,
          { trialId: c.trialId, fills: c.fills, compensated: c.compensated },
        ]),
      ),
      openTrials: [...this.trials.values()].filter((t) => !t.committed).map((t) => t.trialId),
    };
  }
}
