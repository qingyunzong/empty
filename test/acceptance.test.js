'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { BusinessError } = require('../src/ledger');
const { AuditChain } = require('../src/audit');

function run(engine, cmds) {
  for (const cmd of cmds) engine.exec(cmd);
  return engine.output();
}

function baseAccounts() {
  return [
    { op: 'account', id: 'PAYER', balance: 100000 },
    { op: 'account', id: 'PAYEE', balance: 0 },
  ];
}

test('acceptance 1: multi-batch, reorder + duplicate + drop + retransmit, all settle', () => {
  const e = new Engine();
  const out = run(e, [
    ...baseAccounts(),
    { op: 'submit', batchId: 1, lines: [
      { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 100 },
      { lineNo: 2, from: 'PAYER', to: 'PAYEE', amount: 200 },
      { lineNo: 3, from: 'PAYER', to: 'PAYEE', amount: 300 },
    ] },
    { op: 'submit', batchId: 2, lines: [
      { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 50 },
      { lineNo: 2, from: 'PAYER', to: 'PAYEE', amount: 60 },
    ] },
    { op: 'send', batchId: 1 },
    { op: 'send', batchId: 2 },
    // link: frames are [b1l1, b1l2, b1l3, b2l1, b2l2]
    { op: 'link', action: 'swap', i: 0, j: 4 },   // reorder
    { op: 'link', action: 'dup', index: 2 },      // duplicate b1l3
    { op: 'link', action: 'drop', index: 1 },     // drop one frame
    { op: 'deliver', count: 'all' },
    { op: 'tick', ms: 1500 },                     // RTO -> retransmit unacked
    { op: 'deliver', count: 'all' },
    { op: 'settle_batch', batchId: 1 },
    { op: 'settle_batch', batchId: 2 },
  ]);

  assert.equal(out.code, 'OK');
  assert.deepEqual(out.lines.map((l) => l.state), ['SETTLED', 'SETTLED', 'SETTLED', 'SETTLED', 'SETTLED']);
  const payer = out.accounts.find((a) => a.id === 'PAYER');
  const payee = out.accounts.find((a) => a.id === 'PAYEE');
  assert.equal(payer.balance, 100000 - 710);
  assert.equal(payer.frozen, 0);
  assert.equal(payee.balance, 710);
  assert.ok(out.stats.duplicates >= 1);
  assert.ok(out.stats.outOfOrder >= 1);
  assert.ok(out.stats.retransmits >= 1);
  assert.deepEqual(out.batches.map((b) => b.state), ['SETTLED', 'SETTLED']);
  // audit certificate is independently verifiable
  assert.equal(AuditChain.verify(out.audit.events), out.audit.head);
});

test('acceptance 1b: freeze happens at submit, released per-line on NAK', () => {
  const e = new Engine();
  e.exec({ op: 'account', id: 'PAYER', balance: 1000 });
  e.exec({ op: 'account', id: 'PAYEE', balance: 0 });
  e.exec({ op: 'submit', batchId: 1, lines: [
    { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 100 },
    { lineNo: 2, from: 'PAYER', to: 'PAYEE', amount: 200 },
  ] });
  let out = e.output();
  assert.equal(out.accounts.find((a) => a.id === 'PAYER').frozen, 300);
  assert.equal(out.accounts.find((a) => a.id === 'PAYER').available, 700);

  e.exec({ op: 'send', batchId: 1 });
  e.exec({ op: 'deliver', count: 'all' });
  e.exec({ op: 'nak', batchId: 1, lineNo: 2 });   // partial NAK: unfreeze 200 only
  out = e.output();
  assert.equal(out.accounts.find((a) => a.id === 'PAYER').frozen, 100);
  assert.equal(out.lines.find((l) => l.lineNo === 2).state, 'REJECTED');

  e.exec({ op: 'settle', batchId: 1, lineNo: 1 });
  out = e.output();
  assert.equal(out.accounts.find((a) => a.id === 'PAYER').frozen, 0);
  assert.equal(out.accounts.find((a) => a.id === 'PAYEE').balance, 100);
});

test('acceptance 2: CRC error and half-frame, link recovers via retransmit', () => {
  const e = new Engine();
  const out = run(e, [
    ...baseAccounts(),
    { op: 'submit', batchId: 1, lines: [
      { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 10 },
      { lineNo: 2, from: 'PAYER', to: 'PAYEE', amount: 20 },
      { lineNo: 3, from: 'PAYER', to: 'PAYEE', amount: 30 },
    ] },
    { op: 'send', batchId: 1 },
    { op: 'link', action: 'corrupt', index: 0 },  // CRC error on first frame
    { op: 'link', action: 'split', index: 2, at: 7 }, // third frame split in two
    { op: 'deliver', count: 'all' },
  ]);
  assert.ok(out.stats.crcErrors >= 1);
  assert.ok(out.stats.split >= 1);
  // corrupted seq 0 lost -> later frames sit in the out-of-order buffer,
  // so no line is acked yet; the split frame was reassembled transparently
  assert.deepEqual(out.lines.map((l) => l.state), ['OPEN', 'OPEN', 'OPEN']);
  assert.ok(out.stats.outOfOrder >= 2);

  run(e, [
    { op: 'tick', ms: 1500 },   // RTO -> retransmit unacked frames
    { op: 'deliver', count: 'all' }, // gap closes, buffered frames drain
    { op: 'settle_batch', batchId: 1 },
  ]);
  const out2 = e.output();
  assert.deepEqual(out2.lines.map((l) => l.state), ['SETTLED', 'SETTLED', 'SETTLED']);
  assert.equal(out2.accounts.find((a) => a.id === 'PAYEE').balance, 60);
  assert.equal(AuditChain.verify(out2.audit.events), out2.audit.head);
});

