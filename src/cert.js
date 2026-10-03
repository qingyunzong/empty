import { sha256Hex, stableStringify } from './hash.js';

export function bytecodeHashOf(unit) {
  return sha256Hex(stableStringify({ code: unit.code, locs: unit.locs, consts: unit.consts }));
}

// Certificate of a settlement run. Hashes are recorded per *executed* rule
// (plus every global touched during execution), so changing a rule only
// invalidates the certificates of batches that actually used it.
export function buildCert({ chunk, inputRaw, results, trace, usedGlobals, executedRules }) {
  const names = [...new Set([...executedRules, ...usedGlobals])].sort();
  const rulesHash = {};
  const bytecodeHash = {};
  for (const name of names) {
    const unit = chunk.rules.find((r) => r.name === name) || chunk.globals.find((g) => g.name === name);
    if (!unit) continue;
    rulesHash[name] = unit.hash;
    bytecodeHash[name] = bytecodeHashOf(unit);
  }
  return {
    version: 1,
    rulesHash,
    inputHash: sha256Hex(inputRaw),
    bytecodeHash,
    traceSummary: { steps: trace.length, hash: sha256Hex(stableStringify(trace)) },
    results,
  };
}
