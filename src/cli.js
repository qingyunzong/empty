'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { stateHash, validateState } = require('./state');
const { applyOps, ERR_UNKNOWN_OP } = require('./apply');
const { buildPatch, verifyPatch } = require('./diff');

const EXIT_HASH_MISMATCH = 6;
const EXIT_INVARIANT = 7;
const EXIT_UNKNOWN_OP = 8;

// Runs a CLI command in-process. Returns { code, stdout, stderr } where
// stdout/stderr are arrays of parsed JSON objects (one per line).
function run(argv, io = {}) {
  const stdout = [];
  const stderr = [];
  const out = (obj) => stdout.push(obj);
  const err = (obj) => stderr.push(obj);
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const writeJson = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');

  const failApply = (e) => {
    err({ error: e.message, opIndex: e.opIndex });
    return e.code === ERR_UNKNOWN_OP ? EXIT_UNKNOWN_OP : EXIT_INVARIANT;
  };

  const loadStateAndPatch = (statePath, patchPath) => {
    const state = readJson(statePath);
    const patch = readJson(patchPath);
    const stateErr = validateState(state);
    if (stateErr) return { error: { code: 1, obj: { error: `invalid state: ${stateErr}` } } };
    const patchErr = verifyPatch(patch);
    if (patchErr) return { error: { code: EXIT_HASH_MISMATCH, obj: { error: patchErr } } };
    return { state, patch };
  };

  const cmdDiff = (args) => {
    const outIdx = args.indexOf('--out');
    const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
    const files = args.filter((a, i) => a !== '--out' && (outIdx === -1 || i !== outIdx + 1));
    if (files.length !== 2) {
      err({ error: 'usage: diff <base.json> <target.json> --out patch.json' });
      return 1;
    }
    let patch;
    try {
      patch = buildPatch(readJson(files[0]), readJson(files[1]));
    } catch (e) {
      err({ error: e.message });
      return 1;
    }
    if (outPath) writeJson(outPath, patch);
    else stdout.push(patch);
    out({ status: 'diffed', fromHash: patch.fromHash, toHash: patch.toHash, ops: patch.ops.length, sha256: patch.sha256, ...(outPath ? { out: outPath } : {}) });
    return 0;
  };

  const cmdApply = (args) => {
    const dryRun = args.includes('--dry-run');
    const files = args.filter((a) => a !== '--dry-run');
    if (files.length !== 2) {
      err({ error: 'usage: apply <state.json> <patch.json> [--dry-run]' });
      return 1;
    }
    const loaded = loadStateAndPatch(files[0], files[1]);
    if (loaded.error) { err(loaded.error.obj); return loaded.error.code; }
    const { state, patch } = loaded;
    const currentHash = stateHash(state);
    if (currentHash === patch.toHash) {
      out({ status: 'already-applied', hash: currentHash });
      return 0;
    }
    if (currentHash !== patch.fromHash) {
      err({ error: 'state hash mismatch: current state matches neither fromHash nor toHash', currentHash, fromHash: patch.fromHash, toHash: patch.toHash });
      return EXIT_HASH_MISMATCH;
    }
    const result = applyOps(state, patch.ops);
    if (!result.ok) return failApply(result.error);
    const newHash = stateHash(result.state);
    if (newHash !== patch.toHash) {
      err({ error: 'resulting state hash does not match patch.toHash', newHash, toHash: patch.toHash });
      return EXIT_HASH_MISMATCH;
    }
    if (dryRun) {
      out({ status: 'dry-run', fromHash: currentHash, toHash: newHash, ops: patch.ops.length });
      return 0;
    }
    writeJson(files[0], result.state);
    out({ status: 'applied', fromHash: currentHash, toHash: newHash, ops: patch.ops.length });
    return 0;
  };

  const cmdRevert = (args) => {
    const dryRun = args.includes('--dry-run');
    const files = args.filter((a) => a !== '--dry-run');
    if (files.length !== 2) {
      err({ error: 'usage: revert <state.json> <patch.json>' });
      return 1;
    }
    const loaded = loadStateAndPatch(files[0], files[1]);
    if (loaded.error) { err(loaded.error.obj); return loaded.error.code; }
    const { state, patch } = loaded;
    const currentHash = stateHash(state);
    if (currentHash !== patch.toHash) {
      err({ error: 'revert refused: current state hash != patch.toHash', currentHash, toHash: patch.toHash });
      return EXIT_HASH_MISMATCH;
    }
    const result = applyOps(state, patch.inverse);
    if (!result.ok) return failApply(result.error);
    const newHash = stateHash(result.state);
    if (newHash !== patch.fromHash) {
      err({ error: 'reverted state hash does not match patch.fromHash', newHash, fromHash: patch.fromHash });
      return EXIT_HASH_MISMATCH;
    }
    if (dryRun) {
      out({ status: 'dry-run', fromHash: newHash, toHash: currentHash, ops: patch.inverse.length });
      return 0;
    }
    writeJson(files[0], result.state);
    out({ status: 'reverted', fromHash: newHash, toHash: currentHash, ops: patch.inverse.length });
    return 0;
  };

  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'diff': return { code: cmdDiff(args), stdout, stderr };
      case 'apply': return { code: cmdApply(args), stdout, stderr };
      case 'revert': return { code: cmdRevert(args), stdout, stderr };
      default:
        err({ error: 'usage: cli.js <diff|apply|revert> ...' });
        return { code: 1, stdout, stderr };
    }
  } catch (e) {
    err({ error: e.message });
    return { code: 1, stdout, stderr };
  }
}

module.exports = { run, EXIT_HASH_MISMATCH, EXIT_INVARIANT, EXIT_UNKNOWN_OP };
