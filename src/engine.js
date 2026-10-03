// Incremental fee engine.
//
// Dependency graph per account:  trade -> tier accumulator -> fee -> invoice.
// - Tier accumulators are maintained differentially: a trade delta is
//   distributed across brackets instead of resumming history.
// - Invalidation propagates to the fee/invoice nodes only for accounts whose
//   hit tier (under their chosen package) actually changes; other accounts are
//   updated by a local delta ("fast path") and never enter the dirty queue.
// - Fee-package (re)registration switches the rate version and rewires the
//   graph: affected tier accumulators are rebuilt from current turnover.
// - certificate() deterministically hashes packages + trades + results, so a
//   full recompute of the same inputs always yields the same digest.

import { createHash } from 'node:crypto';
import {
  FeePackage,
  toCents,
  formatCents,
  tierAmountsFor,
  distributeDelta,
  hitTierFromAmounts,
} from './fees.js';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field}: expected a non-empty string id`);
  }
  return value;
}

export class FeeEngine {
  #packages = new Map(); // id -> FeePackage
  #trades = new Map(); // id -> { id, account, amountCents, ref? }
  #accounts = new Map(); // name -> account state

  stats = { fastPaths: 0, recomputes: 0, invalidated: [] };

  get packageCount() {
    return this.#packages.size;
  }

  get tradeCount() {
    return this.#trades.size;
  }

  accountNames() {
    return [...this.#accounts.keys()];
  }

  accountView(name) {
    const acct = this.#accounts.get(name);
    if (!acct) return null;
    return {
      account: name,
      turnoverCents: acct.turnoverCents,
      feeCents: acct.feeCents,
      hitTier: acct.hitTier,
      package: acct.chosen,
      tied: [...acct.tied],
    };
  }

  accountFees() {
    const fees = {};
    for (const [name, acct] of this.#accounts) fees[name] = acct.feeCents;
    return fees;
  }

  applyEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('event must be a JSON object');
    }
    switch (event.type) {
      case 'package':
        return this.#registerPackage(event);
      case 'deactivate':
        return this.#deactivatePackage(event);
      case 'trade':
        return this.#addTrade(event);
      case 'amend':
        return this.#amendTrade(event);
      case 'cancel':
        return this.#cancelTrade(event);
      case 'reversal':
        return this.#addReversal(event);
      default:
        throw new Error(`unknown event type: ${JSON.stringify(event.type)}`);
    }
  }

  #account(name) {
    let acct = this.#accounts.get(name);
    if (!acct) {
      acct = {
        turnoverCents: 0,
        perPackage: new Map(), // packageId -> { tierAmounts, hitTier, feeCents }
        feeCents: 0,
        hitTier: null,
        chosen: null,
        tied: [],
      };
      this.#accounts.set(name, acct);
    }
    return acct;
  }

  // Recompute one account's fee nodes from its (already maintained) tier
  // accumulators, pick the optimal package, and report the change if any.
  #refresh(name, propagate, reason) {
    const acct = this.#accounts.get(name);
    const prev = {
      feeCents: acct.feeCents,
      hitTier: acct.hitTier,
      chosen: acct.chosen,
    };
    const quotes = new Map();
    for (const [pkgId, pkg] of this.#packages) {
      let state = acct.perPackage.get(pkgId);
      if (!state) {
        state = {
          tierAmounts: tierAmountsFor(pkg.tiers, acct.turnoverCents),
          hitTier: null,
          feeCents: 0,
        };
        acct.perPackage.set(pkgId, state);
      }
      const quote = pkg.quoteFromTierAmounts(state.tierAmounts, acct.turnoverCents);
      state.hitTier = quote.hitTier;
      state.feeCents = quote.feeCents;
      quotes.set(pkgId, quote);
    }
    let minFee = Infinity;
    for (const quote of quotes.values()) minFee = Math.min(minFee, quote.feeCents);
    // All tied optimal packages are listed; the smallest rule id wins.
    const tied = [...quotes.entries()]
      .filter(([, quote]) => quote.feeCents === minFee)
      .map(([pkgId]) => pkgId)
      .sort();
    acct.feeCents = quotes.size > 0 ? minFee : 0;
    acct.tied = tied;
    acct.chosen = tied.length > 0 ? tied[0] : null;
    acct.hitTier = acct.chosen ? quotes.get(acct.chosen).hitTier : null;

    if (propagate) {
      this.stats.recomputes += 1;
      if (!this.stats.invalidated.includes(name)) this.stats.invalidated.push(name);
    } else {
      this.stats.fastPaths += 1;
    }

    if (
      acct.feeCents === prev.feeCents
      && acct.hitTier === prev.hitTier
      && acct.chosen === prev.chosen
    ) {
      return null;
    }
    return {
      account: name,
      previousFeeCents: prev.feeCents,
      feeCents: acct.feeCents,
      hitTier: acct.hitTier,
      package: acct.chosen,
      tied: [...acct.tied],
      crossed: propagate,
      reason,
    };
  }

  // Core incremental step: fold a signed turnover delta into the account.
  #applyDelta(name, deltaCents, reason) {
    const acct = this.#account(name);
    const before = acct.turnoverCents;
    const after = before + deltaCents;
    if (after < 0) {
      throw new Error(
        `account ${name}: turnover would become negative (${formatCents(after)})`,
      );
    }
    const oldHit = acct.hitTier;
    const oldChosen = acct.chosen;
    acct.turnoverCents = after;
    // Differential maintenance of per-tier amounts for every wired package.
    for (const [pkgId, state] of acct.perPackage) {
      const pkg = this.#packages.get(pkgId);
      if (!pkg) continue;
      const deltas = distributeDelta(pkg.tiers, before, deltaCents);
      state.tierAmounts = state.tierAmounts.map((value, i) => value + deltas[i]);
    }
    // Cross-tier detection on the currently chosen package.
    let crossed;
    if (oldChosen && this.#packages.has(oldChosen)) {
      const state = acct.perPackage.get(oldChosen);
      crossed = hitTierFromAmounts(state.tierAmounts) !== oldHit;
    } else {
      crossed = after > 0 && this.#packages.size > 0;
    }
    return this.#refresh(name, crossed, reason);
  }

  #registerPackage(event) {
    const pkg = new FeePackage(event);
    this.#packages.set(pkg.id, pkg); // same id => rate version switch
    const reason = `package ${pkg.id} v${pkg.version} active`;
    const changes = [];
    for (const name of this.#accounts.keys()) {
      const acct = this.#accounts.get(name);
      // Topology changed: rebuild this accumulator from current turnover.
      acct.perPackage.set(pkg.id, {
        tierAmounts: tierAmountsFor(pkg.tiers, acct.turnoverCents),
        hitTier: null,
        feeCents: 0,
      });
      const change = this.#refresh(name, true, reason);
      if (change) changes.push(change);
    }
    return changes;
  }

  #deactivatePackage(event) {
    const pkgId = requireId(event.packageId, 'deactivate');
    if (!this.#packages.has(pkgId)) {
      throw new Error(`deactivate: unknown package ${pkgId}`);
    }
    this.#packages.delete(pkgId);
    const reason = `package ${pkgId} deactivated`;
    const changes = [];
    for (const name of this.#accounts.keys()) {
      const acct = this.#accounts.get(name);
      acct.perPackage.delete(pkgId);
      const change = this.#refresh(name, true, reason);
      if (change) changes.push(change);
    }
    return changes;
  }

  #addTrade(event) {
    const id = requireId(event.id, 'trade');
    if (this.#trades.has(id)) throw new Error(`trade ${id}: duplicate trade id`);
    if (typeof event.account !== 'string' || event.account.length === 0) {
      throw new Error(`trade ${id}: "account" must be a non-empty string`);
    }
    const amountCents = toCents(event.amount, `trade ${id} "amount"`);
    if (amountCents <= 0) {
      throw new Error(
        `trade ${id}: amount must be positive; negative amounts are only allowed `
        + 'as a reversal referencing the original trade',
      );
    }
    this.#trades.set(id, { id, account: event.account, amountCents });
    const change = this.#applyDelta(
      event.account,
      amountCents,
      `trade ${id} +${formatCents(amountCents)}`,
    );
    return change ? [change] : [];
  }

  #amendTrade(event) {
    const id = requireId(event.id, 'amend');
    const old = this.#trades.get(id);
    if (!old) throw new Error(`amend ${id}: no such active trade`);
    const amountCents = toCents(event.amount, `amend ${id} "amount"`);
    if (amountCents <= 0) {
      throw new Error(`amend ${id}: amount must be positive; use cancel to remove the trade`);
    }
    // Amend == cancel old + add new, applied as one net delta: no double count.
    this.#trades.set(id, { id, account: old.account, amountCents });
    const change = this.#applyDelta(
      old.account,
      amountCents - old.amountCents,
      `amend ${id} ${formatCents(old.amountCents)} -> ${formatCents(amountCents)} (cancel+add)`,
    );
    return change ? [change] : [];
  }

  #cancelTrade(event) {
    const id = requireId(event.id, 'cancel');
    const trade = this.#trades.get(id);
    if (!trade) throw new Error(`cancel ${id}: no such active trade`);
    this.#trades.delete(id);
    const change = this.#applyDelta(
      trade.account,
      -trade.amountCents,
      `cancel ${id} ${formatCents(-trade.amountCents)}`,
    );
    return change ? [change] : [];
  }

  #addReversal(event) {
    const id = requireId(event.id, 'reversal');
    if (this.#trades.has(id)) throw new Error(`reversal ${id}: duplicate trade id`);
    const ref = requireId(event.ref, `reversal ${id} "ref"`);
    const original = this.#trades.get(ref);
    if (!original) {
      throw new Error(`reversal ${id}: referenced trade ${ref} is not active`);
    }
    if (original.amountCents <= 0) {
      throw new Error(`reversal ${id}: referenced trade ${ref} is itself a reversal`);
    }
    const amountCents = toCents(event.amount, `reversal ${id} "amount"`);
    if (amountCents >= 0) {
      throw new Error(`reversal ${id}: amount must be negative`);
    }
    this.#trades.set(id, { id, account: original.account, amountCents, ref });
    const change = this.#applyDelta(
      original.account,
      amountCents,
      `reversal ${id} of ${ref} ${formatCents(amountCents)}`,
    );
    return change ? [change] : [];
  }

  snapshot() {
    // Non-negative trades first: replaying this order keeps every account's
    // turnover non-negative throughout restore (reversals always reference a
    // positive original, and the final turnover is known to be >= 0).
    const trades = [...this.#trades.values()];
    const ordered = [
      ...trades.filter((trade) => trade.amountCents >= 0),
      ...trades.filter((trade) => trade.amountCents < 0),
    ];
    return {
      packages: [...this.#packages.values()].map((pkg) => pkg.spec),
      trades: ordered.map((trade) => ({
        id: trade.id,
        account: trade.account,
        amount: trade.amountCents / 100,
        ...(trade.ref ? { ref: trade.ref } : {}),
      })),
    };
  }

  static restore(snapshot) {
    const engine = new FeeEngine();
    for (const spec of snapshot.packages ?? []) {
      engine.applyEvent({ type: 'package', ...spec });
    }
    for (const trade of snapshot.trades ?? []) {
      if (trade.amount >= 0) {
        engine.applyEvent({ type: 'trade', ...trade });
      } else {
        engine.applyEvent({ type: 'reversal', ...trade });
      }
    }
    return engine;
  }

  certificate() {
    const accounts = [...this.#accounts.entries()]
      .filter(([, acct]) => acct.turnoverCents !== 0 || acct.feeCents !== 0)
      .map(([name, acct]) => ({
        name,
        turnoverCents: acct.turnoverCents,
        feeCents: acct.feeCents,
        hitTier: acct.hitTier,
        chosen: acct.chosen,
        tied: [...acct.tied],
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const payload = canonical({
      packages: [...this.#packages.values()]
        .map((pkg) => pkg.spec)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      trades: [...this.#trades.values()]
        .map((trade) => ({
          id: trade.id,
          account: trade.account,
          amountCents: trade.amountCents,
          ref: trade.ref ?? null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      accounts,
    });
    return {
      algorithm: 'sha256',
      digest: createHash('sha256').update(payload).digest('hex'),
      accounts: accounts.length,
      trades: this.#trades.size,
    };
  }
}
