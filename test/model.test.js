import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, CrashError, E_INVARIANT } from '../src/ledger.js';
import { tempDir } from './helpers.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-memory reference state machine implementing the same spec rules. */
class Model {
  constructor(balances) {
    this.accounts = new Map();
    for (const [name, balance] of Object.entries(balances)) {
      this.accounts.set(name, { balance, frozen: 0 });
    }
    this.txs = new Map(); // key -> { status, op, account, amount, target, reversedBy }
  }

  acct(name) {
    if (!this.accounts.has(name)) this.accounts.set(name, { balance: 0, frozen: 0 });
    return this.accounts.get(name);
  }

  plan(tx) {
    switch (tx.op) {
      case 'freeze':
        return { account: tx.account, b: 0, f: tx.amount };
      case 'debit':
        return { account: tx.account, b: -tx.amount, f: -tx.amount };
      case 'release':
        return { account: tx.account, b: 0, f: -tx.amount };
      case 'reverse': {
        const t = this.txs.get(tx.target);
        if (!t || t.status !== 'committed' || t.op === 'reverse' || t.reversedBy) return null;
        const p = this.plan(t);
        return { account: p.account, b: -p.b, f: -p.f };
      }
      default:
        return null;
    }
  }

  valid(p) {
    const a = this.acct(p.account);
    return a.balance + p.b >= 0 && a.frozen + p.f >= 0 && a.balance + p.b - (a.frozen + p.f) >= 0;
  }

  apply(p) {
    const a = this.acct(p.account);
    a.balance += p.b;
    a.frozen += p.f;
  }

  submit(input, fault) {
    let tx = this.txs.get(input.key);
    if (tx) {
      if (tx.status === 'committed') return 'committed';
      if (tx.status === 'aborted') return 'aborted';
      // pending: resume below (intent already durable, no new intent crash point)
    } else {
      tx = { ...input, status: 'pending', reversedBy: null };
      this.txs.set(input.key, tx);
      if (fault === 'intent') return 'crashed';
    }
    const p = this.plan(tx);
    if (!p || !this.valid(p)) {
      tx.status = 'aborted';
      return 'aborted';
    }
    if (fault === 'applied') {
      tx.status = 'applied-uncommitted';
      return 'crashed';
    }
    this.apply(p);
    if (tx.op === 'reverse') this.txs.get(tx.target).reversedBy = tx.key;
    tx.status = 'committed';
    if (fault === 'commit') return 'crashed';
    return 'committed';
  }

  recover() {
    for (const tx of this.txs.values()) {
      if (tx.status === 'applied-uncommitted') tx.status = 'aborted';
    }
  }
}

function compareAll(ledger, model, accounts, keys, step) {
  for (const name of accounts) {
    const lb = ledger.balance(name);
    const ma = model.acct(name);
    assert.equal(lb.balance, ma.balance, `step ${step}: balance mismatch on ${name}`);
    assert.equal(lb.frozen, ma.frozen, `step ${step}: frozen mismatch on ${name}`);
    assert.equal(lb.available, ma.balance - ma.frozen, `step ${step}: available mismatch on ${name}`);
  }
  for (const { input } of keys) {
    const ls = ledger.status(input.key).status;
    const ms = model.txs.get(input.key).status;
    assert.equal(ls, ms, `step ${step}: status mismatch on key ${input.key}`);
  }
}

for (const seed of [1, 7, 42]) {
  test(`random op sequence matches reference model (seed ${seed})`, () => {
    const rand = mulberry32(seed);
    const genesis = { a: 200, b: 150, c: 100 };
    const accountNames = Object.keys(genesis);
    const dir = tempDir();
    let ledger = new Ledger(dir, { initBalances: genesis }).open();
    const model = new Model(genesis);
    const keys = [];
    let opCount = 0;

    for (let i = 0; i < 250; i++) {
      const r = rand();
      let input;
      if (r < 0.12 && keys.length > 0) {
        input = keys[Math.floor(rand() * keys.length)].input; // idempotent resubmit
      } else if (r < 0.3 && keys.length > 0) {
        const target = keys[Math.floor(rand() * keys.length)].input.key;
        input = { key: `k${opCount++}`, op: 'reverse', target };
      } else {
        input = {
          key: `k${opCount++}`,
          op: ['freeze', 'debit', 'release'][Math.floor(rand() * 3)],
          account: accountNames[Math.floor(rand() * accountNames.length)],
          amount: 1 + Math.floor(rand() * 60),
        };
      }
      const fault = rand() < 0.15 ? ['intent', 'applied', 'commit'][Math.floor(rand() * 3)] : null;
      keys.push({ input, fault });

      ledger.faultAfter = fault;
      let ledgerOutcome;
      try {
        ledgerOutcome = ledger.submit(input).status;
      } catch (err) {
        if (err instanceof CrashError) ledgerOutcome = 'crashed';
        else if (err.code === E_INVARIANT) ledgerOutcome = 'aborted';
        else throw err;
      }
      const modelOutcome = model.submit(input, fault);
      assert.equal(ledgerOutcome, modelOutcome, `step ${i}: outcome mismatch for ${JSON.stringify(input)} fault=${fault}`);

      if (fault || i % 25 === 24) {
        ledger = new Ledger(dir).open(); // restart: recovery runs
        model.recover();
        compareAll(ledger, model, accountNames, keys, i);
      } else {
        for (const name of accountNames) {
          const lb = ledger.balance(name);
          const ma = model.acct(name);
          assert.equal(lb.balance, ma.balance, `step ${i}: balance mismatch on ${name}`);
          assert.equal(lb.frozen, ma.frozen, `step ${i}: frozen mismatch on ${name}`);
        }
      }
    }

    ledger.close();
    ledger = new Ledger(dir).open(); // final recovery must be deterministic
    model.recover();
    compareAll(ledger, model, accountNames, keys, 'final');
    ledger.close();
  });
}
