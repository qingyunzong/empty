'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guard, applyEvent, createState, projectionOf } = require('../lib/model');
const ref = require('./helpers/reference');

// Exhaustive state-machine enumeration: BFS over reachable states up to depth
// 10, trying every template event from every state. At each transition the
// real guard/apply must agree with the independent reference machine on both
// the rejection code and the resulting projection.

const TEMPLATES = [
  { type: 'sale', id: 's1', account: 'A', amount: 10 },
  { type: 'sale', id: 's2', account: 'B', amount: 6 },
  { type: 'freeze', account: 'A', amount: 4 },
  { type: 'unfreeze', account: 'A', amount: 3 },
  { type: 'refund', id: 'r1', ref: 's1', amount: 5 },
  { type: 'refund', id: 'r2', ref: 's1', amount: 6 },
  { type: 'refund', id: 'r3', ref: 'ghost', amount: 2 },
  { type: 'refundVoid', ref: 'r1' },
  { type: 'refundVoid', ref: 'r2' },
];

const MAX_DEPTH = 10;

function stateKey(st) {
  const accounts = Object.keys(st.accounts).sort()
    .map((k) => [k, st.accounts[k].balance, st.accounts[k].frozen]);
  const sales = Object.keys(st.sales).sort()
    .map((k) => [k, st.sales[k].refunded]);
  const refunds = Object.keys(st.refunds).sort()
    .map((k) => [k, st.refunds[k].voided, st.refunds[k].seq]);
  return JSON.stringify([accounts, sales, refunds]);
}

function refKey(st) {
  const accounts = Object.keys(st.accounts).sort()
    .map((k) => [k, st.accounts[k].balance, st.accounts[k].frozen]);
  const sales = Object.keys(st.sales).sort()
    .map((k) => [k, st.sales[k].refunded]);
  const refunds = Object.keys(st.refunds).sort()
    .map((k) => [k, st.refunds[k].voided, st.refunds[k].n]);
  return JSON.stringify([accounts, sales, refunds]);
}

test('state machine enumeration up to depth 10 matches reference machine', () => {
  const start = createState();
  const startRef = ref.createRef();
  assert.equal(stateKey(start), refKey(startRef), 'canonical keys must align');

  const visited = new Set([stateKey(start)]);
  let frontier = [{ sys: start, ref: startRef, depth: 0 }];
  let transitions = 0;
  let accepted = 0;
  const codeCounts = new Map();

  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      if (node.depth >= MAX_DEPTH) continue;
      for (const tmpl of TEMPLATES) {
        const event = structuredClone(tmpl);
        // system under test
        const sysState = structuredClone(node.sys);
        const g = guard(sysState, event);
        const sysCode = g.ok ? 0 : g.code;
        if (g.ok) applyEvent(sysState, event);
        // reference machine
        const refState = structuredClone(node.ref);
        const refCode = ref.check(refState, event);
        if (refCode === 0) ref.run(refState, event);

        assert.equal(sysCode, refCode,
          `code mismatch for ${JSON.stringify(event)} at depth ${node.depth}: sys=${sysCode} ref=${refCode}`);
        if (sysCode === 0) {
          assert.deepEqual(projectionOf(sysState).accounts, ref.accountsOf(refState),
            `projection mismatch after ${JSON.stringify(event)}`);
          assert.equal(stateKey(sysState), refKey(refState), 'canonical state keys diverged');
          accepted += 1;
          const key = stateKey(sysState);
          if (!visited.has(key)) {
            visited.add(key);
            next.push({ sys: sysState, ref: refState, depth: node.depth + 1 });
          }
        } else {
          codeCounts.set(sysCode, (codeCounts.get(sysCode) || 0) + 1);
        }
        transitions += 1;
      }
    }
    frontier = next;
  }

  assert.ok(transitions > 1000, `expected substantial enumeration, got ${transitions} transitions`);
  assert.ok(accepted > 100, `expected many accepted transitions, got ${accepted}`);
  // enumeration must actually exercise the spec error codes
  for (const code of [30, 31, 32, 33, 34]) {
    assert.ok(codeCounts.has(code), `error code ${code} never exercised`);
  }
  console.log(`  enumeration: ${transitions} transitions, ${visited.size} distinct states, ` +
    `reject codes: ${[...codeCounts.entries()].map(([c, n]) => `${c}x${n}`).join(' ')}`);
});