test('acceptance 3: virtual clock timeout aborts batch and unfreezes everything', () => {
  const e = new Engine();
  e.exec({ op: 'account', id: 'PAYER', balance: 500 });
  e.exec({ op: 'account', id: 'PAYEE', balance: 0 });
  e.exec({ op: 'submit', batchId: 1, lines: [
    { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 100 },
    { lineNo: 2, from: 'PAYER', to: 'PAYEE', amount: 200 },
  ] });
  e.exec({ op: 'send', batchId: 1, lines: [1] });
  e.exec({ op: 'deliver', count: 'all' }); // only line 1 acked; line 2 never sent
  e.exec({ op: 'tick', ms: 10001 });       // batch timeout
  const out = e.output();
  assert.deepEqual(out.lines.map((l) => l.state), ['ABORTED', 'ABORTED']);
  assert.deepEqual(out.batches.map((b) => b.state), ['ABORTED']);
  const payer = out.accounts.find((a) => a.id === 'PAYER');
  assert.equal(payer.frozen, 0);
  assert.equal(payer.balance, 500);
  assert.equal(out.accounts.find((a) => a.id === 'PAYEE').balance, 0);
});

test('business rules: OPEN->ACKED->SETTLED order is enforced', () => {
  const e = new Engine();
  run(e, [
    ...baseAccounts(),
    { op: 'submit', batchId: 1, lines: [{ lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 10 }] },
  ]);
  assert.throws(() => e.exec({ op: 'settle', batchId: 1, lineNo: 1 }), BusinessError); // not ACKED yet
  run(e, [{ op: 'send', batchId: 1 }, { op: 'deliver', count: 'all' }, { op: 'settle', batchId: 1, lineNo: 1 }]);
  assert.throws(() => e.exec({ op: 'settle', batchId: 1, lineNo: 1 }), /immutable/);
  assert.throws(() => e.exec({ op: 'nak', batchId: 1, lineNo: 1 }), /immutable/);
});

test('business rules: SETTLED line corrected only by reversal line', () => {
  const e = new Engine();
  run(e, [
    ...baseAccounts(),
    { op: 'submit', batchId: 1, lines: [{ lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 100 }] },
    { op: 'send', batchId: 1 },
    { op: 'deliver', count: 'all' },
    { op: 'settle', batchId: 1, lineNo: 1 },
  ]);
  // reversal of a non-settled line is rejected
  assert.throws(() => e.exec({ op: 'submit', batchId: 2, lines: [
    { lineNo: 1, from: 'PAYEE', to: 'PAYER', amount: 100, reversalOf: { batchId: 1, lineNo: 9 } },
  ] }), BusinessError);
  // wrong amount is rejected
  assert.throws(() => e.exec({ op: 'submit', batchId: 2, lines: [
    { lineNo: 1, from: 'PAYEE', to: 'PAYER', amount: 99, reversalOf: { batchId: 1, lineNo: 1 } },
  ] }), BusinessError);
  // proper reversal goes through the normal flow
  const out = run(e, [
    { op: 'submit', batchId: 2, lines: [
      { lineNo: 1, from: 'PAYEE', to: 'PAYER', amount: 100, reversalOf: { batchId: 1, lineNo: 1 } },
    ] },
    { op: 'send', batchId: 2 },
    { op: 'deliver', count: 'all' },
    { op: 'settle', batchId: 2, lineNo: 1 },
  ]);
  assert.equal(out.accounts.find((a) => a.id === 'PAYER').balance, 100000);
  assert.equal(out.accounts.find((a) => a.id === 'PAYEE').balance, 0);
  const original = out.lines.find((l) => l.batchId === 1 && l.lineNo === 1);
  assert.equal(original.state, 'SETTLED'); // history untouched
  assert.deepEqual(original.reversedBy, { batchId: 2, lineNo: 1 });
  // double reversal rejected
  assert.throws(() => e.exec({ op: 'submit', batchId: 3, lines: [
    { lineNo: 1, from: 'PAYEE', to: 'PAYER', amount: 100, reversalOf: { batchId: 1, lineNo: 1 } },
  ] }), /IMMUTABLE_HISTORY|already reversed/);
});

test('business rules: insufficient funds and duplicate batch rejected', () => {
  const e = new Engine();
  e.exec({ op: 'account', id: 'PAYER', balance: 50 });
  e.exec({ op: 'account', id: 'PAYEE', balance: 0 });
  assert.throws(() => e.exec({ op: 'submit', batchId: 1, lines: [
    { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 51 },
  ] }), (err) => err.code === 'INSUFFICIENT_FUNDS');
  e.exec({ op: 'submit', batchId: 1, lines: [{ lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 50 }] });
  assert.throws(() => e.exec({ op: 'submit', batchId: 1, lines: [
    { lineNo: 1, from: 'PAYER', to: 'PAYEE', amount: 1 },
  ] }), BusinessError);
});
