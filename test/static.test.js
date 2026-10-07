import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compile.js';

const BASE = `
customer C0001;
note /^[A-Z0-9-]+$/;
bucket b { limit 1000; }
`;

test('acceptance 1: three-level nested approvals with tightening caps compile', () => {
  const policy = compileSource(BASE + `
    approval L1 { cap b 900;
      approval L2 { cap b 500;
        approval L3 { cap b 200; } } }`);
  assert.ok(policy.scopeIndex['L1']);
  assert.ok(policy.scopeIndex['L1/L2']);
  assert.ok(policy.scopeIndex['L1/L2/L3']);
  assert.equal(policy.scopeIndex['L1/L2/L3'].caps.b, 200);
});

test('acceptance 1: inner scope widening the outer cap fails with E_SCOPE', () => {
  const src = BASE + `
    approval L1 { cap b 900;
      approval L2 { cap b 500;
        approval L3 { cap b 800; } } }`;
  assert.throws(() => compileSource(src), (e) => e.code === 'E_SCOPE' && /exceeds outer cap/.test(e.message));
});

test('static types: frozen quota cannot be used as available (E_TYPE)', () => {
  const src = BASE + `approval L1 { reject freeze when amount <= frozen(b); }`;
  assert.throws(() => compileSource(src), (e) => e.code === 'E_TYPE' && /frozen vs available|available vs frozen/.test(e.message));
});

test('static types: limit/frozen/available cannot be mixed in arithmetic', () => {
  const src = BASE + `approval L1 { reject freeze when available(b) + frozen(b) > 0; }`;
  assert.throws(() => compileSource(src), (e) => e.code === 'E_TYPE');
});

test('shadowing: read-only let override allowed, assignment forbidden (E_SCOPE)', () => {
  const ok = BASE + `
    approval L1 { let buffer = 100;
      approval L2 { let buffer = 50;
        reject freeze when amount > available(b) - buffer; } }`;
  const policy = compileSource(ok);
  assert.ok(policy.scopeIndex['L1/L2'].rules.length === 1);
  const bad = BASE + `
    approval L1 { let buffer = 100;
      approval L2 { buffer = 50; } }`;
  assert.throws(() => compileSource(bad), (e) => e.code === 'E_SCOPE' && /read-only/.test(e.message));
});
