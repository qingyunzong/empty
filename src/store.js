import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tokenize } from './tokenize.js';
import { PositionalIndex } from './index.js';
import { Ledger } from './ledger.js';
import { pairKey, computeNet } from './settlement.js';
import { round6 } from './reference.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const collator = new Intl.Collator('en', { numeric: true });

export class TradeStore {
  constructor(dir, { marginRate = 0.1, compactionThreshold = 0.5 } = {}) {
    this.dir = dir;
    this.marginRate = marginRate;
    this.trades = new Map();
    this.settlements = new Map();
    this.ledger = new Ledger();
    this.index = new PositionalIndex(dir, { compactionThreshold });
  }

  static open(dir, opts = {}) {
    const store = new TradeStore(dir, opts);
    store.index = PositionalIndex.open(dir, opts);
    const tradesPath = path.join(dir, 'trades.json');
    if (fs.existsSync(tradesPath)) {
      const raw = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
      for (const t of raw.trades) store.trades.set(t.id, t);
      store.ledger = new Ledger(raw.accounts ?? {});
      for (const t of raw.trades) {
        store.ledger.ensure(t.buyer);
        store.ledger.ensure(t.seller);
      }
      const keys = new Set();
      for (const t of store.trades.values()) {
        if (t.state === 'active') keys.add(pairKey(t.buyer, t.seller));
      }
      for (const key of [...keys].sort()) {
        const [a, b] = key.split('');
        store.#recomputePair(a, b);
      }
    }
    return store;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const accounts = {};
    for (const [name, acc] of this.ledger.accounts) {
      if (acc.balance !== null) accounts[name] = acc.balance;
    }
    fs.writeFileSync(
      path.join(this.dir, 'trades.json'),
      JSON.stringify({ trades: [...this.trades.values()], accounts }),
    );
    this.index.save();
  }

