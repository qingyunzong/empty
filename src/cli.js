#!/usr/bin/env node
// qcl - offline quality closed-loop CLI.
// Commands: open | rework | close | correct | undo | crash-recover | verify | state
// Env: QCL_DIR (state dir, default .qcl), QCL_CRASH_AT (fault injection).
import fs from 'node:fs';
import { apply, buildIndex, MachineError } from './machine.js';
import { hashState } from './hash.js';
import { ensureDir, appendWal, writeSnapshot, writeIndex, CRASH_POINTS } from './store.js';
import { recover, loadStrict } from './recover.js';

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? true;
    } else args.push(a);
  }
  return { args, flags };
}

function out(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(`${line}\n`);
  // Mirror to a file when stdout piping is unavailable (offline sandboxes).
  if (process.env.QCL_OUT) fs.appendFileSync(process.env.QCL_OUT, `${line}\n`);
}

function errOut(msg) {
  process.stderr.write(`${msg}\n`);
  if (process.env.QCL_ERR) fs.appendFileSync(process.env.QCL_ERR, `${msg}\n`);
}

function mutate(dir, op, { snapshot = false } = {}) {
  ensureDir(dir);
  const state = loadStrict(dir);
  apply(state, op);
  const hash = hashState(state);
  appendWal(dir, { seq: state.seq, op, hash });          // crash point: wal-append
  if (snapshot) writeSnapshot(dir, state);               // crash point: snapshot-rename
  writeIndex(dir, buildIndex(state));                    // crash point: index-update
  return { state, hash };
}

function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0];
  const dir = flags.dir ?? process.env.QCL_DIR ?? '.qcl';

  switch (cmd) {
    case 'open': {
      const [defectId] = args.slice(1);
      const { state, hash } = mutate(dir, { type: 'open', defectId, desc: flags.desc ?? '' });
      out({ ok: true, node: `n${state.seq}`, defect: defectId, hash });
      break;
    }
    case 'rework': {
      const [orderId, ...defectIds] = args.slice(1);
      const { state, hash } = mutate(dir, { type: 'rework', orderId, defectIds });
      out({ ok: true, node: `n${state.seq}`, order: orderId, defects: defectIds, hash });
      break;
    }
    case 'close': {
      const [orderId] = args.slice(1);
      const { state, hash } = mutate(
        dir, { type: 'close', orderId, result: flags.result }, { snapshot: true },
      );
      out({ ok: true, node: `n${state.seq}`, order: orderId, result: flags.result, hash });
      break;
    }
    case 'correct': {
      const [orderId] = args.slice(1);
      const { state, hash } = mutate(dir, { type: 'correct', orderId, result: flags.result });
      const corr = state.corrections.at(-1);
      out({ ok: true, node: `n${state.seq}`, order: orderId, impactSet: corr.impactSet, hash });
      break;
    }
    case 'undo': {
      const [nodeId] = args.slice(1);
      const { state, hash } = mutate(dir, {
        type: 'undo', nodeId, reason: flags.reason ?? '',
      });
      out({ ok: true, node: `n${state.seq}`, undone: nodeId, hash });
      break;
    }
    case 'crash-recover': {
      ensureDir(dir);
      const { report } = recover(dir);
      out({ ok: true, recovered: report });
      break;
    }
    case 'verify': {
      ensureDir(dir);
      const { report, index } = recover(dir);
      out({ ok: true, hash: report.hash, seq: report.seq, index });
      break;
    }
    case 'state': {
      const state = loadStrict(dir);
      out(state);
      break;
    }
    default:
      errOut(
        'usage: qcl <open|rework|close|correct|undo|crash-recover|verify|state> [--dir=DIR]\n'
        + `crash injection: QCL_CRASH_AT=${CRASH_POINTS.join('|')}`,
      );
      process.exit(2);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof MachineError) {
    errOut(`error: ${err.message}`);
    process.exit(err.code);
  }
  errOut(`fatal: ${err.message}`);
  process.exit(1);
}
