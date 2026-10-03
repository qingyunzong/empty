'use strict';

const { TYPES, TYPE_NAMES, REASONS } = require('./frame');
const { computeNetting } = require('./netting');

class EngineError extends Error {
  constructor(message, exitCode, code) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

function bankName(id) {
  return id < 26 ? String.fromCharCode(65 + id) : `B${id}`;
}

function reasonName(code) {
  return REASONS[code] || `REASON_${code}`;
}

// Settlement engine.
//
// Cycle semantics:
//  - The virtual clock only advances via TICK frames; a cycle spans cycleMs.
//  - Frames for the open cycle are applied immediately.
//  - Frames for openCycle+1 are buffered and applied when that cycle opens.
//  - Frames for an already closed cycle are late: they are redirected into
//    the open cycle ("after close, messages go to the next cycle").
//  - Anything else is an unknown cycle (exit 3).
//
// Settlement at cycle close, per currency:
//  - Active obligations (not cancelled, not nacked) are netted multilaterally.
//  - Net payers are frozen, net receivers credited, frozen funds released.
//  - If any net payer has insufficient liquidity, the whole currency unwinds:
//    every freeze is restored, compensations are generated for net receivers,
//    and no partial settlement takes place.
class Engine {
  constructor(opts = {}) {
    this.cycleMs = opts.cycleMs ?? 60000;
    this.clock = 0;
    this.openCycle = 0;
    this.events = [];
    this.cycles = new Map();
    this.closed = [];
    this.seen = new Set();
    this.buffer = [];
    this.positions = null; // null = unlimited liquidity
    if (opts.positions) {
      this.positions = new Map();
      for (const [bank, ccys] of Object.entries(opts.positions)) {
        const m = new Map();
        for (const [ccy, amt] of Object.entries(ccys)) m.set(ccy, BigInt(amt));
        this.positions.set(bank, m);
      }
    }
  }

  event(kind, data = {}) {
    this.events.push({ kind, clock: this.clock, ...data });
  }

  cycleState(c) {
    if (!this.cycles.has(c)) {
      this.cycles.set(c, {
        obligations: new Map(), // "from:seq" -> obligation
        pendingAcks: new Map(), // "from:seq" -> frame (out-of-order)
        pendingNaks: new Map(),
        pendingCancels: new Map(),
      });
    }
    return this.cycles.get(c);
  }

  available(name, ccy) {
    if (!this.positions) return null; // unlimited
    const m = this.positions.get(name);
    if (!m) return 0n;
    return m.get(ccy) ?? 0n;
  }

  move(name, ccy, delta) {
    if (!this.positions) return;
    if (!this.positions.has(name)) this.positions.set(name, new Map());
    const m = this.positions.get(name);
    m.set(ccy, (m.get(ccy) ?? 0n) + delta);
  }

  ingest(frame) {
    if (frame.type === TYPES.TICK) return this.tick(frame);
    const fk = [frame.type, frame.cycle, frame.from, frame.to, frame.seq, frame.amount, frame.reason].join(':');
    if (this.seen.has(fk)) {
      this.event('duplicate-frame', {
        type: TYPE_NAMES[frame.type], from: bankName(frame.from), seq: frame.seq, cycle: frame.cycle,
      });
      return;
    }
    this.seen.add(fk);
    const c = frame.cycle;
    if (c === this.openCycle) return this.apply(frame, c);
    if (c === this.openCycle + 1) {
      this.buffer.push(frame);
      this.event('buffered', {
        type: TYPE_NAMES[frame.type], from: bankName(frame.from), seq: frame.seq, cycle: c,
      });
      return;
    }
    if (c < this.openCycle) {
      this.event('late-redirect', {
        type: TYPE_NAMES[frame.type], from: bankName(frame.from), seq: frame.seq,
        frameCycle: c, cycle: this.openCycle,
      });
      return this.apply(frame, this.openCycle, c);
    }
    throw new EngineError(
      `unknown cycle ${c} (open cycle is ${this.openCycle}; only the open cycle and the next one are valid)`,
      3, 'UNKNOWN_CYCLE',
    );
  }

