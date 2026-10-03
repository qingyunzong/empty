import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const wrap = (inner) => `
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 10000.00;
    threshold max_count: count = 100;
    rule g { when event.amount > max_amount then deny }
    ${inner}
  }
}`;

const load = (src) => new Engine().loadSource(src);

// ---------- E_OVERRIDE ----------

test('E_OVERRIDE: inner scope loosening outer threshold without override fails', () => {
  const src = wrap(`scope channel("alipay") { threshold max_amount: money = 20000.00; }`);
  assert.throws(() => load(src), (e) => e.code === 'E_OVERRIDE' && /override/.test(e.message));
});

test('E_OVERRIDE: inner scope loosening outer threshold with override still fails', () => {
  const src = wrap(`scope channel("alipay") { override threshold max_amount: money = 20000.00; }`);
  assert.throws(() => load(src), (e) => e.code === 'E_OVERRIDE' && /loosens/.test(e.message));
});

test('E_OVERRIDE: shadowing without override fails even when tightening', () => {
  const src = wrap(`scope channel("alipay") { threshold max_amount: money = 5000.00; }`);
  assert.throws(() => load(src), (e) => e.code === 'E_OVERRIDE');
});

test('E_OVERRIDE: override without any outer declaration fails', () => {
  const src = wrap(`scope channel("alipay") { override threshold other: money = 5000.00; }`);
  assert.throws(() => load(src), (e) => e.code === 'E_OVERRIDE' && /no outer/.test(e.message));
});

test('override: tightening with explicit override succeeds and leaves a trace', () => {
  const engine = new Engine();
  engine.loadSource(wrap(`
    scope channel("alipay") {
      override threshold max_amount: money = 5000.00;
      scope merchant("MCH1") {
        override threshold max_amount: money = 1000.00;
      }
    }
  `));
  const overrides = engine.versions[0].overrides;
  assert.equal(overrides.length, 2);
  assert.deepEqual(overrides[0], {
    version: 'v1',
    scope: 'global/channel("alipay")',
    name: 'max_amount',
    type: 'money',
    outer: '10000.00',
    inner: '5000.00',
  });
  assert.equal(overrides[1].inner, '1000.00');
});

test('override: cidr thresholds tighten by subnet containment', () => {
  const ok = `
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold net: cidr = 10.0.0.0/8;
    scope channel("alipay") {
      override threshold net: cidr = 10.1.0.0/16;
      rule r { when event.ip in net then deny }
    }
  }
}`;
  new Engine().loadSource(ok);
  const bad = ok.replace('10.1.0.0/16', '11.0.0.0/8');
  assert.throws(() => new Engine().loadSource(bad), (e) => e.code === 'E_OVERRIDE');
});

// ---------- E_TYPE ----------

test('E_TYPE: money compared with count threshold', () => {
  const src = wrap(`rule bad { when event.amount > max_count then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE');
});

test('E_TYPE: money literal with more than 2 decimals', () => {
  const src = wrap(`rule bad { when event.amount > 1.005 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE');
});

test('E_TYPE: count compared with fractional literal', () => {
  const src = wrap(`rule bad { when event.count > 5.5 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE');
});

test('E_TYPE: logical operator on non-boolean operand', () => {
  const src = wrap(`rule bad { when event.amount and event.count > 1 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE');
});

test('E_TYPE: ip in a numeric range', () => {
  const src = wrap(`rule bad { when event.ip in 100..200 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE');
});

test('E_TYPE: unknown event field', () => {
  const src = wrap(`rule bad { when event.foo > 1 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE' && /event\.foo/.test(e.message));
});

test('E_TYPE: unknown name reference', () => {
  const src = wrap(`rule bad { when event.amount > missing_name then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_TYPE' && /missing_name/.test(e.message));
});

// ---------- E_CIDR ----------

test('E_CIDR: octet out of range', () => {
  const src = wrap(`rule bad { when event.ip in 999.0.0.0/8 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_CIDR');
});

test('E_CIDR: prefix longer than 32', () => {
  const src = wrap(`rule bad { when event.ip in 10.0.0.0/33 then deny }`);
  assert.throws(() => load(src), (e) => e.code === 'E_CIDR');
});

test('E_CIDR: malformed event ip at evaluation time', () => {
  const engine = new Engine();
  engine.loadSource(wrap(''));
  assert.throws(
    () => engine.evaluate({ id: 'x', time: '2024-02-01T00:00:00Z', ip: 'not-an-ip', amount: 1, count: 1 }),
    (e) => e.code === 'E_CIDR',
  );
});

// ---------- E_VERSION ----------

test('E_VERSION: duplicate version id in one file', () => {
  const src = `
version "v1" since "2024-01-01T00:00:00Z" { scope global { rule r { when true then allow } } }
version "v1" since "2024-02-01T00:00:00Z" { scope global { rule r { when true then allow } } }`;
  assert.throws(() => load(src), (e) => e.code === 'E_VERSION');
});

test('E_VERSION: invalid since timestamp', () => {
  const src = `version "v1" since "not-a-date" { scope global { rule r { when true then allow } } }`;
  assert.throws(() => load(src), (e) => e.code === 'E_VERSION');
});

test('E_VERSION: event time before every version', () => {
  const engine = new Engine();
  engine.loadSource(wrap(''));
  assert.throws(
    () => engine.evaluate({ id: 'x', time: '2020-01-01T00:00:00Z', ip: '1.2.3.4', amount: 1, count: 1 }),
    (e) => e.code === 'E_VERSION' && /no rule version/.test(e.message),
  );
});

test('E_VERSION: two versions sharing the same effective time', () => {
  const src = `
version "v1" since "2024-01-01T00:00:00Z" { scope global { rule r { when true then allow } } }
version "v2" since "2024-01-01T00:00:00Z" { scope global { rule r { when true then allow } } }`;
  assert.throws(() => load(src), (e) => e.code === 'E_VERSION');
});
