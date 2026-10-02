// plan CLI: init / apply / recover / export
// Exit codes: 0 ok, 1 ERROR (usage/parse/type/txn), 2 INFEASIBLE, 3 RECOVERY_ERROR

import fs from 'node:fs';
import { Store, RecoveryError } from './store.js';
import { parseScript, ParseError, LexError } from './parser.js';
import { Interpreter, DslError, InfeasibleError } from './dsl.js';
import { TypeError_ } from './types.js';
import { TxnError } from './txn.js';
import { scheduleJobs } from './schedule.js';
import { instantString } from './lexer.js';

export const EXIT = { OK: 0, ERROR: 1, INFEASIBLE: 2, RECOVERY_ERROR: 3 };

// Synchronous writes: console.log output can be lost when stdout is a pipe.
function out(s) { fs.writeSync(1, s + '\n'); }
function err(s) { fs.writeSync(2, s + '\n'); }

function usage() {
  err('usage: plan <init|apply|recover|export> <dir> [script-file|-]');
  return EXIT.ERROR;
}

function exportPlan(state) {
  const result = scheduleJobs(state.jobs, state.env.lines);
  if (result === null) {
    out('INFEASIBLE');
    return EXIT.INFEASIBLE;
  }
  const lineNames = state.env.lines.map((l) => l.name);
  const jobs = [...state.jobs].sort((a, b) => (a.id < b.id ? -1 : 1)).map((j) => {
    const p = result.placement.get(j.id);
    return {
      id: j.id,
      line: lineNames[p.line],
      start: instantString(p.start),
      end: instantString(p.start + j.duration),
      duration: j.duration,
      priority: j.priority,
    };
  });
  out(JSON.stringify({ generation: state.gen, jobs }, null, 2));
  return EXIT.OK;
}

export function main(argv) {
  const [cmd, dir, file] = argv;
  try {
    switch (cmd) {
      case 'init': {
        if (!dir) return usage();
        new Store(dir).init();
        out('OK');
        return EXIT.OK;
      }
      case 'apply': {
        if (!dir || !file) return usage();
        const src = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
        const store = new Store(dir);
        const state = store.recover();
        const interp = new Interpreter(state, store);
        const commits = interp.execAll(parseScript(src));
        for (const c of commits) out(`COMMITTED gen=${c.gen} jobs=${c.jobs}`);
        if (commits.length === 0) out('UNCOMMITTED');
        return EXIT.OK;
      }
      case 'recover': {
        if (!dir) return usage();
        const state = new Store(dir).recover();
        out(`RECOVERED gen=${state.gen} jobs=${state.jobs.length}`);
        return EXIT.OK;
      }
      case 'export': {
        if (!dir) return usage();
        const state = new Store(dir).recover();
        return exportPlan(state);
      }
      default:
        return usage();
    }
  } catch (e) {
    if (e instanceof RecoveryError) {
      out('RECOVERY_ERROR');
      err(`RECOVERY_ERROR: ${e.message}`);
      return EXIT.RECOVERY_ERROR;
    }
    if (e instanceof InfeasibleError) {
      out('INFEASIBLE');
      err(`INFEASIBLE: ${e.message}`);
      return EXIT.INFEASIBLE;
    }
    if (e instanceof ParseError || e instanceof LexError || e instanceof TypeError_ ||
        e instanceof DslError || e instanceof TxnError) {
      err(`ERROR: ${e.message}`);
      return EXIT.ERROR;
    }
    throw e;
  }
}
