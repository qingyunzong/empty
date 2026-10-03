// Deterministic two-phase task-pool generator.
//
// Given a seed, an account count and a task count, produces a pool of
// freeze / unfreeze / debit / cancelDebit tasks. Every task records the PRNG
// sampling index (`draw`) at which it was generated, so the whole pool is
// reproducible from (seed, accounts, tasks) alone.

import { Prng } from './prng.js';

export function generatePool({ seed, accounts: accountCount, tasks: taskCount }) {
  const prng = new Prng(seed);
  const accounts = [];
  for (let i = 0; i < accountCount; i += 1) {
    accounts.push({ id: `A${i}`, limit: 4 + prng.int(6) });
  }
  const tasks = [];
  for (let i = 0; i < taskCount; i += 1) {
    const draw = prng.index;
    const account = prng.int(accountCount);
    const limit = accounts[account].limit;
    const kinds = ['freeze', 'debit'];
    const freezes = tasks.filter((t) => t.kind === 'freeze' && t.account === account);
    const debits = tasks.filter((t) => t.kind === 'debit' && t.account === account);
    if (freezes.length > 0) kinds.push('unfreeze');
    if (debits.length > 0) kinds.push('cancelDebit');
    const kind = prng.pick(kinds);
    const id = `T${i}`;
    if (kind === 'unfreeze' || kind === 'cancelDebit') {
      const source = kind === 'unfreeze' ? freezes : debits;
      const target = prng.pick(source);
      tasks.push({ id, kind, account, amount: target.amount, target: target.id, draw });
    } else {
      tasks.push({ id, kind, account, amount: 1 + prng.int(limit), draw });
    }
  }
  return { seed, prng: prng.snapshot(), accounts, tasks };
}
