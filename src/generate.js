import { Prng } from './prng.js';

// Deterministic two-phase task-pool generator. Every random choice is drawn
// from a SplitMix64 PRNG seeded with `seed`; the number of draws is recorded
// in pool.prng.draws so any (seed, seq) sample can be replayed exactly.
export function generatePool({ seed, accounts, tasks }) {
  if (!Number.isInteger(accounts) || accounts <= 0) {
    throw new RangeError(`accounts must be a positive integer, got ${accounts}`);
  }
  if (!Number.isInteger(tasks) || tasks < 0) {
    throw new RangeError(`tasks must be a non-negative integer, got ${tasks}`);
  }
  const prng = new Prng(seed);
  const accountList = [];
  for (let i = 0; i < accounts; i += 1) {
    accountList.push({ id: `A${i}`, limit: 40 + prng.int(61) }); // limit in [40, 100]
  }
  // Unmatched cancellation targets per account.
  const open = accountList.map(() => ({ freezes: [], debits: [] }));
  const taskList = [];
  for (let i = 0; i < tasks; i += 1) {
    const a = prng.int(accounts);
    const account = accountList[a];
    const bucket = open[a];
    const r = prng.next();
    let kind;
    if (r < 0.35) kind = 'freeze';
    else if (r < 0.65) kind = 'debit';
    else if (r < 0.85) kind = bucket.freezes.length > 0 ? 'unfreeze' : 'freeze';
    else kind = bucket.debits.length > 0 ? 'cancelDebit' : 'debit';
    const id = `T${i}`;
    if (kind === 'freeze' || kind === 'debit') {
      const amount = 1 + prng.int(account.limit); // amount in [1, limit]
      taskList.push({ id, account: account.id, kind, amount });
      (kind === 'freeze' ? bucket.freezes : bucket.debits).push(id);
    } else {
      const list = kind === 'unfreeze' ? bucket.freezes : bucket.debits;
      const target = list.splice(prng.int(list.length), 1)[0];
      taskList.push({ id, account: account.id, kind, target });
    }
  }
  return {
    seed,
    accounts: accountList,
    tasks: taskList,
    prng: { algorithm: 'splitmix64', seed: String(BigInt(seed)), draws: prng.seq },
  };
}
