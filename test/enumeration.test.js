'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/sim');

// Independent reference state machine: pure set/order semantics, shares no
// code with the protocol implementation under test.
class RefReceiver {
  constructor(n) {
    this.n = n;
    this.next = 1;
    this.buf = new Set();
    this.lines = [];
  }
  deliver(seq) {
    if (seq >= this.next && !this.buf.has(seq)) this.buf.add(seq);
    while (this.buf.has(this.next)) {
      this.buf.delete(this.next);
      this.lines.push(this.next);
      this.next++;
    }
  }
  get complete() {
    return this.lines.length === this.n;
  }
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* products(choices, n) {
  if (n === 0) {
    yield [];
    return;
  }
  for (const c of choices) for (const rest of products(choices, n - 1)) yield [c, ...rest];
}

test('acceptance 4: enumerate all drop/dup/reorder sequences for <=5 lines vs reference', () => {
  let runs = 0;
  for (let n = 1; n <= 5; n++) {
    const seqs = Array.from({ length: n }, (_, i) => i + 1);
    for (const order of permutations(seqs)) {
      for (const pattern of products(['normal', 'dup', 'drop'], n)) {
        const engine = new Engine({ rtoMs: 500 });
        engine.submit({
          batch: 1,
          timeoutMs: 1000000,
          lines: seqs.map((s) => ({ lineNo: s, amount: '1.00', currency: 'USD', direction: 'pay' })),
        });
        const drop = seqs.filter((s) => pattern[s - 1] === 'drop');
        const dup = seqs.filter((s) => pattern[s - 1] === 'dup');
        const ref = new RefReceiver(n);
        for (const d of engine.pump({ order, drop, dup })) ref.deliver(d.seq);
        engine.tick(500); // retransmit dropped frames
        for (const d of engine.pump()) ref.deliver(d.seq);

        // Cross-check against the independent reference state machine.
        assert.equal(ref.complete, true);
        assert.deepEqual(ref.lines, seqs);

        const ledger = engine.ledger;
        for (const s of seqs) assert.equal(ledger.findLine(1, s).state, 'SETTLED');
        assert.equal(ledger.frozen, 0n);
        assert.equal(ledger.settledPay, BigInt(n) * 100n);
        if (runs % 977 === 0) assert.equal(ledger.verifyAudit(), true); // sampled
        runs++;
      }
    }
  }
  assert.equal(runs, 31287); // sum_{n=1..5} 3^n * n!
});
