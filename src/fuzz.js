import { DeterministicRng } from './rng.js';
import { Ledger } from './ledger.js';
import { stateHash, sha256Hex, canonicalString } from './hash.js';
import { InvalidInputError } from './errors.js';

export function validateFuzzArgs({ seed, steps, accounts }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new InvalidInputError(`seed must be an integer in [0, 4294967295], got: ${seed}`);
  }
  if (!Number.isInteger(steps) || steps < 0) {
    throw new InvalidInputError(`steps must be a non-negative integer, got: ${steps}`);
  }
  if (!Number.isInteger(accounts) || accounts < 1) {
    throw new InvalidInputError(`accounts must be a positive integer, got: ${accounts}`);
  }
}

export function fuzzRun({ seed, steps, accounts }) {
  validateFuzzArgs({ seed, steps, accounts });
  const rng = new DeterministicRng(seed);
  const samples = [];
  const draw = (purpose, bound) => {
    const value = rng.nextInt(bound);
    samples.push({ seq: samples.length, purpose, value });
    return value;
  };

  const balances = [];
  for (let i = 0; i < accounts; i += 1) {
    balances.push(40 + draw('initBalance', 161));
  }
  const frozenAccount = draw('frozenAccount', accounts);

  const ledger = new Ledger(balances, [frozenAccount]);
  const initial = ledger.snapshot();

  const ops = [];
  const createdReservationIds = [];

  for (let seq = 0; seq < steps; seq += 1) {
    const sampleStart = samples.length;
    const kind = draw('opKind', 10);
    let type;
    if (kind <= 4) {
      type = 'reserve';
    } else if (kind <= 7) {
      type = createdReservationIds.length > 0 ? 'settle' : 'reserve';
    } else {
      type = createdReservationIds.length > 0 ? 'cancel' : 'reserve';
    }

    const id = `op-${seq}`;
    const op = { seq, id, type };

    if (type === 'reserve') {
      op.account = draw('account', accounts);
      op.amount = 1 + draw('amount', 120);
      op.reservationId = `res-${seq}`;
    } else {
      const pick = draw('reservationPick', createdReservationIds.length);
      op.reservationId = createdReservationIds[pick];
    }

    const outcome = ledger.apply(op);
    op.result = outcome.result;
    if (outcome.reason) {
      op.reason = outcome.reason;
    }
    if (type === 'reserve' && outcome.result === 'applied') {
      createdReservationIds.push(op.reservationId);
    }
    op.samples = samples.slice(sampleStart);
    ops.push(op);
  }

  const finalState = ledger.snapshot();
  return {
    format: 'paylimit-fuzz-run',
    version: 1,
    seed,
    steps,
    accounts,
    initial,
    frozenAccounts: [frozenAccount],
    ops,
    finalState,
    finalStateHash: stateHash(finalState),
    sampleCount: samples.length,
    sampleHash: sha256Hex(canonicalString(samples)),
  };
}
