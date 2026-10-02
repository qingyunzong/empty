'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CalibrationChain } = require('../src/calibration');
const { runCommand } = require('../src/cli');
const { ReferenceChain } = require('./reference');

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

function makeSensor(id, { raw = 0, offset = 0, scale = 1 } = {}) {
  const chain = new CalibrationChain();
  assert.equal(chain.addSensor(id, { raw, offset, scale }).ok, true);
  return chain;
}

// Acceptance 1: with at most 8 sensors, the incremental engine must match a
// full-enumeration reference on calibrated values, blocked sets and the
// certificate after every single operation.
test('incremental engine matches full-enumeration reference (fuzz, <=8 sensors)', () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  for (const seed of [1, 7, 42, 1337, 20261003]) {
    const rand = mulberry32(seed);
    const inc = new CalibrationChain();
    const ref = new ReferenceChain();
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const coeff = () => Math.floor(rand() * 9) - 4;

    const compare = (step) => {
      assert.deepEqual(inc.getResults(), ref.getResults(), `results differ at step ${step} (seed ${seed})`);
      const incBlocked = Object.values(inc.getResults()).filter((r) => r.blocked).map((r) => r.id);
      const refBlocked = Object.values(ref.getResults()).filter((r) => r.blocked).map((r) => r.id);
      assert.deepEqual(incBlocked, refBlocked, `blocked set differs at step ${step} (seed ${seed})`);
      assert.deepEqual(inc.getCertificate(), ref.getCertificate(), `certificate differs at step ${step} (seed ${seed})`);
    };

    for (let step = 0; step < 300; step += 1) {
      const present = ids.filter((id) => inc.sensors.has(id));
      const absent = ids.filter((id) => !inc.sensors.has(id));
      const kind = Math.floor(rand() * 9);
      let a;
      let b;
      switch (kind) {
        case 0:
          if (absent.length > 0) {
            const id = pick(absent);
            const payload = { raw: coeff(), offset: coeff(), scale: coeff() };
            a = inc.addSensor(id, payload);
            b = ref.addSensor(id, payload);
          }
          break;
        case 1:
          if (present.length > 0) {
            const id = pick(present);
            a = inc.removeSensor(id);
            b = ref.removeSensor(id);
          }
          break;
        case 2:
        case 3:
          if (present.length > 0) {
            const id = pick(present);
            const base = pick(ids);
            a = inc.setBase(id, base);
            b = ref.setBase(id, base);
          }
          break;
        case 4:
          if (present.length > 0) {
            const id = pick(present);
            a = inc.removeBase(id);
            b = ref.removeBase(id);
          }
          break;
        case 5:
        case 6:
          if (present.length > 0) {
            const id = pick(present);
            const patch = rand() < 0.5 ? { offset: coeff() } : { scale: coeff() };
            a = inc.correctCoefficients(id, patch);
            b = ref.correctCoefficients(id, patch);
          }
          break;
        case 7:
          a = inc.undo();
          b = ref.undo();
          break;
        case 8:
          a = inc.redo();
          b = ref.redo();
          break;
        default:
          break;
      }
      if (a !== undefined) {
        assert.deepEqual(a, b, `op result differs at step ${step} (seed ${seed})`);
        compare(step);
      }
    }
  }
});

// Acceptance 2: replacing a base invalidates the old chain and joins the new one.
test('replacing a base invalidates old chain and joins new chain', () => {
  const chain = new CalibrationChain();
  chain.addSensor('old', { raw: 1, offset: 0, scale: 10 });
  chain.addSensor('new', { raw: 2, offset: 1, scale: 1 });
  chain.addSensor('m', { raw: 99, offset: 0, scale: 2 });
  assert.equal(chain.setBase('m', 'old').ok, true);
  assert.equal(chain.getResult('m').result.value, 20); // (1*10)*2

  // A second base without removing the first is a topology violation.
  assert.equal(chain.setBase('m', 'new').error, 'E_TOPO');

  assert.equal(chain.removeBase('m').ok, true);
  assert.equal(chain.getResult('m').result.value, 198); // raw reading again
  assert.equal(chain.setBase('m', 'new').ok, true);
  assert.equal(chain.getResult('m').result.value, 6); // (2*1+1)*2

  // Corrections on the old base no longer propagate to m.
  chain.correctCoefficients('old', { scale: 100 });
  assert.equal(chain.getResult('m').result.value, 6);
  // Corrections on the new base do.
  chain.correctCoefficients('new', { offset: 4 });
  assert.equal(chain.getResult('m').result.value, 12); // (2+4)*2
});

