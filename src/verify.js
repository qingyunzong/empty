'use strict';

const {
  isPlainObject,
  normalizeInstructions,
  accountDelta,
  pruneZeros,
  addContribution,
  netOf,
  canonicalJson,
  deepEqual,
} = require('./model');

function invariantFailure(invariant, message) {
  return { ok: false, invariant, message };
}

function opContribution(op) {
  const contrib = {};
  for (const input of op.inputs) addContribution(contrib, input.account, -netOf(input), -input.freeze);
  for (const output of op.outputs) addContribution(contrib, output.account, netOf(output), output.freeze);
  return pruneZeros(contrib);
}

function amountsOf(inst) {
  return { debit: inst.debit, credit: inst.credit, freeze: inst.freeze };
}

function sumAmounts(list) {
  return list.reduce(
    (acc, inst) => ({ debit: acc.debit + inst.debit, credit: acc.credit + inst.credit, freeze: acc.freeze + inst.freeze }),
    { debit: 0, credit: 0, freeze: 0 }
  );
}

function verifyProof(oldDoc, newDoc, proof) {
  let oldInstructions;
  let newInstructions;
  try {
    oldInstructions = normalizeInstructions(oldDoc, 'old');
    newInstructions = normalizeInstructions(newDoc, 'new');
  } catch (err) {
    return invariantFailure('perAccountDelta', `invalid instruction table: ${err.message}`);
  }
  if (!isPlainObject(proof)) return invariantFailure('perAccountDelta', 'proof is not an object');

  // Invariant 1: perAccountDelta matches the recomputed old->new delta.
  const expectedDelta = accountDelta(oldInstructions, newInstructions);
  if (!deepEqual(proof.perAccountDelta, expectedDelta)) {
    return invariantFailure(
      'perAccountDelta',
      `proof claims ${canonicalJson(proof.perAccountDelta)} but recomputed delta is ${canonicalJson(expectedDelta)}`
    );
  }

  // Invariant 2: conservation — replay the declared ops from the old table,
  // require the replay to land exactly on the new table, require split/merge
  // ops to be per-account neutral, and require the op contributions to add
  // up to the per-account delta.
  const ops = proof.ops;
  if (!Array.isArray(ops)) return invariantFailure('conservation', 'proof.ops is missing or not an array');
  for (const [i, op] of ops.entries()) {
    if (!isPlainObject(op) || !['split', 'merge', 'restate'].includes(op.op)) {
      return invariantFailure('conservation', `proof.ops[${i}] is malformed`);
    }
    if (!Array.isArray(op.inputs) || !Array.isArray(op.outputs) || op.inputs.length === 0 || op.outputs.length === 0) {
      return invariantFailure('conservation', `proof.ops[${i}] is missing inputs/outputs`);
    }
  }

  const replay = new Map(oldInstructions.map((inst) => [inst.id, inst]));
  const recomputedContribs = [];
  for (const [i, op] of ops.entries()) {
    const inputIds = new Set();
    for (const input of op.inputs) {
      if (!isPlainObject(input) || typeof input.id !== 'string') {
        return invariantFailure('conservation', `proof op ${op.index} has a malformed input`);
      }
      const current = replay.get(input.id);
      if (!current || !deepEqual(current, input)) {
        return invariantFailure('conservation', `proof op ${op.index} input snapshot for ${input.id} does not match the table state`);
      }
      if (inputIds.has(input.id)) {
        return invariantFailure('conservation', `proof op ${op.index} consumes ${input.id} twice`);
      }
      inputIds.add(input.id);
    }
    for (const input of op.inputs) replay.delete(input.id);
    for (const output of op.outputs) {
      if (!isPlainObject(output) || typeof output.id !== 'string') {
        return invariantFailure('conservation', `proof op ${op.index} has a malformed output`);
      }
      if (replay.has(output.id)) {
        return invariantFailure('conservation', `proof op ${op.index} introduces duplicate id ${output.id}`);
      }
      replay.set(output.id, output);
    }
    recomputedContribs.push(opContribution(op));
    if (!deepEqual(op.contributions || {}, recomputedContribs[i])) {
      return invariantFailure(
        'conservation',
        `proof op ${op.index} records contributions ${canonicalJson(op.contributions)} but recomputed ${canonicalJson(recomputedContribs[i])}`
      );
    }
    if ((op.op === 'split' || op.op === 'merge') && Object.keys(recomputedContribs[i]).length > 0) {
      const account = Object.keys(recomputedContribs[i]).sort()[0];
      return invariantFailure(
        'conservation',
        `proof op ${op.index} (${op.op}) is non-conserving for account ${account}: ${canonicalJson(recomputedContribs[i][account])}`
      );
    }
  }

  const replayed = [...replay.values()].map(canonicalJson).sort();
  const actual = newInstructions.map(canonicalJson).sort();
  if (!deepEqual(replayed, actual)) {
    return invariantFailure('conservation', 'replaying proof.ops from the old table does not reproduce the new table');
  }

  const aggregated = {};
  for (const contrib of recomputedContribs) {
    for (const [account, row] of Object.entries(contrib)) addContribution(aggregated, account, row.net, row.freeze);
  }
  if (!deepEqual(pruneZeros(aggregated), expectedDelta)) {
    return invariantFailure(
      'conservation',
      `op contributions ${canonicalJson(pruneZeros(aggregated))} do not add up to the per-account delta ${canonicalJson(expectedDelta)}`
    );
  }

  const expectedConservation = ops
    .map((op, i) => ({ op, contrib: recomputedContribs[i] }))
    .filter(({ op }) => op.op === 'split' || op.op === 'merge')
    .map(({ op, contrib }) => ({ opIndex: op.index, op: op.op, accounts: contrib, ok: Object.keys(contrib).length === 0 }));
  if (!deepEqual(proof.conservation, expectedConservation)) {
    return invariantFailure('conservation', 'proof.conservation section does not match the declared ops');
  }

  // Invariant 3: forbiddenOps — no forbidden operation may have occurred.
  if (!Array.isArray(proof.forbiddenOps) || proof.forbiddenOps.length > 0) {
    return invariantFailure('forbiddenOps', `proof lists forbidden ops: ${canonicalJson(proof.forbiddenOps)}`);
  }

  const newById = new Map(newInstructions.map((inst) => [inst.id, inst]));
  for (const inst of oldInstructions) {
    if (inst.state !== 'SETTLED') continue;
    const persisted = newById.get(inst.id);
    if (persisted) {
      if (!deepEqual(amountsOf(persisted), amountsOf(inst)) || persisted.state !== 'SETTLED') {
        return invariantFailure('forbiddenOps', `SETTLED instruction ${inst.id} had its amounts or state modified`);
      }
    }
  }

  for (const op of ops) {
    const settledInputs = op.inputs.filter((input) => input.state === 'SETTLED');
    if (settledInputs.length === 0) continue;
    if (op.op === 'restate') {
      const before = op.inputs[0];
      const after = op.outputs[0];
      const changed = Object.keys(after).filter((key) => key !== 'memo' && !deepEqual(after[key], before[key]));
      if (changed.length > 0) {
        return invariantFailure(
          'forbiddenOps',
          `proof op ${op.index} restates SETTLED instruction ${before.id} fields other than memo: ${changed.join(', ')}`
        );
      }
    } else {
      const beforeSum = sumAmounts(op.inputs);
      const afterSum = sumAmounts(op.outputs);
      if (!deepEqual(beforeSum, afterSum)) {
        return invariantFailure(
          'forbiddenOps',
          `proof op ${op.index} (${op.op}) does not preserve the amounts of SETTLED instruction(s) ${settledInputs
            .map((input) => input.id)
            .join(', ')}`
        );
      }
    }
  }

  return { ok: true };
}

module.exports = { verifyProof };
