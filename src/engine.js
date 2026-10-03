'use strict';
const { createHash } = require('node:crypto');
const { Calendar, parseDate } = require('./calendar');
const { DepGraph } = require('./graph');

const ZERO_HASH = '0'.repeat(64);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function sha(s) { return createHash('sha256').update(s).digest('hex'); }
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function validateTrade(p) {
  if (!p || typeof p.id !== 'string' || !p.id) throw new Error('trade: id required');
  for (const f of ['payCcy', 'recvCcy']) {
    if (typeof p[f] !== 'string' || !p[f]) throw new Error(`trade: ${f} required`);
  }
  if (p.payCcy === p.recvCcy) throw new Error('trade: payCcy and recvCcy must differ');
  for (const f of ['payAmt', 'recvAmt']) {
    if (typeof p[f] !== 'number' || !(p[f] > 0)) throw new Error(`trade: positive ${f} required`);
  }
  if (typeof p.valueDate !== 'string') throw new Error('trade: valueDate required');
  parseDate(p.valueDate);
  const maturity = p.maturity === undefined ? `${p.valueDate}T00:00:00.000Z` : p.maturity;
  if (typeof maturity !== 'string' || Number.isNaN(Date.parse(maturity))) {
    throw new Error('trade: invalid maturity');
  }
  const [ccyA, ccyB] = [p.payCcy, p.recvCcy].sort();
  return {
    id: p.id, payCcy: p.payCcy, payAmt: r6(p.payAmt),
    recvCcy: p.recvCcy, recvAmt: r6(p.recvAmt),
    requested: p.valueDate, maturity, ccyA, ccyB,
  };
}

class Engine {
  constructor() {
    this.calendars = new Map();
    this.calendar = null;
    this.trades = new Map();
    this.compensations = [];
    this.liquidity = new Map();
    this.journal = [];
    this.queues = new Map();
    this.queueContrib = new Map();
    this.exposures = new Map();
    this.pairs = new Map();
    this._pairSeq = 0;
    this.deliverablesCache = [];
    this.graph = new DepGraph();
    this.graph.addNode('calendar', () => {});
    this.graph.addNode('settle', () => this._computeDeliverables());
  }

  _requireCalendar() {
    if (!this.calendar) throw new Error('no calendar set; issue a calendar op first');
  }

  _getTrade(id) {
    if (typeof id !== 'string' || !this.trades.has(id)) throw new Error(`unknown trade: ${id}`);
    return this.trades.get(id);
  }

  _keyFor(tr) {
    const pair = [tr.payCcy, tr.recvCcy].sort().join('/');
    return `${pair}|${this.calendar.adjust(tr.requested)}`;
  }

  _ensureQueueNode(key) {
    const id = `queue:${key}`;
    if (!this.graph.nodes.has(id)) {
      this.graph.addNode(id, () => this._recomputeQueue(key));
      this.graph.addEdge(id, 'settle');
    }
    return id;
  }

  _registerTrade(tr) {
    const id = `trade:${tr.id}`;
    this.graph.addNode(id, () => {
      const key = this._keyFor(tr);
      if (key !== tr.key) {
        const old = tr.key;
        if (tr.status === 'PAIRED' && tr.pairId) {
          const pr = this.pairs.get(tr.pairId);
          if (pr) {
            const otherId = pr.a === tr.id ? pr.b : pr.a;
            const o = this.trades.get(otherId);
            if (o && o.pairId === tr.pairId) {
              o.status = 'OPEN';
              o.pairId = null;
            }
            this.pairs.delete(tr.pairId);
          }
          tr.status = 'OPEN';
          tr.pairId = null;
        }
        tr.key = key;
        if (old) {
          this.graph.removeEdge(id, `queue:${old}`);
          this.graph.invalidate(`queue:${old}`);
        }
        this.graph.addEdge(id, this._ensureQueueNode(key));
        this.graph.invalidate(`queue:${key}`);
      }
    });
    this.graph.addEdge('calendar', id);
  }