// Acceptance 3a: cycles are rejected with E_CYCLE and leave state untouched.
test('cycle detection returns E_CYCLE and keeps state stable', () => {
  const chain = new CalibrationChain();
  chain.addSensor('a', { raw: 1, offset: 0, scale: 1 });
  chain.addSensor('b', { raw: 2, offset: 0, scale: 1 });
  chain.addSensor('c', { raw: 3, offset: 0, scale: 1 });
  chain.setBase('a', 'b');
  chain.setBase('b', 'c');
  assert.equal(chain.setBase('c', 'a').error, 'E_CYCLE');
  assert.equal(chain.setBase('c', 'c').error, 'E_CYCLE');
  const before = chain.getCertificate();
  assert.equal(chain.setBase('c', 'b').error, 'E_CYCLE');
  assert.deepEqual(chain.getCertificate(), before);
  assert.equal(chain.getResult('a').result.value, 3);
});

// Acceptance 3b: a sensor may have at most one calibration base.
test('duplicate base returns E_TOPO', () => {
  const chain = new CalibrationChain();
  chain.addSensor('a', { raw: 1, offset: 0, scale: 1 });
  chain.addSensor('b', { raw: 2, offset: 0, scale: 1 });
  chain.addSensor('c', { raw: 3, offset: 0, scale: 1 });
  assert.equal(chain.setBase('a', 'b').ok, true);
  assert.equal(chain.setBase('a', 'c').error, 'E_TOPO');
  assert.equal(chain.getResult('a').result.value, 2);
});

// Acceptance 3c: undo back to the initial state, and redo cleared by new corrections.
test('undo to initial state and redo stack cleared by new correction', () => {
  const chain = new CalibrationChain();
  const initial = chain.getCertificate();
  chain.addSensor('a', { raw: 1, offset: 1, scale: 2 });
  chain.addSensor('b', { raw: 0, offset: 0, scale: 5 });
  chain.setBase('b', 'a');
  chain.correctCoefficients('a', { offset: 10 });

  assert.equal(chain.undo().ok, true);
  assert.equal(chain.undo().ok, true);
  assert.equal(chain.undo().ok, true);
  assert.equal(chain.undo().ok, true);
  assert.equal(chain.undo().ok, false); // nothing left to undo
  assert.deepEqual(chain.getCertificate(), initial);
  assert.deepEqual(chain.getResults(), {});
  assert.equal(chain.version, 0);

  // Redo restores everything...
  assert.equal(chain.redo().ok, true);
  assert.equal(chain.redo().ok, true);
  assert.equal(chain.redo().ok, true);
  assert.equal(chain.getResult('b').result.value, 15); // (1*2+1)*5
  // ...but a fresh correction clears the redo stack.
  assert.equal(chain.undo().ok, true);
  assert.equal(chain.redo().ok, true);
  assert.equal(chain.undo().ok, true);
  chain.correctCoefficients('a', { scale: 3 });
  assert.equal(chain.redo().ok, false);
});

// Acceptance 3d: the empty graph is stable.
test('empty graph is stable', () => {
  const chain = new CalibrationChain();
  assert.deepEqual(chain.getResults(), {});
  const cert = chain.getCertificate();
  assert.deepEqual(cert.order, []);
  assert.equal(typeof cert.coeffHash, 'string');
  assert.equal(typeof cert.topoHash, 'string');
  assert.equal(chain.undo().ok, false);
  assert.equal(chain.redo().ok, false);
  assert.equal(chain.removeSensor('ghost').error, 'E_UNKNOWN');
  assert.equal(chain.getResult('ghost').ok, false);
  assert.equal(chain.setBase('ghost', 'also-ghost').error, 'E_UNKNOWN');
});

