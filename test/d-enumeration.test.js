'use strict';

// D: enumerate every legal (and illegal-transition) event sequence of up to
// 12 events over 3 accounts and differentially compare the Ledger against an
// independent reference model. Sequences are explored via BFS over the joint
// state space with dedup, so every reachable joint state is verified.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

const ACCOUNTS = ['a', 'b', 'c'];
const OPS = ['open', 'debit', 'credit', 'hold', 'release', 'commit', 'void', 'repair'];
const AMOUNT = 10;
const OPEN_BALANCE = 20;
const MAX_BALANCE = 20; // generation bound so the state space stays finite
const MAX_DEPTH = 12;

// --- independent reference model ---
const REF_DFA = {
  INIT: { open: 'OPEN' },
  OPEN: { debit: 'OPEN', credit: 'OPEN', hold: 'OPEN', release: 'OPEN', commit: 'COMMITTED', void: 'VOIDED' },
  COMMITTED: {},
  VOIDED: {},
  ERROR: { repair: 'OPEN' },
};

function refStep(acct, op) {
  const target = REF_DFA[acct.state][op];
  if (!target) return { error: 'ILLEGAL_TRANSITION', next: { ...acct, state: 'ERROR' } };
  const next = { ...acct };
  switch (op) {
    case 'open':
      next.balance = OPEN_BALANCE;
      next.held = 0;
      break;
    case 'debit':
      if (next.balance - next.held < AMOUNT) return { error: 'NEGATIVE', next: { ...acct, state: 'ERROR' } };
      next.balance -= AMOUNT;
      break;
    case 'credit':
      next.balance += AMOUNT;
      break;
    case 'hold':
      if (next.balance - next.held < AMOUNT) return { error: 'NEGATIVE', next: { ...acct, state: 'ERROR' } };
      next.held += AMOUNT;
      break;
    case 'release':
      if (next.held < AMOUNT) return { error: 'HOLD_LEAK', next: { ...acct, state: 'ERROR' } };
      next.held -= AMOUNT;
      break;
    case 'commit':
      if (next.held > 0) return { error: 'HOLD_LEAK', next: { ...acct, state: 'ERROR' } };
      break;
    case 'void':
      next.held = 0;
      break;
    case 'repair':
      break;
    default:
      throw new Error(`unexpected op ${op}`);
  }
  next.state = target;
  return { next };
}

function serialize(state) {
  return ACCOUNTS.map((n) => {
    const a = state.accounts[n];
    return `${a.state}:${a.balance}:${a.held}`;
  }).join('|');
}

function freshJointState() {
  const accounts = {};
  for (const n of ACCOUNTS) accounts[n] = { state: 'INIT', balance: 0, held: 0 };
  return { accounts };
}

test('D: all event sequences up to 12 events over 3 accounts match the reference model', (t) => {
  const start = freshJointState();
  const visited = new Set([serialize(start)]);
  let edges = 0;
  let errorEdges = 0;
  let eventCounter = 0;
  const queue = [{ state: start, ledger: new Ledger(), depth: 0 }];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node.depth >= MAX_DEPTH) continue;
    for (const account of ACCOUNTS) {
      for (const op of OPS) {
        const acct = node.state.accounts[account];
        if (op === 'credit' && acct.balance + AMOUNT > MAX_BALANCE) continue; // keep space finite
        edges += 1;
        const ref = refStep(acct, op);
        const event = { id: `ev${eventCounter += 1}`, op, account, amount: AMOUNT, balance: OPEN_BALANCE };
        const ledger = node.ledger.clone();
        if (ref.error) {
          errorEdges += 1;
          assert.throws(
            () => ledger.apply(event),
            (err) => err.code === ref.error,
            `edge ${op}@${account} from ${serialize(node.state)}: expected ${ref.error}`,
          );
        } else {
          ledger.apply(event);
        }
        const actual = ledger.getAccount(account);
        assert.deepEqual(
          actual,
          ref.next,
          `edge ${op}@${account} from ${serialize(node.state)}`,
        );
        const nextState = { accounts: { ...node.state.accounts, [account]: ref.next } };
        const key = serialize(nextState);
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ state: nextState, ledger, depth: node.depth + 1 });
        }
      }
    }
  }

  t.diagnostic(`verified ${edges} event edges (${errorEdges} error edges) across ${visited.size} reachable joint states, depth <= ${MAX_DEPTH}`);
  assert.ok(visited.size > 1000, 'state space coverage is non-trivial');
});