  #getTrade(id) {
    const t = this.trades.get(id);
    if (!t) throw new StoreError('UNKNOWN_TRADE', `unknown trade: ${id}`);
    return t;
  }

  addTrade({ id, buyer, seller, amount, desc = '' }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new StoreError('INVALID_TRADE', 'id must be a non-empty string');
    }
    if (this.trades.has(id)) {
      throw new StoreError('DUPLICATE_ID', `trade already exists: ${id}`);
    }
    for (const [field, v] of [['buyer', buyer], ['seller', seller]]) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new StoreError('INVALID_TRADE', `${field} must be a non-empty string`);
      }
    }
    if (buyer === seller) {
      throw new StoreError('INVALID_TRADE', 'buyer and seller must differ');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new StoreError(
        'NEGATIVE_AMOUNT',
        `amount must be a positive finite number, got ${amount}`,
      );
    }
    const trade = { id, buyer, seller, amount, desc: String(desc), state: 'active' };
    this.ledger.ensure(buyer);
    this.ledger.ensure(seller);
    this.trades.set(id, trade);
    let settlement;
    try {
      settlement = this.#recomputePair(buyer, seller);
    } catch (err) {
      this.trades.delete(id);
      throw err;
    }
    this.index.addDocument(id, tokenize(desc));
    return { trade, settlement };
  }

  revokeTrade(id) {
    const t = this.#getTrade(id);
    if (t.state !== 'active') {
      throw new StoreError('INVALID_STATE', `cannot revoke trade ${id} in state ${t.state}`);
    }
    t.state = 'revoked';
    try {
      return this.#recomputePair(t.buyer, t.seller);
    } catch (err) {
      t.state = 'active';
      throw err;
    }
  }

  deleteTrade(id) {
    const t = this.trades.get(id);
    if (!t) throw new StoreError('UNKNOWN_TRADE', `unknown trade: ${id}`);
    if (t.state === 'deleted') {
      throw new StoreError('DUPLICATE_DELETE', `trade already deleted: ${id}`);
    }
    const prev = t.state;
    t.state = 'deleted';
    let settlement = null;
    if (prev === 'active') {
      try {
        settlement = this.#recomputePair(t.buyer, t.seller);
      } catch (err) {
        t.state = prev;
        throw err;
      }
    }
    const tombstoned = this.index.deleteDocument(id);
    return { id, tombstoned, settlement };
  }

  // Recompute net, direction and margin freeze for one pair. Release of the
  // old freeze and the new freeze are applied as a single atomic batch.
  #recomputePair(a, b) {
    const key = pairKey(a, b);
    const before =
      this.settlements.get(key) ?? { net: 0, payer: null, payee: null, frozen: 0 };
    const { net, payer, payee } = computeNet([...this.trades.values()], a, b);
    const margin = round6(Math.abs(net) * this.marginRate);
    const ops = [];
    if (before.payer && before.frozen > 0) {
      ops.push({ op: 'release', account: before.payer, amount: before.frozen });
    }
    if (payer && margin > 0) {
      ops.push({ op: 'freeze', account: payer, amount: margin });
    }
    this.ledger.applyBatch(ops);
    const after = { net, payer, payee, frozen: margin };
    this.settlements.set(key, after);
    return {
      pair: [a, b].sort(),
      net,
      direction: payer ? { payer, payee } : 'flat',
      reversed: Boolean(before.payer && payer && before.payer !== payer),
      batch: ops,
      before,
      after,
    };
  }

  pairSettlement(a, b) {
    return (
      this.settlements.get(pairKey(a, b)) ?? {
        net: 0,
        payer: null,
        payee: null,
        frozen: 0,
      }
    );
  }

  phraseQuery(text) {
    const terms = tokenize(text);
    if (terms.length === 0) throw new StoreError('EMPTY_QUERY', 'query has no terms');
    const maps = terms.map((t) => this.index.getPostings(t));
    let ids = [...maps[0].keys()];
    for (const m of maps.slice(1)) ids = ids.filter((id) => m.has(id));
    const hits = [];
    for (const id of ids) {
      const trade = this.trades.get(id);
      if (!trade || trade.state === 'deleted') continue;
      for (const start of maps[0].get(id)) {
        let ok = true;
        for (let i = 1; i < terms.length; i++) {
          if (!maps[i].get(id).includes(start + i)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          hits.push({ id, position: start });
          break;
        }
      }
    }
    hits.sort((a, b) => collator.compare(a.id, b.id));
    return this.#certificate('phrase', terms, { hits });
  }

  nearQuery(text, k = 10) {
    const terms = tokenize(text);
    if (terms.length === 0) throw new StoreError('EMPTY_QUERY', 'query has no terms');
    if (!Number.isInteger(k) || k < terms.length) {
      throw new StoreError('BAD_WINDOW', `k must be an integer >= ${terms.length}`);
    }
    const maps = terms.map((t) => this.index.getPostings(t));
    let ids = [...maps[0].keys()];
    for (const m of maps.slice(1)) ids = ids.filter((id) => m.has(id));
    const hits = [];
    for (const id of ids) {
      const trade = this.trades.get(id);
      if (!trade || trade.state === 'deleted') continue;
      const pts = [];
      maps.forEach((m, ti) => {
        for (const p of m.get(id)) pts.push([p, ti]);
      });
      pts.sort((a, b) => a[0] - b[0]);
      hits.push({ id, ...TradeStore.#minWindow(pts, terms.length) });
    }
    const valid = hits.filter((h) => h.window !== null && h.window <= k);
    valid.sort((a, b) => a.window - b.window || collator.compare(a.id, b.id));
    const bestWindow = valid.length ? valid[0].window : null;
    const best = valid.length
      ? valid.filter((h) => h.window === bestWindow).sort((a, b) => collator.compare(a.id, b.id))[0].id
      : null;
    return this.#certificate('near', terms, { k, hits: valid, bestWindow, best });
  }

  static #minWindow(pts, termCount) {
    const count = new Array(termCount).fill(0);
    let have = 0;
    let left = 0;
    let best = null;
    for (let right = 0; right < pts.length; right++) {
      if (count[pts[right][1]]++ === 0) have++;
      while (have === termCount) {
        const len = pts[right][0] - pts[left][0] + 1;
        if (!best || len < best.window) {
          best = { window: len, start: pts[left][0], end: pts[right][0] };
        }
        if (--count[pts[left][1]] === 0) have--;
        left++;
      }
    }
    return best ?? { window: null, start: null, end: null };
  }

  #certificate(type, terms, extra) {
    const hits = extra.hits;
    const hash = createHash('sha256')
      .update(JSON.stringify({ type, terms, hits }))
      .digest('hex');
    return {
      type,
      terms,
      ...extra,
      segments: this.index.segmentReport(),
      hash,
    };
  }

  compact() {
    return this.index.compact();
  }

  snapshot() {
    return JSON.stringify({
      trades: [...this.trades.values()],
      settlements: [...this.settlements.entries()].sort(),
      accounts: this.ledger.snapshot(),
      tombstones: [...this.index.tombstones.entries()]
        .map(([k, v]) => [k, [...v].sort()])
        .sort(),
      segments: this.index.segmentReport(),
    });
  }
}