// Missing or blocked bases yield confidence 0 and blocked results.
test('missing or blocked base yields confidence 0 and blocked flag', () => {
  const chain = new CalibrationChain();
  chain.addSensor('a', { raw: 1, offset: 0, scale: 1 });
  // addSensor then manual edge to a missing base is impossible via setBase,
  // so create the missing base by removing the referenced sensor.
  chain.addSensor('b', { raw: 2, offset: 0, scale: 1 });
  chain.addSensor('c', { raw: 3, offset: 1, scale: 1 });
  chain.setBase('b', 'a');
  chain.setBase('c', 'b');
  chain.removeSensor('a');
  const rb = chain.getResult('b').result;
  const rc = chain.getResult('c').result;
  assert.deepEqual([rb.value, rb.confidence, rb.blocked], [null, 0, true]);
  assert.deepEqual([rc.value, rc.confidence, rc.blocked], [null, 0, true]);
  // Re-adding the missing base unblocks the whole chain.
  chain.addSensor('a', { raw: 5, offset: 0, scale: 1 });
  assert.equal(chain.getResult('b').result.value, 5);
  assert.equal(chain.getResult('c').result.value, 6);
});

// Coefficient corrections only recompute the affected transitive closure.
test('invalidation propagates only to the affected transitive closure', () => {
  const chain = new CalibrationChain();
  // Chain: s0 <- s1 <- ... <- s7, plus an isolated sensor 'iso'.
  for (let i = 0; i < 8; i += 1) {
    chain.addSensor(`s${i}`, { raw: i === 0 ? 1 : 0, offset: 1, scale: 1 });
    if (i > 0) chain.setBase(`s${i}`, `s${i - 1}`);
  }
  chain.addSensor('iso', { raw: 0, offset: 0, scale: 1 });

  chain.stats.recomputed = 0;
  chain.correctCoefficients('s0', { offset: 2 });
  assert.equal(chain.stats.recomputed, 8); // whole chain, not 'iso'

  chain.stats.recomputed = 0;
  chain.correctCoefficients('s7', { offset: 5 });
  assert.equal(chain.stats.recomputed, 1); // leaf only

  chain.stats.recomputed = 0;
  chain.correctCoefficients('s3', { scale: 2 });
  assert.equal(chain.stats.recomputed, 5); // s3..s7

  chain.stats.recomputed = 0;
  chain.correctCoefficients('iso', { offset: 9 });
  assert.equal(chain.stats.recomputed, 1);
});

// Certificate reacts to coefficient and topology changes.
test('certificate hashes track coefficients and topology', () => {
  const chain = new CalibrationChain();
  chain.addSensor('a', { raw: 1, offset: 0, scale: 1 });
  chain.addSensor('b', { raw: 2, offset: 0, scale: 1 });
  const c0 = chain.getCertificate();
  chain.setBase('b', 'a');
  const c1 = chain.getCertificate();
  assert.notEqual(c1.topoHash, c0.topoHash);
  assert.equal(c1.coeffHash, c0.coeffHash);
  assert.deepEqual(c1.order, ['a', 'b']);
  chain.correctCoefficients('a', { offset: 7 });
  const c2 = chain.getCertificate();
  assert.notEqual(c2.coeffHash, c1.coeffHash);
  assert.equal(c2.topoHash, c1.topoHash);
});

// CLI command dispatch (the same handler `node src/cli.js < req.json` uses).
test('CLI command handler processes a request document', () => {
  const commands = [
    { op: 'addSensor', id: 'a', raw: 2, offset: 1, scale: 3 },
    { op: 'addSensor', id: 'b', raw: 0, offset: 1, scale: 2 },
    { op: 'setBase', id: 'b', base: 'a' },
    { op: 'setBase', id: 'a', base: 'b' },
    { op: 'correct', id: 'a', offset: 2 },
    { op: 'snapshot' },
    { op: 'undo' },
    { op: 'result', id: 'b' },
    { op: 'nonsense' },
  ];
  const chain = new CalibrationChain();
  const results = commands.map((cmd) => runCommand(chain, cmd));
  assert.equal(results[3].error, 'E_CYCLE');
  const snap = results[5];
  assert.equal(snap.results.a.value, 8);
  assert.equal(snap.results.b.value, 17);
  assert.equal(snap.certificate.order.join(','), 'a,b');
  assert.equal(results[7].result.value, 15); // undo restored pre-correction state
  assert.equal(results[8].error, 'E_OP');
});
