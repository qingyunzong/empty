#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const {
  EXIT,
  PatchError,
  hashState,
  available,
  makePatch,
  applyPatch,
  revertPatch,
} = require('./patchlib');

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CliError(`cannot read ${path}: ${e.message}`, EXIT.USAGE);
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function short(hash) {
  return String(hash).slice(0, 12);
}

const USAGE = [
  'usage:',
  '  node cli.js diff <base.json> <target.json> --out <patch.json>',
  '  node cli.js apply <state.json> <patch.json> [--dry-run]',
  '  node cli.js revert <state.json> <patch.json> [--dry-run]',
].join('\n');

function printStateSummary(label, state) {
  const ids = Object.keys(state.accounts).sort();
  console.log(`${label} hash=${short(hashState(state))} accounts=${ids.length}`);
  for (const id of ids) {
    const a = state.accounts[id];
    console.log(
      `  ${id}: limit=${a.limit} used=${a.used} holds=${a.holds.length} available=${available(a)}`);
  }
}

function cmdDiff(args) {
  const outIdx = args.indexOf('--out');
  const positional = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);
  const [basePath, targetPath] = positional;
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  if (!basePath || !targetPath || !outPath) throw new CliError(USAGE, EXIT.USAGE);
  const base = readJson(basePath);
  const target = readJson(targetPath);
  const patch = makePatch(base, target);
  writeJson(outPath, patch);
  console.log(
    `diff ok: ops=${patch.ops.length} from=${short(patch.fromHash)} ` +
    `to=${short(patch.toHash)} sha256=${short(patch.sha256)} -> ${outPath}`);
  for (const op of patch.ops) console.log(`  op ${JSON.stringify(op)}`);
  return EXIT.OK;
}

function cmdApplyOrRevert(cmd, args) {
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  const [statePath, patchPath] = positional;
  if (!statePath || !patchPath) throw new CliError(USAGE, EXIT.USAGE);
  const state = readJson(statePath);
  const patch = readJson(patchPath);
  const fn = cmd === 'apply' ? applyPatch : revertPatch;
  let result;
  try {
    result = fn(state, patch);
  } catch (e) {
    if (e instanceof PatchError) {
      const where = e.opIndex === null ? '' : ` opIndex=${e.opIndex}`;
      console.error(`${cmd} failed:${where} ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
  const verb = cmd === 'apply' ? 'applied' : 'reverted';
  if (result.alreadyApplied) {
    console.log(`${cmd} ok: already applied (idempotent no-op), hash=${short(hashState(result.state))}`);
  } else {
    console.log(`${cmd} ok: ${verb} ${result.appliedOps} ops${dryRun ? ' (dry-run, state not written)' : ''}`);
  }
  printStateSummary(dryRun ? 'would-be state:' : 'state:', result.state);
  if (!dryRun) writeJson(statePath, result.state);
  return EXIT.OK;
}

// 返回退出码；顶部入口把它赋给 process.exitCode（不用 process.exit，避免截断管道输出）。
function run(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'diff') return cmdDiff(rest);
    if (cmd === 'apply' || cmd === 'revert') return cmdApplyOrRevert(cmd, rest);
    console.error(USAGE);
    return EXIT.USAGE;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`error: ${e.message}`);
      return e.code;
    }
    if (e instanceof PatchError) {
      console.error(`error: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
