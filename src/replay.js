import { generateRun } from './fuzz.js';
import { stableStringify } from './stable-json.js';
import { InvalidInput, parseUint } from './errors.js';
import { OP_TYPES } from './ledger.js';

// Validates the run-file schema (unknown op types are rejected with
// INVALID_INPUT), then regenerates the run from (seed, steps, accounts) and
// compares: random sample sequence, per-op results, final state, state hash.
export function replayRun(file) {
  validateRunFile(file);
  const expected = generateRun({ seed: file.seed, steps: file.steps, accounts: file.accounts });
  const checks = {
    randomSamples: stableStringify(expected.randomSamples) === stableStringify(file.randomSamples),
    ops: stableStringify(expected.ops) === stableStringify(file.ops),
    finalState: stableStringify(expected.finalState) === stableStringify(file.finalState),
    stateHash: expected.stateHash === file.stateHash,
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, expectedStateHash: expected.stateHash, actualStateHash: file.stateHash };
}

export function validateRunFile(file) {
  if (!file || typeof file !== 'object') throw new InvalidInput('run file must be a JSON object');
  if (file.format !== 'payfuzz-run/1') {
    throw new InvalidInput(`unsupported run format: ${file.format}`);
  }
  parseUint(file.seed, 'seed');
  parseUint(file.steps, 'steps', { min: 0, max: 1_000_000 });
  parseUint(file.accounts, 'accounts', { min: 1, max: 10_000 });
  if (!Array.isArray(file.ops)) throw new InvalidInput('run file ops must be an array');
  if (file.ops.length !== file.steps) {
    throw new InvalidInput(`run file has ${file.ops.length} ops but steps=${file.steps}`);
  }
  for (const entry of file.ops) {
    validateOp(entry?.op);
  }
  if (!Array.isArray(file.randomSamples)) {
    throw new InvalidInput('run file randomSamples must be an array');
  }
}

export function validateOp(op) {
  if (!op || typeof op !== 'object') throw new InvalidInput('op must be an object');
  if (!OP_TYPES.includes(op.type)) {
    throw new InvalidInput(`unknown op type: ${op.type}`);
  }
  if (op.type === 'reserve') {
    if (typeof op.account !== 'string') throw new InvalidInput('reserve.account must be a string');
    if (!Number.isInteger(op.amount) || op.amount <= 0) {
      throw new InvalidInput(`reserve.amount must be a positive integer, got ${op.amount}`);
    }
  } else if (typeof op.holdId !== 'string') {
    throw new InvalidInput(`${op.type}.holdId must be a string`);
  }
}
