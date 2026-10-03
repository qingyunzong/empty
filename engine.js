'use strict';
const { FRAME_TYPES, FRAME_TYPE_NAMES, REASONS, ValidationError } = require('./wire');

class UnknownCycleError extends Error {
  constructor(msg) { super(msg); this.name = 'UnknownCycleError'; this.exitCode = 3; }
}
class NegativeObligationError extends Error {
  constructor(msg) { super(msg); this.name = 'NegativeObligationError'; this.exitCode = 4; }
}

// Virtual clock: tick = number of frames consumed; cycle = currently open cycle.
// The clock advances (closing the open cycle) when a frame for cycle+1 arrives,
// or when closeAll() is called at end of input.
class Engine {
  constructor(banks) {
    this.banks = [...new Set(banks.map((b) => b.id))].sort();
    this.bankSet = new Set(this.banks);
    this.avail = new Map();
    this.frozen = new Map();
    for (const b of banks) {
      if (!this.avail.has(b.id)) this.avail.set(b.id, new Map());
      const m = this.avail.get(b.id);
      m.set(b.ccy, (m.get(b.ccy) || 0n) + BigInt(b.balance));
    }
    for (const id of this.bankSet) this.frozen.set(id, new Map());
    this.clock = { tick: 0, cycle: 1 };
    this.open = new Map();      // `${from}|${seq}` -> obligation (open cycle)
    this.openOrder = [];        // insertion order of open obligations
    this.acksSeen = new Set();  // `${acker}|${sender}|${seq}` dedup
    this.output = [];           // human-readable report lines
    this.cycleResults = [];     // structured per-cycle netting results
    this.compensations = [];    // unwind compensation entries
  }

  getAvail(bank, ccy) {
    const m = this.avail.get(bank);
    return (m && m.get(ccy)) || 0n;
  }
  addAvail(bank, ccy, delta) {
    const m = this.avail.get(bank);
    m.set(ccy, (m.get(ccy) || 0n) + delta);
  }
  getFrozen(bank, ccy) {
    const m = this.frozen.get(bank);
    return (m && m.get(ccy)) || 0n;
  }
  addFrozen(bank, ccy, delta) {
    const m = this.frozen.get(bank);
    m.set(ccy, (m.get(ccy) || 0n) + delta);
  }

  checkBank(id, role) {
    if (!this.bankSet.has(id)) {
      throw new ValidationError(`unknown ${role} bank '${id}'`);
    }
  }