  _apply(op, p) {
    switch (op) {
      case 'calendar': {
        const cal = new Calendar(p && p.version, (p && p.holidays) || []);
        this.calendars.set(cal.version, cal);
        this.calendar = cal;
        this.graph.invalidate('calendar');
        this.graph.recompute();
        return { version: cal.version };
      }
      case 'trade': {
        this._requireCalendar();
        const tr = validateTrade(p);
        if (this.trades.has(tr.id)) throw new Error(`duplicate trade id: ${tr.id}`);
        tr.status = 'OPEN';
        tr.pairId = null;
        tr.key = null;
        this.trades.set(tr.id, tr);
        this._registerTrade(tr);
        this.graph.invalidate(`trade:${tr.id}`);
        this.graph.recompute();
        return { id: tr.id, valueDate: tr.key.split('|')[1] };
      }
      case 'cancel': {
        const tr = this._getTrade(p && p.id);
        if (tr.status === 'CANCELLED') throw new Error(`trade already cancelled: ${tr.id}`);
        tr.status = 'CANCELLED';
        tr.pairId = null;
        const comp = {
          id: `COMP-${tr.id}`,
          forTrade: tr.id,
          pair: [tr.payCcy, tr.recvCcy].sort().join('/'),
          legs: [
            { ccy: tr.payCcy, amount: r6(-tr.payAmt) },
            { ccy: tr.recvCcy, amount: r6(-tr.recvAmt) },
          ],
          reason: 'CANCEL_COMPENSATION',
          valueDate: tr.key.split('|')[1],
        };
        this.compensations.push(comp);
        this.graph.invalidate(`queue:${tr.key}`);
        this.graph.recompute();
        return { cancelled: tr.id, compensation: comp };
      }
      case 'delay': {
        this._requireCalendar();
        const tr = this._getTrade(p && p.id);
        if (tr.status === 'CANCELLED') throw new Error(`cannot delay cancelled trade: ${tr.id}`);
        if (typeof p.valueDate !== 'string') throw new Error('delay: valueDate required');
        parseDate(p.valueDate);
        tr.requested = p.valueDate;
        this.graph.invalidate(`trade:${tr.id}`);
        this.graph.recompute();
        return { id: tr.id, valueDate: tr.key.split('|')[1] };
      }
      case 'reprice': {
        const tr = this._getTrade(p && p.id);
        if (tr.status === 'CANCELLED') throw new Error(`cannot reprice cancelled trade: ${tr.id}`);
        if (typeof p.rate !== 'number' || !(p.rate > 0)) throw new Error('reprice: positive rate required');
        tr.recvAmt = r6(tr.payAmt * p.rate);
        this.graph.invalidate(`queue:${tr.key}`);
        this.graph.recompute();
        return { id: tr.id, recvAmt: tr.recvAmt };
      }
      case 'liquidity': {
        if (!p || typeof p.ccy !== 'string' || !p.ccy) throw new Error('liquidity: ccy required');
        if (typeof p.amount !== 'number' || !(p.amount >= 0)) throw new Error('liquidity: non-negative amount required');
        this.liquidity.set(p.ccy, r6(p.amount));
        this.graph.invalidate('settle');
        this.graph.recompute();
        return { ccy: p.ccy, amount: this.liquidity.get(p.ccy) };
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  apply(op, payload = {}) {
    const result = this._apply(op, payload);
    const seq = this.journal.length + 1;
    const prev = this.journal.length ? this.journal[this.journal.length - 1].hash : ZERO_HASH;
    const hash = sha(stable({ seq, op, payload, prev }));
    this.journal.push({ seq, op, payload, prev, hash });
    return result;
  }

  _addExposure(ccy, amt) {
    const v = r6((this.exposures.get(ccy) || 0) + amt);
    if (v === 0) this.exposures.delete(ccy);
    else this.exposures.set(ccy, v);
  }

  _recomputeQueue(key) {
    for (const [pid, pr] of [...this.pairs]) {
      if (pr.key === key) {
        for (const tid of [pr.a, pr.b]) {
          const t = this.trades.get(tid);
          if (t && t.status === 'PAIRED' && t.pairId === pid) {
            t.status = 'OPEN';
            t.pairId = null;
          }
        }
        this.pairs.delete(pid);
      }
    }
    const members = [...this.trades.values()]
      .filter((t) => t.status !== 'CANCELLED' && t.key === key)
      .sort((a, b) => cmpStr(a.maturity, b.maturity) || cmpStr(a.id, b.id));
    const waiting = new Map();
    for (const t of members) {
      const other = t.payCcy === t.ccyA ? t.ccyB : t.ccyA;
      const u = waiting.get(other);
      if (u) {
        waiting.delete(other);
        const pid = `P${++this._pairSeq}`;
        t.status = 'PAIRED';
        u.status = 'PAIRED';
        t.pairId = pid;
        u.pairId = pid;
        this.pairs.set(pid, { id: pid, a: u.id, b: t.id, key });
      } else if (!waiting.has(t.payCcy)) {
        waiting.set(t.payCcy, t);
      }
    }
    const contrib = new Map();
    for (const t of members) {
      contrib.set(t.payCcy, r6((contrib.get(t.payCcy) || 0) - t.payAmt));
      contrib.set(t.recvCcy, r6((contrib.get(t.recvCcy) || 0) + t.recvAmt));
    }
    const old = this.queueContrib.get(key);
    if (old) for (const [c, a] of old) this._addExposure(c, -a);
    for (const [c, a] of contrib) this._addExposure(c, a);
    this.queueContrib.set(key, contrib);
    this.queues.set(key, members.filter((t) => t.status === 'OPEN').map((t) => t.id));
  }

  _computeDeliverables() {
    const items = [];
    for (const t of this.trades.values()) {
      if (t.status !== 'PAIRED') continue;
      items.push({
        instruction: `SI-${t.id}`,
        tradeId: t.id,
        pairId: t.pairId,
        ccy: t.payCcy,
        amount: t.payAmt,
        valueDate: t.key.split('|')[1],
        maturity: t.maturity,
        status: 'DELIVERABLE',
      });
    }
    items.sort((a, b) =>
      cmpStr(a.valueDate, b.valueDate) || cmpStr(a.maturity, b.maturity) || cmpStr(a.tradeId, b.tradeId));
    const avail = new Map(this.liquidity);
    for (const it of items) {
      const a = avail.get(it.ccy) || 0;
      if (a + 1e-9 >= it.amount) {
        avail.set(it.ccy, r6(a - it.amount));
      } else {
        it.status = 'PENDING';
        it.reason = `INSUFFICIENT_LIQUIDITY:${it.ccy}`;
      }
    }
    const open = [...this.trades.values()]
      .filter((t) => t.status === 'OPEN')
      .sort((a, b) => cmpStr(a.maturity, b.maturity) || cmpStr(a.id, b.id));
    for (const t of open) {
      items.push({
        instruction: `SI-${t.id}`,
        tradeId: t.id,
        ccy: t.payCcy,
        amount: t.payAmt,
        valueDate: t.key.split('|')[1],
        maturity: t.maturity,
        status: 'PENDING',
        reason: 'UNMATCHED',
      });
    }
    this.deliverablesCache = items;
  }

  deliverables() {
    this.graph.recompute();
    return this.deliverablesCache.map((d) => ({ ...d }));
  }

  exposureList() {
    return [...this.exposures.entries()]
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([ccy, amount]) => ({ ccy, amount }));
  }

  queueSnapshot() {
    return [...this.queues.entries()]
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([key, ids]) => ({ key, open: [...ids] }));
  }

  stateHash() {
    const trades = [...this.trades.values()]
      .map((t) => ({
        id: t.id, status: t.status, payCcy: t.payCcy, payAmt: t.payAmt,
        recvCcy: t.recvCcy, recvAmt: t.recvAmt, requested: t.requested,
        maturity: t.maturity, key: t.key, pairId: t.pairId,
      }))
      .sort((a, b) => cmpStr(a.id, b.id));
    const queues = [...this.queues.entries()]
      .map(([k, v]) => [k, [...v]])
      .sort(([a], [b]) => cmpStr(a, b));
    return sha(stable({
      calendar: this.calendar ? this.calendar.version : null,
      trades,
      queues,
      exposures: [...this.exposures.entries()].sort(([a], [b]) => cmpStr(a, b)),
      compensations: this.compensations,
      liquidity: [...this.liquidity.entries()].sort(([a], [b]) => cmpStr(a, b)),
      pairs: [...this.pairs.keys()].sort(),
    }));
  }

  static replay(events) {
    const eng = new Engine();
    for (const ev of events) {
      eng.apply(ev.op, ev.payload);
      const last = eng.journal[eng.journal.length - 1];
      if (ev.hash && ev.hash !== last.hash) {
        throw new Error(`journal hash mismatch at seq ${ev.seq}`);
      }
    }
    return eng;
  }

  proof() {
    const replica = Engine.replay(this.journal);
    const replayHash = replica.stateHash();
    const stateHash = this.stateHash();
    return {
      events: this.journal.length,
      head: this.journal.length ? this.journal[this.journal.length - 1].hash : ZERO_HASH,
      stateHash,
      replayHash,
      ok: stateHash === replayHash,
    };
  }
}

module.exports = { Engine, stable, sha, r6, ZERO_HASH };
