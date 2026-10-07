import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { Frac, roundHalfEven } from '../src/frac.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- independent simulator ----------
// Snapshot-based reimplementation: no event tree, no replay. Each branch keeps
// a plain state object plus a history stack; merge copies child ops. Only the
// math primitives (Frac, roundHalfEven) are shared with the real ledger.
class Sim {
  constructor(limitStr) {
    this.limit = Frac.parse(limitStr);
    this.seq = 1; // next global event id (mirrors ledger node numbering)
    this.current = 'main';
    this.branches = new Map([['main', { state: this._fresh(), history: [], ops: [] }]]);
    this.checkpoints = new Map([[0, this._fresh()]]);
  }

  _fresh() {
    return { frozen: new Map(), captures: [] };
  }

  _clone(s) {
    return {
      frozen: new Map([...s.frozen].map(([k, v]) => [k, new Frac(v.num, v.den)])),
      captures: s.captures.map((c) => ({ ...c, amount: new Frac(c.amount.num, c.amount.den) })),
    };
  }

  _cur() {
    return this.branches.get(this.current);
  }

  _avail(s) {
    let used = new Frac(0n);
    for (const v of s.frozen.values()) used = used.add(v);
    for (const c of s.captures) if (!c.reversed) used = used.add(c.amount);
    return this.limit.sub(used);
  }

  _err(code, msg) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }

  _op(s, op, seq) {
    switch (op.type) {
      case 'freeze': {
        const amt = Frac.parse(op.amt);
        if (!(amt.num > 0n)) throw this._err('E_STATE', 'freeze amount must be positive');
        if (s.frozen.has(op.tx)) throw this._err('E_REF', 'duplicate tx');
        if (this._avail(s).cmp(amt) < 0) throw this._err('E_STATE', 'insufficient credit');
        s.frozen.set(op.tx, amt);
        return;
      }
      case 'capture': {
        const rem = s.frozen.get(op.tx);
        if (rem === undefined || rem.num === 0n) throw this._err('E_REF', 'no active freeze');
        const amt = Frac.parse(op.amt);
        if (!(amt.num > 0n)) throw this._err('E_STATE', 'capture amount must be positive');
        const r = roundHalfEven(amt);
        if (!(r.num > 0n)) throw this._err('E_STATE', 'rounds to zero');
        if (r.cmp(rem) > 0) throw this._err('E_STATE', 'exceeds frozen remainder');
        s.frozen.set(op.tx, rem.sub(r));
        s.captures.push({
          id: op.id ?? `cap#${seq}`,
          tx: op.tx,
          amount: r,
          reversed: false,
          eventId: String(seq),
        });
        return;
      }
      case 'void': {
        const rem = s.frozen.get(op.tx);
        if (rem === undefined || rem.num === 0n) throw this._err('E_REF', 'no active freeze');
        s.frozen.set(op.tx, new Frac(0n));
        return;
      }
      case 'reverse': {
        const cands = s.captures.filter((c) => !c.reversed && c.id === op.captureId);
        if (cands.length === 0) throw this._err('E_REF', 'no reversible capture');
        cands.sort(
          (a, b) =>
            a.amount.cmp(b.amount) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
        );
        cands[0].reversed = true;
        return;
      }
      default:
        throw this._err('E_PARSE', 'unknown op');
    }
  }

  apply(op) {
    const br = this._cur();
    switch (op.type) {
      case 'freeze':
      case 'capture':
      case 'void':
      case 'reverse': {
        const stored =
          op.type === 'capture' && op.id === undefined ? { ...op, id: `cap#${this.seq}` } : op;
        const next = this._clone(br.state);
        this._op(next, stored, this.seq); // validate on a clone: failures are atomic
        br.history.push(br.state);
        br.state = next;
        br.ops.push(stored);
        this.checkpoints.set(this.seq, this._clone(next));
        this.seq++;
        return;
      }
      case 'branch': {
        if (!this.checkpoints.has(op.fromEvent)) throw this._err('E_REF', 'unknown fromEvent');
        if (this.branches.has(op.name)) throw this._err('E_REF', 'duplicate branch');
        this.branches.set(op.name, {
          state: this._clone(this.checkpoints.get(op.fromEvent)),
          history: [],
          ops: [],
        });
        this.current = op.name;
        return;
      }
      case 'checkout': {
        if (!this.branches.has(op.name)) throw this._err('E_REF', 'unknown branch');
        this.current = op.name;
        return;
      }
      case 'merge': {
        if (!this.branches.has(op.branch)) throw this._err('E_REF', 'unknown branch');
        if (op.branch === this.current) throw this._err('E_REF', 'self merge');
        const child = this.branches.get(op.branch);
        const trial = this._clone(br.state);
        try {
          for (const cop of child.ops) this._op(trial, cop, -1);
        } catch (e) {
          throw this._err('E_STATE', `merge conflict: ${e.message}`);
        }
        for (const cop of child.ops) {
          br.history.push(br.state);
          const next = this._clone(br.state);
          this._op(next, cop, this.seq);
          br.state = next;
          br.ops.push(cop);
          this.checkpoints.set(this.seq, this._clone(next));
          this.seq++;
        }
        return;
      }
      case 'undo': {
        if (br.history.length === 0) throw this._err('E_STATE', 'nothing to undo');
        br.state = br.history.pop();
        br.ops.pop();
        return;
      }
      default:
        throw this._err('E_PARSE', 'unknown op');
    }
  }

  snapshot() {
    const s = this._cur().state;
    let frozenTotal = new Frac(0n);
    let debt = new Frac(0n);
    const frozen = {};
    for (const [k, v] of s.frozen) {
      frozenTotal = frozenTotal.add(v);
      if (v.num !== 0n) frozen[k] = v.toString();
    }
    for (const c of s.captures) if (!c.reversed) debt = debt.add(c.amount);
    return {
      available: this.limit.sub(frozenTotal).sub(debt).toString(),
      frozenTotal: frozenTotal.toString(),
      debt: debt.toString(),
      frozen,
      captures: s.captures.map((c) => ({
        id: c.id,
        tx: c.tx,
        amount: c.amount.toString(),
        reversed: c.reversed,
        eventId: c.eventId,
      })),
    };
  }
}