  apply(frame, cycle, origCycle = cycle) {
    const st = this.cycleState(cycle);
    const late = origCycle !== cycle;
    switch (frame.type) {
      case TYPES.OBLIGATION: {
        if (frame.amount <= 0n) {
          throw new EngineError(
            `negative obligation: ${bankName(frame.from)} seq=${frame.seq} amount=${frame.amount}`,
            4, 'NEGATIVE_OBLIGATION',
          );
        }
        const key = `${frame.from}:${frame.seq}`;
        if (st.obligations.has(key)) {
          this.event('seq-conflict', { cycle, from: bankName(frame.from), seq: frame.seq });
          return;
        }
        const obl = {
          from: frame.from, to: frame.to, ccy: frame.ccy, amount: frame.amount,
          seq: frame.seq, cycle, acked: false, nacked: false, cancelled: false, reason: 0,
        };
        st.obligations.set(key, obl);
        this.event('obligation', {
          cycle, from: bankName(obl.from), to: bankName(obl.to),
          ccy: obl.ccy, amount: obl.amount, seq: obl.seq, late,
        });
        // apply out-of-order control frames that arrived earlier
        const nak = st.pendingNaks.get(key);
        if (nak) { st.pendingNaks.delete(key); this.applyNak(obl, nak, cycle); }
        const ack = st.pendingAcks.get(key);
        if (ack) { st.pendingAcks.delete(key); this.applyAck(obl, ack, cycle); }
        if (st.pendingCancels.has(key)) {
          st.pendingCancels.delete(key);
          obl.cancelled = true;
          this.event('cancel', {
            cycle, from: bankName(obl.from), seq: obl.seq,
            note: 'matched pending out-of-order cancel',
          });
        }
        break;
      }
      case TYPES.ACK: {
        const key = `${frame.to}:${frame.seq}`;
        const obl = st.obligations.get(key);
        if (!obl) {
          st.pendingAcks.set(key, frame);
          this.event('ack-pending', {
            cycle, from: bankName(frame.from), forBank: bankName(frame.to), seq: frame.seq,
          });
          return;
        }
        this.applyAck(obl, frame, cycle);
        break;
      }
      case TYPES.NAK: {
        if (frame.reason === 0) {
          throw new EngineError(
            `nak from ${bankName(frame.from)} seq=${frame.seq} carries no reason code`,
            2, 'NAK_REASON_REQUIRED',
          );
        }
        const key = `${frame.to}:${frame.seq}`;
        const obl = st.obligations.get(key);
        if (!obl) {
          st.pendingNaks.set(key, frame);
          this.event('nak-pending', {
            cycle, from: bankName(frame.from), forBank: bankName(frame.to),
            seq: frame.seq, reason: reasonName(frame.reason),
          });
          return;
        }
        this.applyNak(obl, frame, cycle);
        break;
      }
      case TYPES.CANCEL: {
        const key = `${frame.from}:${frame.seq}`;
        const obl = st.obligations.get(key);
        if (!obl) {
          st.pendingCancels.set(key, frame);
          this.event('cancel-pending', {
            cycle, from: bankName(frame.from), seq: frame.seq, late,
          });
          return;
        }
        if (obl.cancelled) {
          this.event('cancel-duplicate', { cycle, from: bankName(frame.from), seq: frame.seq });
          return;
        }
        obl.cancelled = true;
        this.event('cancel', { cycle, from: bankName(frame.from), seq: frame.seq, late });
        break;
      }
    }
  }

  applyAck(obl, frame, cycle) {
    if (frame.from !== obl.to) {
      this.event('ack-ignored', {
        cycle, from: bankName(frame.from), seq: frame.seq,
        note: `sender is not the counterparty ${bankName(obl.to)}`,
      });
      return;
    }
    if (obl.acked) {
      this.event('ack-duplicate', {
        cycle, from: bankName(frame.from), forBank: bankName(obl.from), seq: obl.seq,
      });
      return;
    }
    obl.acked = true;
    this.event('ack', { cycle, from: bankName(frame.from), forBank: bankName(obl.from), seq: obl.seq });
  }

  applyNak(obl, frame, cycle) {
    obl.nacked = true;
    obl.reason = frame.reason;
    this.event('nak', {
      cycle, from: bankName(frame.from), forBank: bankName(obl.from), seq: obl.seq,
      reason: reasonName(frame.reason), supersededAck: obl.acked,
    });
  }