  submit(frame) {
    this.clock.tick++;
    const cyc = frame.cycle;
    if (cyc === 0 || cyc > this.clock.cycle + 1) {
      throw new UnknownCycleError(
        `unknown cycle ${cyc} (open=${this.clock.cycle}, next=${this.clock.cycle + 1})`);
    }
    let late = false;
    if (cyc === this.clock.cycle + 1) {
      this.closeCycle();
      this.clock.cycle++;
    } else if (cyc < this.clock.cycle) {
      late = true; // message for a closed cycle is routed into the next (open) cycle
    }
    const c = this.clock.cycle;
    const lateTag = late ? ` late(from-closed-cycle=${cyc})` : '';
    const tname = FRAME_TYPE_NAMES[frame.type];
    this.checkBank(frame.from, 'from');
    this.checkBank(frame.to, 'to');

    switch (frame.type) {
      case FRAME_TYPES.OBLIGATION: {
        if (frame.amount < 0n) {
          throw new NegativeObligationError(
            `negative obligation ${frame.from}->${frame.to} amount=${frame.amount}`);
        }
        if (frame.amount === 0n) {
          throw new ValidationError('zero-amount obligation');
        }
        const key = `${frame.from}|${frame.seq}`;
        if (this.open.has(key)) {
          this.output.push(
            `[cycle ${c}] OBLIGATION duplicate ignored ${frame.from}->${frame.to} seq=${frame.seq}${lateTag}`);
          return;
        }
        const ob = {
          from: frame.from, to: frame.to, ccy: frame.ccy,
          amount: frame.amount, seq: frame.seq, acks: new Set(),
        };
        this.open.set(key, ob);
        this.openOrder.push(ob);
        this.output.push(
          `[cycle ${c}] OBLIGATION ${ob.from}->${ob.to} ${ob.amount} ${ob.ccy} seq=${ob.seq}${lateTag}`);
        return;
      }
      case FRAME_TYPES.ACK: {
        const akey = `${frame.from}|${frame.to}|${frame.seq}`;
        if (this.acksSeen.has(akey)) {
          this.output.push(
            `[cycle ${c}] ACK duplicate ignored ${frame.from}->${frame.to} seq=${frame.seq}${lateTag}`);
          return;
        }
        this.acksSeen.add(akey);
        const ob = this.open.get(`${frame.to}|${frame.seq}`);
        if (!ob) {
          this.output.push(
            `[cycle ${c}] ACK unknown obligation ${frame.to} seq=${frame.seq} ignored${lateTag}`);
          return;
        }
        ob.acks.add(frame.from);
        this.output.push(
          `[cycle ${c}] ACK confirmed ${frame.from}->${frame.to} seq=${frame.seq}${lateTag}`);
        return;
      }
      case FRAME_TYPES.NAK: {
        if (!REASONS[frame.reason]) {
          throw new ValidationError(`nak requires a valid reason code (got ${frame.reason})`);
        }
        const ob = this.open.get(`${frame.to}|${frame.seq}`);
        if (!ob) {
          this.output.push(
            `[cycle ${c}] NAK unknown obligation ${frame.to} seq=${frame.seq} reason=${REASONS[frame.reason]}${lateTag}`);
          return;
        }
        this.open.delete(`${frame.to}|${frame.seq}`);
        this.openOrder = this.openOrder.filter((o) => o !== ob);
        this.output.push(
          `[cycle ${c}] NAK ${frame.from} rejects ${frame.to} seq=${frame.seq} reason=${REASONS[frame.reason]} obligation-removed${lateTag}`);
        return;
      }
      case FRAME_TYPES.CANCEL: {
        const ob = this.open.get(`${frame.from}|${frame.seq}`);
        if (!ob) {
          this.output.push(
            `[cycle ${c}] CANCEL rejected ${frame.from} seq=${frame.seq}: not in open cycle (already settled or never existed)${lateTag}`);
          return;
        }
        this.open.delete(`${frame.from}|${frame.seq}`);
        this.openOrder = this.openOrder.filter((o) => o !== ob);
        this.output.push(
          `[cycle ${c}] CANCEL ${frame.from} seq=${frame.seq} obligation-removed${lateTag}`);
        return;
      }
      default:
        throw new ValidationError(`unsupported frame type ${frame.type}`);
    }
  }

  closeAll() {
    this.closeCycle();
  }

  closeCycle() {
    const c = this.clock.cycle;
    const obs = this.openOrder;
    this.output.push(`[cycle ${c}] CLOSE @vtick=${this.clock.tick} obligations=${obs.length}`);
    const byCcy = new Map();
    for (const ob of obs) {
      if (!byCcy.has(ob.ccy)) byCcy.set(ob.ccy, []);
      byCcy.get(ob.ccy).push(ob);
    }
    for (const ccy of [...byCcy.keys()].sort()) {
      this.settleCcy(c, ccy, byCcy.get(ccy));
    }
    this.open.clear();
    this.openOrder = [];
  }