// ---------- random op generation ----------
const TXS = ['a', 'b', 'c', 'd'];
const BRANCHES = ['b1', 'b2', 'b3'];
const CAP_IDS = ['x', 'y', 'cap#1', 'cap#2', 'cap#3', 'cap#5', 'ghost'];
const AMOUNTS = ['1/3', '0.005', '10.005', '5/2', '7.25', '0.01', '100/3', '2', '0.1', '3.335', '12.34', '1/1000', '50/1'];

function genOp(rnd, maxSeq) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const kind = pick([
    'freeze', 'freeze', 'freeze',
    'capture', 'capture', 'capture',
    'void', 'reverse', 'branch', 'checkout', 'merge', 'undo',
  ]);
  switch (kind) {
    case 'freeze':
      return { type: 'freeze', tx: pick(TXS), amt: pick(AMOUNTS) };
    case 'capture': {
      const op = { type: 'capture', tx: pick(TXS), amt: pick(AMOUNTS) };
      if (rnd() < 0.5) op.id = pick(['x', 'y', 'z']);
      return op;
    }
    case 'void':
      return { type: 'void', tx: pick(TXS) };
    case 'reverse':
      return { type: 'reverse', captureId: pick(CAP_IDS) };
    case 'branch':
      return { type: 'branch', name: pick(BRANCHES), fromEvent: Math.floor(rnd() * (maxSeq + 1)) };
    case 'checkout':
      return { type: 'checkout', name: pick(['main', ...BRANCHES]) };
    case 'merge':
      return { type: 'merge', branch: pick(['main', ...BRANCHES]) };
    case 'undo':
      return { type: 'undo' };
    default:
      throw new Error('unreachable');
  }
}

function comparable(l) {
  const { available, frozenTotal, debt, frozen, captures } = l;
  return { available, frozenTotal, debt, frozen, captures };
}

// ---------- acceptance 4 ----------
test('acceptance 4: N<=10 random ops match an independent simulator (400 seeds)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rnd = mulberry32(seed);
    const ledger = new Ledger('200/1');
    const sim = new Sim('200/1');
    const n = 1 + Math.floor(rnd() * 10); // N in [1,10]
    for (let step = 0; step < n; step++) {
      const op = genOp(rnd, ledger.nodes.length - 1);
      let lErr = null;
      let sErr = null;
      try {
        ledger.apply(op);
      } catch (e) {
        lErr = e;
      }
      try {
        sim.apply(op);
      } catch (e) {
        sErr = e;
      }
      const ctx = `seed=${seed} step=${step} op=${JSON.stringify(op)}`;
      assert.equal(lErr?.code ?? null, sErr?.code ?? null, `error mismatch: ${ctx}`);
      if (!lErr) {
        assert.deepEqual(comparable(ledger.snapshot()), comparable(sim.snapshot()), `state mismatch: ${ctx}`);
      }
    }
  }
});
