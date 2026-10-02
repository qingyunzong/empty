import { Ledger, OP_TYPES } from './ledger.js';
import { fuzzRun } from './fuzz.js';
import { stateHash, canonicalString } from './hash.js';
import { InvalidInputError } from './errors.js';

export function validateRunObject(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new InvalidInputError('run file must contain a JSON object');
  }
  if (run.format !== 'paylimit-fuzz-run') {
    throw new InvalidInputError(`unknown run format: ${run.format}`);
  }
  for (const key of ['seed', 'steps', 'accounts']) {
    if (!Number.isInteger(run[key])) {
      throw new InvalidInputError(`run.${key} must be an integer, got: ${run[key]}`);
    }
  }
  if (!Array.isArray(run.ops)) {
    throw new InvalidInputError('run.ops must be an array');
  }
  for (const op of run.ops) {
    if (!op || !OP_TYPES.has(op.type)) {
      throw new InvalidInputError(`unknown op type: ${op && op.type}`);
    }
  }
  if (!run.initial || !Array.isArray(run.initial.accounts)) {
    throw new InvalidInputError('run.initial.accounts must be an array');
  }
}

export function replayRun(run) {
  validateRunObject(run);
  const mismatches = [];

  const regenerated = fuzzRun({ seed: run.seed, steps: run.steps, accounts: run.accounts });
  if (regenerated.finalStateHash !== run.finalStateHash) {
    mismatches.push(`finalStateHash: recorded=${run.finalStateHash} regenerated=${regenerated.finalStateHash}`);
  }
  if (regenerated.sampleHash !== run.sampleHash) {
    mismatches.push(`sampleHash: recorded=${run.sampleHash} regenerated=${regenerated.sampleHash}`);
  }
  if (regenerated.ops.length !== run.ops.length) {
    mismatches.push(`op count: recorded=${run.ops.length} regenerated=${regenerated.ops.length}`);
  } else {
    for (let i = 0; i < run.ops.length; i += 1) {
      const recorded = canonicalString(run.ops[i]);
      const regeneratedOp = canonicalString(regenerated.ops[i]);
      if (recorded !== regeneratedOp) {
        mismatches.push(`op ${i} (${run.ops[i].id}): recorded=${recorded} regenerated=${regeneratedOp}`);
      }
    }
  }

  const frozenIndices = run.initial.accounts
    .map((account, index) => (account.frozen ? index : -1))
    .filter((index) => index >= 0);
  const ledger = new Ledger(run.initial.accounts.map((account) => account.balance), frozenIndices);
  for (const op of run.ops) {
    const outcome = ledger.apply(op);
    if (outcome.result !== op.result) {
      mismatches.push(`op ${op.id}: recorded result=${op.result} reapplied=${outcome.result}`);
    }
    if ((outcome.reason ?? undefined) !== (op.reason ?? undefined)) {
      mismatches.push(`op ${op.id}: recorded reason=${op.reason} reapplied=${outcome.reason}`);
    }
  }
  const reappliedHash = stateHash(ledger.snapshot());
  if (reappliedHash !== run.finalStateHash) {
    mismatches.push(`reapplied finalStateHash: recorded=${run.finalStateHash} reapplied=${reappliedHash}`);
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    finalStateHash: regenerated.finalStateHash,
    sampleHash: regenerated.sampleHash,
    opCount: run.ops.length,
  };
}
