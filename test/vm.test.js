import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const RULES = `
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 1000.00;
    rule b_deny { when event.amount > max_amount then deny }
    rule a_deny { when event.count > 10 then deny }
    rule c_review { when event.count > 5 then review }
    rule d_allow { when event.ip in 10.0.0.0/8 then allow }

    scope channel("alipay") {
      override threshold max_amount: money = 500.00;
      rule e_deny { when event.amount > max_amount then deny }
    }
  }
}`;

const ev = (over) => ({
  id: 'x',
  time: '2024-02-01T00:00:00Z',
  merchant: 'MCH1',
  channel: 'wechat',
  ip: '8.8.8.8',
  amount: 1,
  count: 0,
  ...over,
});

const engineWith = (src) => {
  const engine = new Engine();
  engine.loadSource(src);
  return engine;
};

test('deny beats review beats allow', () => {
  const engine = engineWith(RULES);
  const r = engine.evaluate(ev({ amount: 2000, count: 20, ip: '10.0.0.1' }));
  assert.equal(r.decision, 'DENY');
});

test('pending manual review is not a pass', () => {
  const engine = engineWith(RULES);
  const r = engine.evaluate(ev({ count: 7 }));
  assert.equal(r.decision, 'REVIEW');
  assert.notEqual(r.decision, 'ALLOW');
});

test('no matching rule defaults to ALLOW', () => {
  const engine = engineWith(RULES);
  const r = engine.evaluate(ev({}));
  assert.equal(r.decision, 'ALLOW');
  assert.equal(r.hits.length, 0);
});

test('parallel strictest rules are all listed in stable sorted order', () => {
  const engine = engineWith(RULES);
  const r = engine.evaluate(ev({ amount: 2000, count: 20 }));
  assert.deepEqual(
    r.strictest.map((h) => `${h.path}/${h.rule}`),
    ['global/a_deny', 'global/b_deny'],
  );
});

test('shuffling rule order in source does not change output order', () => {
  const shuffled = RULES.replace(
    /rule b_deny[\s\S]*?\}\n    rule a_deny[\s\S]*?\}/,
    'rule a_deny { when event.count > 10 then deny }\n    rule b_deny { when event.amount > max_amount then deny }',
  );
  const a = engineWith(RULES).evaluate(ev({ amount: 2000, count: 20 }));
  const b = engineWith(shuffled).evaluate(ev({ amount: 2000, count: 20 }));
  assert.deepEqual(a.strictest, b.strictest);
  assert.deepEqual(a.hits, b.hits);
});

test('channel-scoped rule only fires for its channel', () => {
  const engine = engineWith(RULES);
  const hit = engine.evaluate(ev({ channel: 'alipay', amount: 700 }));
  assert.equal(hit.decision, 'DENY');
  assert.deepEqual(hit.strictest.map((h) => h.rule), ['e_deny']);
  const miss = engine.evaluate(ev({ channel: 'wechat', amount: 700 }));
  assert.equal(miss.decision, 'ALLOW');
});

test('tightened inner threshold is the one applied lexically', () => {
  const engine = engineWith(RULES);
  // 700 is below the outer 1000 but above the overridden 500.
  const r = engine.evaluate(ev({ channel: 'alipay', amount: 700 }));
  assert.equal(r.decision, 'DENY');
  assert.equal(r.strictest[0].path, 'global/channel("alipay")');
});

test('regex whitelist membership via in', () => {
  const engine = engineWith(`
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    whitelist vip = /^VIP[0-9]{4}$/;
    rule r { when event.merchant in vip then review }
  }
}`);
  assert.equal(engine.evaluate(ev({ merchant: 'VIP0042' })).decision, 'REVIEW');
  assert.equal(engine.evaluate(ev({ merchant: 'VIP42' })).decision, 'ALLOW');
});

test('explain output lists strictest rules, hits and override trace', () => {
  const engine = engineWith(RULES);
  const text = engine.explain(ev({ channel: 'alipay', amount: 2000, count: 20 }));
  assert.match(text, /decision=DENY/);
  assert.match(text, /strictest:\n(  DENY .+\n)+/);
  assert.match(text, /global\/channel\("alipay"\)\/e_deny/);
  assert.match(text, /overrides:\n  global\/channel\("alipay"\): threshold max_amount money 1000\.00 -> 500\.00 \(tightened\)/);
});
