import { MaintenanceStore } from './store.js';
import { solveSelection, verifyCertificate } from './solver.js';
import { parseRational } from './rational.js';

export function parseCommands(text) {
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  } catch {
    const cmds = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) cmds.push(JSON.parse(line));
    }
    return cmds;
  }
}

export function createHandler(store = new MaintenanceStore()) {
  return function handle(cmd) {
    try {
      switch (cmd?.op) {
        case 'import':
          return store.importBatch(cmd.tasks);
        case 'undo':
          return store.undo();
        case 'redo':
          return store.redo();
        case 'state':
          return { ok: true, ...store.snapshot() };
        case 'solve': {
          const budget = parseRational(cmd.budget);
          const limit = parseRational(cmd.durationLimit);
          const res = solveSelection(store.tasks, budget, limit);
          if (res.status === 'E_UNSAT') {
            return { ok: false, error: 'E_UNSAT', message: res.message };
          }
          return { ok: true, ...res };
        }
        case 'verify': {
          const budget = parseRational(cmd.budget);
          const limit = parseRational(cmd.durationLimit);
          return { ok: true, ...verifyCertificate(store.tasks, budget, limit, cmd.certificate) };
        }
        default:
          return { ok: false, error: 'E_UNKNOWN_OP', message: `unknown op: ${cmd?.op}` };
      }
    } catch (e) {
      return { ok: false, error: e.code ?? 'E_INTERNAL', message: e.message };
    }
  };
}

export function runCommands(text) {
  const handle = createHandler();
  let commands;
  try {
    commands = parseCommands(text);
  } catch (e) {
    return [{ ok: false, error: 'E_JSON', message: e.message }];
  }
  return commands.map(handle);
}
