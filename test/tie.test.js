import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeEngine } from '../src/engine.js';

// Two structurally different packages that cost exactly the same at 100000:
// p1: flat 0.1%            -> 100.00
// p2: 0.15% up to 50000,   ->  75.00
//     0.05% above          ->  25.00   (total 100.00)
const P1 = { type: 'package', id: 'p1', version: 1, tiers: [{ upTo: null, rate: 0.001 }] };
const P2 = {
  type: 'package',
  id: 'p2',
  version: 1,
  tiers: [
    { upTo: 50000, rate: 0.0015 },
    { upTo: null, rate: 0.0005 },
  ],
};

test('tied optimal packages are all listed, smallest rule id wins', () => {
  const engine = new FeeEngine();
  engine.applyEvent(P2); // registration order must not matter
  engine.applyEvent(P1);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  const view = engine.accountView('A');
  assert.equal(view.feeCents, 10000);
  assert.deepEqual(view.tied, ['p1', 'p2']);
  assert.equal(view.package, 'p1');
});

test('tie breaks deterministically regardless of event order', () => {
  const a = new FeeEngine();
  a.applyEvent(P1);
  a.applyEvent(P2);
  a.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  const b = new FeeEngine();
  b.applyEvent(P2);
  b.applyEvent(P1);
  b.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  assert.equal(a.certificate().digest, b.certificate().digest);
});

test('moving off the tie point re-selects the single best package', () => {
  const engine = new FeeEngine();
  engine.applyEvent(P1);
  engine.applyEvent(P2);
  engine.applyEvent({ type: 'trade', id: 't1', account: 'A', amount: 100000 });
  engine.applyEvent({ type: 'amend', id: 't1', amount: 120000 });
  const view = engine.accountView('A');
  // p1: 120.00, p2: 75 + 70000*0.0005 = 110.00
  assert.equal(view.feeCents, 11000);
  assert.deepEqual(view.tied, ['p2']);
  assert.equal(view.package, 'p2');
});
