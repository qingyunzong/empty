import fs from 'node:fs';
import { Interpreter, modelToCanonical } from './interp.js';
import { schedule, scheduleToJSON } from './model.js';
import {
  RecoveryError, initStore, isInitialized, recoverStore, sha256,
  appendWal, writeState, writeCheckpoint,
} from './persist.js';

export const EXIT = { OK: 0, ERROR: 1, INFEASIBLE: 2, RECOVERY_ERROR: 3 };

// Synchronous writes so output survives process exit in every environment.
const out = (s) => fs.writeSync(1, s + '\n');
const err = (s) => fs.writeSync(2, s + '\n');

const USAGE = `usage:
  plan init <dir>                 initialize a persistence directory
  plan apply <dir> <script.plan>  run a script inside a transaction
  plan recover <dir>              replay WAL and repair state/checkpoint
  plan export <dir>               print the committed schedule as JSON`;

function cmdInit(dir) {
  if (!dir) { err('ERROR: init requires a directory'); return EXIT.ERROR; }
  initStore(dir);
  out(`initialized ${dir}`);
  return EXIT.OK;
}

function cmdApply(dir, file) {
  if (!dir || !file) { err('ERROR: apply requires <dir> and <script>'); return EXIT.ERROR; }
  if (!isInitialized(dir)) {
    err(`ERROR: ${dir} is not initialized; run 'plan init ${dir}' first`);
    return EXIT.ERROR;
  }
  const { model, seq } = recoverStore(dir);
  const script = fs.readFileSync(file, 'utf8');
  const interp = new Interpreter(model);
  interp.runSource(script);

  const placed = schedule(model);
  if (!placed) {
    out('INFEASIBLE');
    return EXIT.INFEASIBLE;
  }
  if (interp.committed) {
    const newSeq = seq + 1;
    appendWal(dir, newSeq, script);
    const canonical = modelToCanonical(model);
    writeState(dir, canonical, newSeq);
    writeCheckpoint(dir, newSeq, sha256(JSON.stringify({ seq: newSeq, model: canonical })));
  }
  out(JSON.stringify(scheduleToJSON(model, placed), null, 2));
  return EXIT.OK;
}

function cmdRecover(dir) {
  if (!dir) { err('ERROR: recover requires a directory'); return EXIT.ERROR; }
  if (!isInitialized(dir)) {
    err(`ERROR: ${dir} is not initialized; run 'plan init ${dir}' first`);
    return EXIT.ERROR;
  }
  const { seq, repaired, tailIgnored } = recoverStore(dir);
  const parts = [`seq=${seq}`, `repaired=${repaired.length ? repaired.join('+') : 'none'}`];
  if (tailIgnored) parts.push('tail=ignored');
  out(`RECOVERED ${parts.join(' ')}`);
  return EXIT.OK;
}

function cmdExport(dir) {
  if (!dir) { err('ERROR: export requires a directory'); return EXIT.ERROR; }
  if (!isInitialized(dir)) {
    err(`ERROR: ${dir} is not initialized; run 'plan init ${dir}' first`);
    return EXIT.ERROR;
  }
  const { model } = recoverStore(dir);
  const placed = schedule(model);
  if (!placed) {
    out('INFEASIBLE');
    return EXIT.INFEASIBLE;
  }
  out(JSON.stringify(scheduleToJSON(model, placed), null, 2));
  return EXIT.OK;
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'init': return cmdInit(rest[0]);
      case 'apply': return cmdApply(rest[0], rest[1]);
      case 'recover': return cmdRecover(rest[0]);
      case 'export': return cmdExport(rest[0]);
      default:
        err(USAGE);
        return EXIT.ERROR;
    }
  } catch (e) {
    if (e instanceof RecoveryError) {
      err(`RECOVERY_ERROR: ${e.message}`);
      return EXIT.RECOVERY_ERROR;
    }
    err(`ERROR: ${e.message}`);
    return EXIT.ERROR;
  }
}
