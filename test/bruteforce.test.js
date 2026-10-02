import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frac } from '../src/fraction.js';
import { Ledger } from '../src/engine.js';
import { parseLine } from '../src/events.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Naive reference: recomputes everything from the raw event list, from
// scratch, on every query. Deliberately shares no state with Ledger.
class BruteForce {
  constructor(base) {
    this.base = base;
    this.events = [];
  }

  apply(ev) {
    this.events.push(ev);
  }

  effective() {
    const byEid = new Map(this.events.map((e) => [e.eid, e]));
    const voided = new Set();
    for (const e of this.events) {
      if (e.type === 'undo' && !voided.has(e.eid)) voided.add(e.eventId);
    }
    const valueOf = new Map();
    for (const e of this.events) {
      if (e.type !== 'addInvoice' && e.type !== 'setRate') continue;
      let value = new Frac(e.num, e.den);
      for (const c of this.events) {
        if (c.type !== 'correct' || voided.has(c.eid)) continue;
        let t = byEid.get(c.refId);
        while (t && t.type === 'correct') t = byEid.get(t.refId);
        if (t && t.eid === e.eid) value = new Frac(c.newNum, c.newDen);
      }
      valueOf.set(e.eid, value);
    }
    return { voided, valueOf };
  }

  compute() {
    const { voided, valueOf } = this.effective();
    const positions = new Map();
    const edges = [];
    for (const e of this.events) {
      if (voided.has(e.eid)) continue;
      const value = valueOf.get(e.eid);
      if (e.type === 'addInvoice') {
        const key = `${e.id} ${e.ccy}`;
        positions.set(key, (positions.get(key) ?? Frac.zero()).add(value));
      } else if (e.type === 'setRate') {
        edges.push({ from: e.from, to: e.to, rate: value });
      }
    }
    // Naive per-component propagation, recomputed from scratch.
    const adj = new Map();
    const ccys = new Set();
    for (const e of edges) {
      ccys.add(e.from);
      ccys.add(e.to);
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from).push({ peer: e.to, rate: e.rate, forward: true });
      adj.get(e.to).push({ peer: e.from, rate: e.rate, forward: false });
    }
    const p = new Map();
    const reachable = new Set();
    let conflict = false;
    const visit = (seed, track) => {
      if (p.has(seed)) return;
      p.set(seed, Frac.one());
      const stack = [seed];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (track) reachable.add(cur);
        for (const { peer, rate, forward } of adj.get(cur) ?? []) {
          const expect = forward ? p.get(cur).div(rate) : p.get(cur).mul(rate);
          if (!p.has(peer)) {
            p.set(peer, expect);
            stack.push(peer);
          } else if (!p.get(peer).eq(expect)) {
            conflict = true;
          }
        }
      }
    };
    visit(this.base, true);
    for (const c of ccys) visit(c, false);
    if (conflict) return { status: 'infeasible' };
    const nets = new Map();
    for (const [key, amt] of positions) {
      if (amt.isZero()) continue;
      const [party, ccy] = key.split(' ');
      if (!reachable.has(ccy)) return { status: 'pending' };
      const pot = p.get(ccy);
      nets.set(party, (nets.get(party) ?? Frac.zero()).add(amt.mul(pot)));
    }
    const out = {};
    for (const [party, net] of nets) out[party] = net.toString();
    return { status: 'ok', nets: out };
  }
}

function generate(rand, n) {
  const lines = [];
  const voided = new Set();
  const baseEvents = []; // eids of addInvoice/setRate
  const activeBase = () => baseEvents.filter((e) => !voided.has(e.eid));
  for (let i = 1; i <= n; i += 1) {
    const eid = `e${i}`;
    const roll = rand();
    const actives = activeBase();
    if (roll < 0.45 || actives.length === 0 && roll < 0.7) {
      const party = `P${1 + Math.floor(rand() * 3)}`;
      const ccy = ['USD', 'CNY', 'EUR'][Math.floor(rand() * 3)];
      const num = Math.floor(rand() * 41) - 20;
      const den = 1 + Math.floor(rand() * 9);
      lines.push(`{"type":"addInvoice","eid":"${eid}","id":"${party}","ccy":"${ccy}","num":${num},"den":${den}}`);
      baseEvents.push({ eid, kind: 'addInvoice' });
    } else if (roll < 0.7) {
      const ccys = ['USD', 'CNY', 'EUR'];
      const from = ccys.splice(Math.floor(rand() * 3), 1)[0];
      const to = ccys[Math.floor(rand() * 2)];
      const num = 1 + Math.floor(rand() * 9);
      const den = 1 + Math.floor(rand() * 9);
      lines.push(`{"type":"setRate","eid":"${eid}","pair":"${from}/${to}","num":${num},"den":${den}}`);
      baseEvents.push({ eid, kind: 'setRate' });
    } else if (roll < 0.85 && actives.length > 0) {
      const t = actives[Math.floor(rand() * actives.length)];
      const num = t.kind === 'setRate' ? 1 + Math.floor(rand() * 9) : Math.floor(rand() * 41) - 20;
      const den = 1 + Math.floor(rand() * 9);
      lines.push(`{"type":"correct","eid":"${eid}","refId":"${t.eid}","newNum":${num},"newDen":${den}}`);
    } else if (actives.length > 0) {
      const t = actives[Math.floor(rand() * actives.length)];
      voided.add(t.eid);
      lines.push(`{"type":"undo","eid":"${eid}","eventId":"${t.eid}"}`);
    } else {
      const party = `P${1 + Math.floor(rand() * 3)}`;
      lines.push(`{"type":"addInvoice","eid":"${eid}","id":"${party}","ccy":"CNY","num":1,"den":1}`);
      baseEvents.push({ eid, kind: 'addInvoice' });
    }
  }
  return lines;
}

test('acceptance 3: random N<=8 logs match brute-force enumeration', () => {
  const rand = mulberry32(981273);
  const iterations = 400;
  const seen = { ok: 0, infeasible: 0, pending: 0 };
  for (let iter = 0; iter < iterations; iter += 1) {
    const n = 1 + Math.floor(rand() * 8);
    const lines = generate(rand, n);
    const engine = new Ledger({ base: 'CNY' });
    const brute = new BruteForce('CNY');
    lines.forEach((s, i) => {
      engine.applyLine(s, i + 1);
      brute.apply(parseLine(s, i + 1));
    });
    const got = engine.settle();
    const want = brute.compute();
    assert.equal(got.status, want.status, `iter ${iter} status\n${lines.join('\n')}`);
    seen[got.status] += 1;
    if (want.status === 'ok') {
      const gotNets = Object.fromEntries(got.nets.map((x) => [x.party, x.exact]));
      assert.deepEqual(gotNets, want.nets, `iter ${iter} nets\n${lines.join('\n')}`);
    }
  }
  assert.ok(seen.ok > 0, 'expected some feasible cases');
  assert.ok(seen.infeasible > 0, 'expected some infeasible cases');
  assert.ok(seen.pending > 0, 'expected some pending cases');
});
