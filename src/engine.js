import {
  RULE_VERSIONS,
  computeFee,
  selectPackage,
  splitIntoTiers,
  tierDelta,
  hitTierIndex,
  r4,
} from './rules.js';
import { certificate } from './certificate.js';

export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

const ZERO = Object.freeze({
  packageId: null,
  turnover: 0,
  tiers: [],
  gross: 0,
  minFee: 0,
  minFeeApplied: false,
  rebate: 0,
  rebateId: null,
  net: 0,
});

function hitTierLabel(breakdown) {
  return breakdown.tiers.length ? breakdown.tiers[breakdown.tiers.length - 1].tier : 'none';
}

export function explain(prev, next) {
  const reasons = [];
  if (prev.turnover !== next.turnover) reasons.push(`turnover ${prev.turnover}->${next.turnover}`);
  const pt = hitTierLabel(prev);
  const nt = hitTierLabel(next);
  if (pt !== nt) reasons.push(`tier ${pt}->${nt}`);
  if (!prev.minFeeApplied && next.minFeeApplied) {
    reasons.push(`minimum fee ${next.minFee} applied (gross ${next.gross})`);
  }
  if (prev.minFeeApplied && !next.minFeeApplied) {
    reasons.push(`gross ${next.gross} now above minimum fee ${next.minFee}`);
  }
  if (prev.rebate !== next.rebate) {
    reasons.push(`rebate ${prev.rebate}->${next.rebate}${next.rebateId ? ` (${next.rebateId})` : ''}`);
  }
  if (prev.packageId && prev.packageId !== next.packageId) {
    reasons.push(`package ${prev.packageId}->${next.packageId}`);
  }
  return reasons;
}

export class Engine {
  constructor({ day = '1970-01-01' } = {}) {
    this.day = day;
    this.ruleVersion = 'v1';
    this.seq = 0;
    this.accounts = new Map();
    this.trades = new Map();
    this.nodes = new Map();
    this._node(`rules:${this.ruleVersion}`);
  }

