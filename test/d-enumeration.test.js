'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transition, initialAccount } = require('../src/core');

// Independent oracle: a separately written reducer over the same spec.
function oracleStep(state, ev) {
  const acc = state[ev.account];
  const put = (a) => ({ ...state, [ev.account]: a });
  const toError = (code) => ({
    state: put({ status: 'ERROR', prevStatus: acc.status, balance: acc.balance, frozen: acc.frozen }),
    code,
  });

  if (acc.status === 'ERROR') {
    if (ev.type !== 'repair') return { state, code: 'ILLEGAL_TRANSITION' };
    return {
      state: put({ status: acc.prevStatus, prevStatus: null, balance: acc.balance, frozen: acc.frozen }),
      code: null,
    };
  }

  const legal = {
    INIT: ['open'],
    ACTIVE: ['debit', 'credit', 'hold', 'release', 'commit', 'void'],
    COMMITTED: [],
    VOID: [],
  }[acc.status];
  if (!legal.includes(ev.type)) return toError('ILLEGAL_TRANSITION');

  const amt = ev.amount;
  const ok = (a) => ({ state: put(a), code: null });
  switch (ev.type) {
    case 'open':
      if (!(amt >= 0)) return toError('NEGATIVE');
      return ok({ status: 'ACTIVE', prevStatus: acc.prevStatus, balance: amt, frozen: 0 });
    case 'debit':
      if (!(amt >= 0) || amt > acc.balance) return toError('NEGATIVE');
      return ok({ ...acc, status: 'ACTIVE', balance: acc.balance - amt });
    case 'credit':
      if (!(amt >= 0)) return toError('NEGATIVE');
      return ok({ ...acc, status: 'ACTIVE', balance: acc.balance + amt });
    case 'hold':
      if (!(amt >= 0) || amt > acc.balance - acc.frozen) return toError('NEGATIVE');
      return ok({ ...acc, status: 'ACTIVE', frozen: acc.frozen + amt });
    case 'release':
      if (!(amt >= 0) || amt > acc.frozen) return toError('HOLD_LEAK');
      return ok({ ...acc, status: 'ACTIVE', frozen: acc.frozen - amt });
    case 'commit':
      if (acc.frozen !== 0) return toError('HOLD_LEAK');
      return ok({ ...acc, status: 'COMMITTED' });
    case 'void':
      if (acc.frozen !== 0) return toError('HOLD_LEAK');
      return ok({ ...acc, status: 'VOID' });
    default:
      return toError('ILLEGAL_TRANSITION');
  }
}

const ACCOUNTS = ['a', 'b', 'c'];
const MAX_DEPTH = 12;

function fresh() {
  return initialAccount();
}

function key(state) {
  return ACCOUNTS
    .map((id) => {
      const a = state[id];
      return `${a.status}|${a.prevStatus}|${a.balance}|${a.frozen}`;
    })
    .join('#');
}

// Probe alphabet per account status: every legal move plus deliberate
// illegal ones so error/repair loops are enumerated too.
function probes(state, accountId) {
  const status = state[accountId].status;
  const ev = (type, amount) => ({ type, account: accountId, amount });
  switch (status) {
    case 'INIT':
      return [ev('open', 1), ev('open', 2), ev('debit', 1), ev('repair')];
    case 'ACTIVE':
      return [
        ev('credit', 1), ev('debit', 1), ev('hold', 1), ev('release', 1),
        ev('commit'), ev('void'), ev('repair'),
      ];
    case 'ERROR':
      return [ev('repair'), ev('debit', 1)];
    default: // COMMITTED / VOID
      return [ev('debit', 1), ev('repair')];
  }
}

test('D: enumerate all sequences up to 12 events over 3 accounts, compare with oracle', (t) => {
  const init = { a: fresh(), b: fresh(), c: fresh() };
  const seen = new Set([key(init)]);
  let frontier = [init];
  let transitionsChecked = 0;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const state of frontier) {
      for (const accountId of ACCOUNTS) {
        for (const ev of probes(state, accountId)) {
          const lib = transition(state[accountId], ev.type, ev.amount);
          const ora = oracleStep(state, ev);
          const ctx = `depth=${depth} account=${accountId} event=${JSON.stringify(ev)} state=${key(state)}`;
          assert.equal(lib.code, ora.code, `code mismatch: ${ctx}`);
          assert.deepEqual(
            {
              status: lib.state.status,
              prevStatus: lib.state.prevStatus,
              balance: lib.state.balance,
              frozen: lib.state.frozen,
            },
            {
              status: ora.state[accountId].status,
              prevStatus: ora.state[accountId].prevStatus,
              balance: ora.state[accountId].balance,
              frozen: ora.state[accountId].frozen,
            },
            `state mismatch: ${ctx}`,
          );
          transitionsChecked++;
          const child = { ...state, [accountId]: lib.state };
          const k = key(child);
          if (!seen.has(k)) {
            seen.add(k);
            next.push(child);
          }
        }
      }
    }
    frontier = next;
  }

  t.diagnostic(`states enumerated: ${seen.size}`);
  t.diagnostic(`transitions checked: ${transitionsChecked}`);
  assert.ok(transitionsChecked > 0);
});
