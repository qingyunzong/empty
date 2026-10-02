import { createPrng } from './prng.js';
import { Ledger } from './ledger.js';
import { stateHash } from './stable-json.js';
import { parseUint } from './errors.js';

export const INITIAL_BALANCE = 300;
export const MAX_AMOUNT = 150;

export function initialAccounts(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `A${i}`,
    balance: INITIAL_BALANCE,
    held: 0,
    frozen: false,
  }));
}

export function validateFuzzParams({ seed, steps, accounts }) {
  return {
    seed: parseUint(seed, 'seed'),
    steps: parseUint(steps, 'steps', { min: 0, max: 1_000_000 }),
    accounts: parseUint(accounts, 'accounts', { min: 1, max: 10_000 }),
  };
}

// Deterministically generates and executes a run. Every random integer drawn
// from the PRNG is appended to `randomSamples` and mirrored per-op in `rng`,
// so the log records: seed, per-op sequence number, random integer samples,
// operation id, and the operation result.
export function generateRun(params) {
  const { seed, steps, accounts } = validateFuzzParams(params);
  const prng = createPrng(seed);
  const randomSamples = [];
  const draw = () => {
    const v = prng.nextUint32();
    randomSamples.push(v);
    return v;
  };
  const nextInt = (n) => draw() % n;

  const ledger = new Ledger(initialAccounts(accounts));
  const ops = [];
  for (let seq = 0; seq < steps; seq++) {
    const rngStart = randomSamples.length;
    let kind = nextInt(3); // 0=reserve 1=settle 2=cancel
    if (kind !== 0 && ledger.holdSeq === 0) kind = 0; // nothing to target yet
    let op;
    if (kind === 0) {
      op = { type: 'reserve', account: `A${nextInt(accounts)}`, amount: 1 + nextInt(MAX_AMOUNT) };
    } else {
      // Slack of +2 makes targets sometimes miss (not-yet-created holds) and
      // uniform targeting makes settle/cancel races on closed holds likely.
      const target = nextInt(ledger.holdSeq + 2);
      op = { type: kind === 1 ? 'settle' : 'cancel', holdId: `H${target}` };
    }
    const result = ledger.apply(op);
    ops.push({
      seq,
      opId: `op-${seq}`,
      op,
      rng: randomSamples.slice(rngStart),
      result,
    });
  }
  const finalState = ledger.snapshot();
  return {
    format: 'payfuzz-run/1',
    seed,
    steps,
    accounts,
    initialState: { accounts: initialAccounts(accounts) },
    ops,
    randomSamples,
    finalState,
    stateHash: stateHash(finalState),
  };
}

export function serializeRun(run) {
  return JSON.stringify(run, null, 2) + '\n';
}