  _node(id) {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, dirty: false });
    return this.nodes.get(id);
  }

  _account(id) {
    let a = this.accounts.get(id);
    if (!a) {
      a = {
        id,
        packages: null,
        trades: new Map(),
        turnover: 0,
        tierAmounts: [],
        selected: null,
        breakdown: null,
        tied: [],
        feeVersion: 0,
        invoiceVersion: 0,
        certChain: null,
        active: false,
      };
      this.accounts.set(id, a);
      for (const n of ['turnover', 'tiers', 'fee', 'invoice']) this._node(`${n}:${id}`);
    }
    return a;
  }

  _packs(a) {
    const all = RULE_VERSIONS[this.ruleVersion].packages;
    const filtered = a.packages ? all.filter((p) => a.packages.includes(p.id)) : all;
    return filtered.length ? filtered : all;
  }

  _packDef(a) {
    return RULE_VERSIONS[this.ruleVersion].packages.find((p) => p.id === a.selected);
  }

  _reselect(a) {
    const { winner, tied } = selectPackage(this._packs(a), a.turnover);
    const changed = winner !== a.selected;
    a.selected = winner;
    a.tied = tied;
    a.tierAmounts = splitIntoTiers(this._packDef(a).tiers, a.turnover);
    a.breakdown = computeFee(this._packDef(a), a.turnover);
    return changed;
  }

  _applyDelta(a, delta) {
    if (!a.selected) this._reselect(a);
    const pack = this._packDef(a);
    const from = a.turnover;
    const to = from + delta;
    if (to < 0) throw new EngineError(`account ${a.id}: turnover would go negative`);
    const oldHit = hitTierIndex(a.tierAmounts);
    for (const c of tierDelta(pack.tiers, from, to)) a.tierAmounts[c.index] += c.delta;
    a.turnover = to;
    const prev = a.breakdown ?? ZERO;
    const prevSelected = a.selected;
    const { winner, tied } = selectPackage(this._packs(a), to);
    let crossed = oldHit !== hitTierIndex(a.tierAmounts);
    if (winner !== prevSelected) {
      a.selected = winner;
      a.tierAmounts = splitIntoTiers(this._packDef(a).tiers, to);
      crossed = true;
    }
    a.tied = tied;
    a.breakdown = computeFee(this._packDef(a), to);
    const invalidated = [`turnover:${a.id}`, `tiers:${a.id}`];
    if (crossed) {
      a.feeVersion += 1;
      a.invoiceVersion += 1;
      invalidated.push(`fee:${a.id}`, `invoice:${a.id}`);
    }
    for (const n of invalidated) this._node(n).dirty = true;
    return { prev, next: a.breakdown, crossed, invalidated };
  }

  _feeDiff(ev, a, r) {
    return {
      type: 'fee-diff',
      seq: this.seq,
      event: ev.type,
      account: a.id,
      prevFee: r.prev.net,
      fee: r.next.net,
      delta: r4(r.next.net - r.prev.net),
      tier: hitTierLabel(r.next),
      crossed: r.crossed,
      invalidated: r.invalidated,
      reasons: explain(r.prev, r.next),
    };
  }

  _getTrade(id) {
    const ref = this.trades.get(id);
    if (!ref) throw new EngineError(`unknown trade: ${id}`);
    return ref;
  }

  _checkAmount(ev) {
    if (!Number.isSafeInteger(ev.amount) || ev.amount === 0) {
      throw new EngineError(`trade ${ev.id}: amount must be a non-zero safe integer`);
    }
  }

  _onAccount(ev) {
    if (typeof ev.account !== 'string' || !ev.account) throw new EngineError('account event requires an account id');
    if (ev.packages !== undefined) {
      if (!Array.isArray(ev.packages) || ev.packages.some((p) => typeof p !== 'string')) {
        throw new EngineError('account packages must be an array of package ids');
      }
    }
    const a = this._account(ev.account);
    a.packages = ev.packages ?? null;
    if (a.selected) this._reselect(a);
    this.seq += 1;
    return { type: 'account', seq: this.seq, account: a.id, packages: a.packages };
  }

  _onTrade(ev) {
    if (typeof ev.id !== 'string' || typeof ev.account !== 'string' || !ev.id || !ev.account) {
      throw new EngineError('trade event requires id and account');
    }
    this._checkAmount(ev);
    if (this.trades.has(ev.id)) throw new EngineError(`duplicate trade id: ${ev.id}`);
    const a = this._account(ev.account);
    let t;
    if (ev.amount > 0) {
      t = { id: ev.id, amount: ev.amount, remaining: ev.amount, reversalOf: null };
    } else {
      if (typeof ev.of !== 'string') {
        throw new EngineError(`negative trade ${ev.id} must reference original trade via "of"`);
      }
      const orig = this.trades.get(ev.of);
      if (!orig) throw new EngineError(`reversal ${ev.id}: unknown original trade ${ev.of}`);
      if (orig.account !== ev.account) {
        throw new EngineError(`reversal ${ev.id}: original trade ${ev.of} belongs to another account`);
      }
      if (orig.t.reversalOf) throw new EngineError(`reversal ${ev.id}: cannot reverse a reversal`);
      const mag = -ev.amount;
      if (mag > orig.t.remaining) {
        throw new EngineError(`reversal ${ev.id} exceeds remaining amount of ${ev.of}`);
      }
      orig.t.remaining -= mag;
      t = { id: ev.id, amount: ev.amount, remaining: 0, reversalOf: ev.of };
    }
    a.trades.set(ev.id, t);
    this.trades.set(ev.id, { account: ev.account, t });
    this._node(`trade:${ev.id}`).dirty = true;
    const r = this._applyDelta(a, ev.amount);
    r.invalidated.unshift(`trade:${ev.id}`);
    a.active = true;
    this.seq += 1;
    return this._feeDiff(ev, a, r);
  }

  _onCancel(ev) {
    const ref = this._getTrade(ev.id);
    if (ref.t.reversalOf) throw new EngineError(`cannot cancel reversal ${ev.id}`);
    if (ref.t.remaining <= 0) throw new EngineError(`trade ${ev.id} is not active`);
    const a = this._account(ref.account);
    const delta = -ref.t.remaining;
    ref.t.remaining = 0;
    this._node(`trade:${ev.id}`).dirty = true;
    const r = this._applyDelta(a, delta);
    r.invalidated.unshift(`trade:${ev.id}`);
    a.active = true;
    this.seq += 1;
    return this._feeDiff(ev, a, r);
  }

  _onAmend(ev) {
    if (typeof ev.newId !== 'string' || !ev.newId) throw new EngineError('amend requires newId');
    this._checkAmount({ id: ev.newId, amount: ev.amount });
    if (ev.amount < 0) throw new EngineError(`amend ${ev.id}: new amount must be positive`);
    const ref = this._getTrade(ev.id);
    if (ref.t.reversalOf) throw new EngineError(`cannot amend reversal ${ev.id}`);
    if (ref.t.remaining <= 0) throw new EngineError(`trade ${ev.id} is not active`);
    if (this.trades.has(ev.newId)) throw new EngineError(`duplicate trade id: ${ev.newId}`);
    const a = this._account(ref.account);
    const r1 = this._applyDelta(a, -ref.t.remaining);
    ref.t.remaining = 0;
    this._node(`trade:${ev.id}`).dirty = true;
    const t = { id: ev.newId, amount: ev.amount, remaining: ev.amount, reversalOf: null };
    a.trades.set(ev.newId, t);
    this.trades.set(ev.newId, { account: ref.account, t });
    this._node(`trade:${ev.newId}`).dirty = true;
    const r2 = this._applyDelta(a, ev.amount);
    const r = {
      prev: r1.prev,
      next: r2.next,
      crossed: r1.crossed || r2.crossed,
      invalidated: [`trade:${ev.id}`, `trade:${ev.newId}`, ...new Set([...r1.invalidated, ...r2.invalidated])],
    };
    a.active = true;
    this.seq += 1;
    return this._feeDiff(ev, a, r);
  }

  _onRules(ev) {
    if (!RULE_VERSIONS[ev.version]) throw new EngineError(`unknown rule version: ${ev.version}`);
    const from = this.ruleVersion;
    this.ruleVersion = ev.version;
    this._node(`rules:${ev.version}`).dirty = true;
    const invalidated = [`rules:${ev.version}`];
    const fees = [];
    for (const a of this.accounts.values()) {
      if (!a.breakdown) continue;
      const prevFee = a.breakdown.net;
      this._reselect(a);
      a.feeVersion += 1;
      a.invoiceVersion += 1;
      this._node(`fee:${a.id}`).dirty = true;
      this._node(`invoice:${a.id}`).dirty = true;
      invalidated.push(`fee:${a.id}`, `invoice:${a.id}`);
      fees.push({ account: a.id, prevFee, fee: a.breakdown.net, delta: r4(a.breakdown.net - prevFee) });
    }
    this.seq += 1;
    return { type: 'rules', seq: this.seq, from, version: ev.version, invalidated, fees };
  }

  eod() {
    const out = [];
    for (const a of this.accounts.values()) {
      if (!a.active) continue;
      const b = a.breakdown ?? ZERO;
      const cert = certificate({
        day: this.day,
        account: a.id,
        ruleVersion: this.ruleVersion,
        package: a.selected,
        tied: a.tied,
        turnover: a.turnover,
        tiers: b.tiers,
        gross: b.gross,
        minFeeApplied: b.minFeeApplied,
        rebate: b.rebate,
        rebateId: b.rebateId,
        net: b.net,
        seq: this.seq,
        prev: a.certChain,
      });
      a.certChain = cert.hash;
      out.push({
        type: 'eod',
        account: a.id,
        day: this.day,
        ruleVersion: this.ruleVersion,
        package: a.selected,
        tied: a.tied,
        turnover: a.turnover,
        tiers: b.tiers,
        gross: b.gross,
        minFee: b.minFee,
        minFeeApplied: b.minFeeApplied,
        rebate: b.rebate,
        net: b.net,
        certificate: cert.hash,
        invoice: { key: `${this.day}:${a.id}`, amount: b.net },
      });
      for (const id of a.trades.keys()) this.trades.delete(id);
      a.trades.clear();
      a.turnover = 0;
      a.tierAmounts = [];
      a.selected = null;
      a.breakdown = null;
      a.tied = [];
      a.active = false;
    }
    for (const n of this.nodes.values()) n.dirty = false;
    return out;
  }

  apply(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
      throw new EngineError('event must be an object with a type');
    }
    switch (ev.type) {
      case 'account':
        return this._onAccount(ev);
      case 'trade':
        return this._onTrade(ev);
      case 'amend':
        return this._onAmend(ev);
      case 'cancel':
        return this._onCancel(ev);
      case 'rules':
        return this._onRules(ev);
      case 'eod':
        this.seq += 1;
        return this.eod();
      default:
        throw new EngineError(`unknown event type: ${ev.type}`);
    }
  }
}