  tick(frame) {
    const delta = Number(frame.amount);
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      throw new EngineError(`tick delta must be a positive integer (got ${frame.amount})`, 2, 'BAD_TICK');
    }
    this.clock += delta;
    this.event('tick', { delta, clock: this.clock });
    while (this.clock >= (this.openCycle + 1) * this.cycleMs) this.closeCycle();
  }

  closeCycle() {
    const c = this.openCycle;
    const st = this.cycleState(c);
    const active = [...st.obligations.values()].filter((o) => !o.cancelled && !o.nacked);
    const byCcy = new Map();
    for (const o of active) {
      if (!byCcy.has(o.ccy)) byCcy.set(o.ccy, []);
      byCcy.get(o.ccy).push(o);
    }
    const result = { cycle: c, clock: this.clock, ccys: [] };
    for (const ccy of [...byCcy.keys()].sort()) {
      const obls = byCcy.get(ccy);
      const { matrix, net } = computeNetting(obls);
      const banks = [...net.keys()].sort((a, b) => a - b);
      const payers = banks.filter((b) => net.get(b) < 0n);
      const receivers = banks.filter((b) => net.get(b) > 0n);
      const res = {
        ccy, matrix, net, banks, status: 'settled',
        freezes: [], releases: [], credits: [], compensations: [], certificate: null,
      };
      const frozen = [];
      let failure = null;
      for (const b of payers) {
        const need = -net.get(b);
        const avail = this.available(bankName(b), ccy);
        if (avail !== null && avail < need) {
          failure = { bank: bankName(b), needed: need, available: avail };
          break;
        }
        if (avail !== null) this.move(bankName(b), ccy, -need);
        frozen.push({ bank: b, amount: need });
        res.freezes.push({ bank: bankName(b), amount: need });
        this.event('freeze', { cycle: c, ccy, bank: bankName(b), amount: need });
      }
      if (failure) {
        // whole-ccy unwind: restore every freeze, compensate receivers,
        // no partial settlement.
        for (const f of frozen) {
          if (this.positions) this.move(bankName(f.bank), ccy, f.amount);
          res.releases.push({ bank: bankName(f.bank), amount: f.amount, reason: 'unwind' });
          this.event('release', { cycle: c, ccy, bank: bankName(f.bank), amount: f.amount, reason: 'unwind' });
        }
        for (const b of receivers) {
          const comp = { bank: bankName(b), amount: net.get(b) };
          res.compensations.push(comp);
          this.event('compensation', { cycle: c, ccy, bank: comp.bank, amount: comp.amount });
        }
        res.status = 'unwound';
        res.certificate = {
          cycle: c,
          ccy,
          reason: `${failure.bank} insufficient liquidity: needs ${failure.needed} ${ccy}, has ${failure.available}`,
          obligations: obls.map((o) => ({
            from: bankName(o.from), to: bankName(o.to), ccy, amount: o.amount, seq: o.seq,
          })),
          compensations: res.compensations,
          partialSettlement: 'forbidden',
        };
        this.event('unwind', { cycle: c, ccy, reason: res.certificate.reason });
      } else {
        for (const f of frozen) {
          res.releases.push({ bank: bankName(f.bank), amount: f.amount, reason: 'settled' });
          this.event('release', { cycle: c, ccy, bank: bankName(f.bank), amount: f.amount, reason: 'settled' });
        }
        for (const b of receivers) {
          const amt = net.get(b);
          if (this.positions) this.move(bankName(b), ccy, amt);
          res.credits.push({ bank: bankName(b), amount: amt });
          this.event('credit', { cycle: c, ccy, bank: bankName(b), amount: amt });
        }
      }
      result.ccys.push(res);
    }
    for (const [key] of st.pendingCancels) this.event('cancel-expired', { cycle: c, key });
    for (const [key] of st.pendingAcks) this.event('ack-expired', { cycle: c, key });
    for (const [key] of st.pendingNaks) this.event('nak-expired', { cycle: c, key });
    this.closed.push(result);
    this.event('cycle-close', { cycle: c });
    this.openCycle++;
    const buf = this.buffer;
    this.buffer = [];
    for (const f of buf) this.apply(f, this.openCycle);
  }

  positionsSnapshot() {
    if (!this.positions) return null;
    const out = {};
    for (const [bank, m] of this.positions) {
      out[bank] = {};
      for (const [ccy, a] of m) out[bank][ccy] = a.toString();
    }
    return out;
  }
}

module.exports = { Engine, EngineError, bankName, reasonName };
