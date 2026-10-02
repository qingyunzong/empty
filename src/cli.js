import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { buildSnapshot } from './snapshot.js';
import { diffSnapshots } from './diff.js';
import { explain } from './explain.js';
import { patchRun, recover, validateChange } from './patch.js';
import { RundiffError } from './errors.js';

const USAGE = `rundiff - locate minimal dataset/parameter differences between runs

usage:
  rundiff snap <runDir> [--name n]       normalize a run directory into a snapshot
  rundiff diff <a> <b> [tolerance flags] symmetric diff of two snapshots
  rundiff minexplain <a> <b> [--one]     minimal explanation set(s) for the diff
  rundiff patch <runDir> <change.json>   apply a parameter change (journaled)
  rundiff recheck                        replay journals, re-run last saved query

tolerance flags: --tol-abs <n> --tol-rel <n>
store dir: --store <dir> or RUNDIFF_STORE (default ./.rundiff)
`;

function parseFlags(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--one') { flags.one = true; continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = args[i + 1]; i += 1; continue; }
    pos.push(a);
  }
  return { pos, flags };
}

function tolFromFlags(flags) {
  const tol = {};
  if (flags['tol-abs'] !== undefined) tol.abs = Number(flags['tol-abs']);
  if (flags['tol-rel'] !== undefined) tol.rel = Number(flags['tol-rel']);
  return Object.keys(tol).length ? tol : undefined;
}

function resultHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function runQuery(store, query) {
  const snapA = store.loadSnapshot(query.a);
  const snapB = store.loadSnapshot(query.b);
  if (query.type === 'diff') return diffSnapshots(snapA, snapB, query.options ?? undefined);
  return explain(snapA, snapB, query.options ?? undefined, query.explainOpts ?? {});
}

export function main(argv) {
  const { pos, flags } = parseFlags(argv);
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const storeDir = flags.store ?? process.env.RUNDIFF_STORE ?? path.join(process.cwd(), '.rundiff');
  const store = new Store(storeDir);
  try {
    return run(store, cmd, pos, flags);
  } catch (e) {
    if (e instanceof RundiffError) {
      try {
        store.atomicWrite(store.p('last-error.json'), JSON.stringify({ code: e.code, message: e.message }));
      } catch { /* best effort */ }
    }
    throw e;
  }
}

function run(store, cmd, pos, flags) {
  // Crash recovery runs before every command so interrupted patches replay.
  for (const id of recover(store)) {
    process.stderr.write(`recovered interrupted patch ${id}\n`);
  }
  switch (cmd) {
    case 'snap': {
      const runDir = pos[1];
      if (!runDir) throw new RundiffError('E_USAGE', 'snap requires <runDir>');
      const name = flags.name ?? path.basename(path.resolve(runDir));
      const snap = buildSnapshot(runDir, name);
      store.saveSnapshot(snap);
      process.stdout.write(`snapshot ${name} ${snap.hash}\n`);
      return 0;
    }
    case 'diff': {
      const [, a, b] = pos;
      if (!a || !b) throw new RundiffError('E_USAGE', 'diff requires <a> <b>');
      const tol = tolFromFlags(flags);
      const result = diffSnapshots(store.loadSnapshot(a), store.loadSnapshot(b), tol);
      store.saveQuery({ type: 'diff', a, b, options: tol ?? null, resultHash: resultHash(result), result });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return 0;
    }
    case 'minexplain': {
      const [, a, b] = pos;
      if (!a || !b) throw new RundiffError('E_USAGE', 'minexplain requires <a> <b>');
      const tol = tolFromFlags(flags);
      const result = explain(store.loadSnapshot(a), store.loadSnapshot(b), tol, { one: flags.one === true });
      const output = { ambiguous: result.ambiguous, explanations: result.explanations, diff: result.diff };
      store.saveQuery({
        type: 'minexplain', a, b, options: tol ?? null,
        explainOpts: { one: flags.one === true }, resultHash: resultHash(result), result: output,
      });
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      return 0;
    }
    case 'patch': {
      const [, runDir, changeFile] = pos;
      if (!runDir || !changeFile) throw new RundiffError('E_USAGE', 'patch requires <runDir> <change.json>');
      let change;
      try {
        change = validateChange(JSON.parse(fs.readFileSync(changeFile, 'utf8')));
      } catch (e) {
        if (e instanceof RundiffError) throw e;
        throw new RundiffError('E_PATCH', `cannot read change file: ${e.message}`);
      }
      const { id, snapshot } = patchRun(store, runDir, change, {
        crashAfter: process.env.RUNDIFF_CRASH_AFTER,
      });
      process.stdout.write(`patched ${runDir} (journal ${id}); snapshot ${snapshot} updated\n`);
      return 0;
    }
    case 'recheck': {
      const query = store.loadQuery();
      const result = runQuery(store, query);
      const hash = resultHash(result);
      const match = hash === query.resultHash;
      process.stdout.write(`recheck ${query.type} ${query.a} ${query.b}: ${match ? 'MATCH' : 'MISMATCH'}\n`);
      return match ? 0 : 4;
    }
    default:
      throw new RundiffError('E_USAGE', `unknown command: ${cmd}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof RundiffError) {
    process.stderr.write(`error[${e.code}]: ${e.message}\n`);
  } else {
    process.stderr.write(`error[E_INTERNAL]: ${e.message}\n`);
  }
  process.exitCode = 1;
}
