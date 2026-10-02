'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

class Ledger {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.marginRate = options.marginRate ?? 1;
    this.trades = new Map(); // id -> trade
    this.pairs = new Map(); // pairKey -> {ids:Set, net, from, to, frozen}
    this.frozenBy = new Map(); // party -> total frozen margin
    this.journal = []; // atomic batches, one entry per recompute
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this._load();
    }
  }

  _file() {
    return path.join(this.dir, 'ledger.json');
  }

  _load() {
    if (!fs.existsSync(this._file())) return;
    const json = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
    this.trades = new Map(json.trades.map((t) => [t.id, t]));
    this.journal = json.journal || [];
    this.pairs = new Map();
    this.frozenBy = new Map();
    for (const t of this.trades.values()) {
      const key = pairKey(t.buyer, t.seller);
      if (!this.pairs.has(key)) {
        this.pairs.set(key, { ids: new Set(), net: 0, from: null, to: null, frozen: 0 });
      }
      this.pairs.get(key).ids.add(t.id);
    }
    for (const key of this.pairs.keys()) this._recomputePair(key, { persist: false });
  }

  _persist() {
    if (!this.dir) return;
    const json = {
      trades: [...this.trades.values()],
      journal: this.journal,
    };
    const tmp = this._file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
    fs.renameSync(tmp, this._file());
  }

  _getPair(key) {
    if (!this.pairs.has(key)) {
      this.pairs.set(key, { ids: new Set(), net: 0, from: null, to: null, frozen: 0 });
    }
    return this.pairs.get(key);
  }

  addTrade({ id, buyer, seller, amount, desc = '' }) {
    if (id === undefined || id === null || id === '') {
      throw new LedgerError('INVALID_ID', 'trade id is required');
    }
    if (this.trades.has(id)) {
      throw new LedgerError('DUPLICATE_TRADE', `trade ${id} already exists`);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new LedgerError('INVALID_AMOUNT', `amount must be a positive finite number, got ${amount}`);
    }
    if (!buyer || !seller || buyer === seller) {
      throw new LedgerError('INVALID_PARTIES', 'buyer and seller must be distinct non-empty parties');
    }
    const trade = { id, buyer, seller, amount, desc, state: 'live' };
    this.trades.set(id, trade);
    const key = pairKey(buyer, seller);
    this._getPair(key).ids.add(id);
    const certificate = this._recomputePair(key);
    this._persist();
    return { trade, certificate };
  }

  revokeTrade(id) {
    const trade = this.trades.get(id);
    if (!trade) throw new LedgerError('UNKNOWN_TRADE', `trade ${id} not found`);
    if (trade.state !== 'live') {
      throw new LedgerError('NOT_LIVE', `trade ${id} is ${trade.state}, cannot revoke`);
    }
    trade.state = 'revoked';
    const certificate = this._recomputePair(pairKey(trade.buyer, trade.seller));
    this._persist();
    return certificate;
  }

  deleteTrade(id) {
    const trade = this.trades.get(id);
    if (!trade) throw new LedgerError('UNKNOWN_TRADE', `trade ${id} not found`);
    if (trade.state === 'deleted') {
      throw new LedgerError('DUPLICATE_DELETE', `trade ${id} already deleted`);
    }
    trade.state = 'deleted';
    const certificate = this._recomputePair(pairKey(trade.buyer, trade.seller));
    this._persist();
    return certificate;
  }

  liveTrades(a, b) {
    const key = pairKey(a, b);
    const pair = this.pairs.get(key);
    if (!pair) return [];
    return [...pair.ids]
      .map((id) => this.trades.get(id))
      .filter((t) => t.state === 'live');
  }

  // Reference semantics: enumerate live trades, net from canonical first party's view.
  _recomputePair(key, { persist = true } = {}) {
    const pair = this._getPair(key);
    const [p1, p2] = key.split('|');
    let net = 0;
    for (const id of pair.ids) {
      const t = this.trades.get(id);
      if (t.state !== 'live') continue;
      net += t.buyer === p1 ? t.amount : -t.amount;
    }
    const margin = Math.ceil(Math.abs(net) * this.marginRate);
    const from = net > 0 ? p1 : net < 0 ? p2 : null;
    const to = net > 0 ? p2 : net < 0 ? p1 : null;

    const old = { net: pair.net, from: pair.from, frozen: pair.frozen };
    const reversed = old.from !== null && from !== null && old.from !== from;

    // Build atomic batch: release old freeze, then freeze per new direction.
    const ops = [];
    if (old.frozen > 0 && (old.from !== from || old.frozen !== margin)) {
      ops.push({ type: 'release', party: old.from, amount: old.frozen });
    }
    if (margin > 0 && (old.from !== from || old.frozen !== margin)) {
      ops.push({ type: 'freeze', party: from, amount: margin });
    }
    if (ops.length > 0) this._applyBatch(ops);

    pair.net = net;
    pair.from = from;
    pair.to = to;
    pair.frozen = margin;

    return {
      pair: [p1, p2],
      net,
      direction: from === null ? 'FLAT' : `${from}->${to}`,
      margin,
      reversed,
      batch: ops,
    };
  }

  // Atomic: validate every op first, then apply all, then journal as one entry.
  _applyBatch(ops) {
    for (const op of ops) {
      if (op.type === 'release') {
        const frozen = this.frozenBy.get(op.party) || 0;
        if (op.amount > frozen) {
          throw new LedgerError('BATCH_INVALID',
            `cannot release ${op.amount} from ${op.party}: only ${frozen} frozen`);
        }
      }
    }
    for (const op of ops) {
      const cur = this.frozenBy.get(op.party) || 0;
      if (op.type === 'release') this.frozenBy.set(op.party, cur - op.amount);
      else this.frozenBy.set(op.party, cur + op.amount);
    }
    this.journal.push({ seq: this.journal.length, ops });
  }

  getNet(a, b) {
    const pair = this.pairs.get(pairKey(a, b));
    if (!pair) return { net: 0, direction: 'FLAT', margin: 0 };
    return {
      net: pair.net,
      direction: pair.from === null ? 'FLAT' : `${pair.from}->${pair.to}`,
      margin: pair.frozen,
    };
  }

  frozenOf(party) {
    return this.frozenBy.get(party) || 0;
  }

  hash() {
    const rows = [...this.trades.values()]
      .map((t) => [t.id, t.buyer, t.seller, t.amount, t.desc, t.state].join('|'))
      .sort();
    return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
  }
}

module.exports = { Ledger, LedgerError, pairKey };