  settleCcy(cycle, ccy, obs) {
    const gross = new Map(); // from -> Map(to -> amount)
    const net = new Map();   // bank -> net (positive = receiver)
    const involved = new Set();
    for (const ob of obs) {
      involved.add(ob.from);
      involved.add(ob.to);
      if (!gross.has(ob.from)) gross.set(ob.from, new Map());
      const row = gross.get(ob.from);
      row.set(ob.to, (row.get(ob.to) || 0n) + ob.amount);
      net.set(ob.from, (net.get(ob.from) || 0n) - ob.amount);
      net.set(ob.to, (net.get(ob.to) || 0n) + ob.amount);
    }
    const banks = [...involved].sort();
    const result = { cycle, ccy, banks, gross, net, status: null };

    this.output.push(`[cycle ${cycle}] CCY ${ccy} gross matrix (minor units):`);
    const w = 10;
    this.output.push(''.padEnd(w) + banks.map((b) => b.padStart(w)).join(''));
    for (const f of banks) {
      const cells = banks.map((t) => {
        if (f === t) return '-';
        const row = gross.get(f);
        const v = row && row.get(t);
        return v === undefined ? '0' : v.toString();
      });
      this.output.push(f.padEnd(w) + cells.map((s) => s.padStart(w)).join(''));
    }
    this.output.push(
      `[cycle ${cycle}] CCY ${ccy} net positions: ` +
      banks.map((b) => `${b}=${net.get(b) || 0n}`).join(' '));

    const payers = banks.filter((b) => (net.get(b) || 0n) < 0n);
    const receivers = banks.filter((b) => (net.get(b) || 0n) > 0n);

    // Liquidity freeze: every net payer must cover its full net debit.
    const frozenNow = [];
    let deficit = null;
    for (const p of payers) {
      const need = -(net.get(p));
      const avail = this.getAvail(p, ccy);
      if (avail >= need) {
        this.addAvail(p, ccy, -need);
        this.addFrozen(p, ccy, need);
        frozenNow.push({ bank: p, amount: need });
        this.output.push(
          `[cycle ${cycle}] FREEZE ${p} ${need} ${ccy} avail=${this.getAvail(p, ccy)} frozen=${this.getFrozen(p, ccy)}`);
      } else {
        deficit = { bank: p, need, avail };
        break;
      }
    }

    if (deficit) {
      // Unwind the whole ccy for this cycle: restore every freeze, no partial settlement.
      for (const f of frozenNow) {
        this.addFrozen(f.bank, ccy, -f.amount);
        this.addAvail(f.bank, ccy, f.amount);
        this.output.push(
          `[cycle ${cycle}] RELEASE-RESTORE ${f.bank} ${f.amount} ${ccy} avail=${this.getAvail(f.bank, ccy)}`);
      }
      result.status = 'UNWOUND';
      result.deficit = deficit;
      this.output.push(
        `[cycle ${cycle}] UNWIND-CERTIFICATE ccy=${ccy} reason=INSUFFICIENT_LIQUIDITY ` +
        `deficit=${deficit.bank} need=${deficit.need} avail=${deficit.avail}`);
      this.output.push(`[cycle ${cycle}]   restored-freezes: ` +
        (frozenNow.length ? frozenNow.map((f) => `${f.bank}=${f.amount}`).join(' ') : '(none)'));
      this.output.push(`[cycle ${cycle}]   compensation entries:`);
      for (const b of banks) {
        const n = net.get(b) || 0n;
        if (n === 0n) continue;
        const entry = {
          cycle, ccy, bank: b, amount: n,
          kind: n > 0n ? 'COMPENSATION_CLAIM' : 'COMPENSATION_DEBT',
        };
        this.compensations.push(entry);
        this.output.push(`[cycle ${cycle}]     ${entry.kind} ${b} ${n} ${ccy}`);
      }
      this.output.push(`[cycle ${cycle}]   status=NO_PARTIAL_SETTLEMENT`);
    } else {
      for (const f of frozenNow) {
        this.addFrozen(f.bank, ccy, -f.amount);
        this.output.push(
          `[cycle ${cycle}] SETTLE-DEBIT ${f.bank} ${f.amount} ${ccy} (freeze released)`);
      }
      for (const r of receivers) {
        const n = net.get(r);
        this.addAvail(r, ccy, n);
        this.output.push(
          `[cycle ${cycle}] SETTLE-CREDIT ${r} ${n} ${ccy} avail=${this.getAvail(r, ccy)}`);
      }
      result.status = 'SETTLED';
      this.output.push(`[cycle ${cycle}] CCY ${ccy} status=SETTLED`);
    }
    this.cycleResults.push(result);
  }

  finalReport() {
    const lines = ['FINAL BALANCES (avail / frozen):'];
    for (const b of this.banks) {
      const ccys = new Set([...this.avail.get(b).keys(), ...this.frozen.get(b).keys()]);
      for (const ccy of [...ccys].sort()) {
        lines.push(`  ${b} ${ccy} avail=${this.getAvail(b, ccy)} frozen=${this.getFrozen(b, ccy)}`);
      }
    }
    return lines;
  }
}

module.exports = { Engine, UnknownCycleError, NegativeObligationError };
