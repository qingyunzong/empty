// Command pipeline shared by the CLI and tests: pure string -> results.

import { Store } from './store.js';
import { solve } from './solver.js';
import { Rational } from './rational.js';

export function parseCommands(input) {
  const trimmed = input.trim();
  if (trimmed === '') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const commands = [];
    for (const line of trimmed.split('\n')) {
      if (line.trim() !== '') commands.push(JSON.parse(line));
    }
    return commands;
  }
}

function fail(error) {
  return { ok: false, error: error.code ?? 'E_INTERNAL', message: error.message };
}

export function dispatch(store, cmd) {
  try {
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return { ok: false, error: 'E_COMMAND', message: 'command must be an object' };
    }
    switch (cmd.op) {
      case 'import':
        return { ok: true, imported: store.importBatch(cmd.tasks) };
      case 'undo':
        return { ok: true, undone: store.undo() };
      case 'redo':
        return { ok: true, redone: store.redo() };
      case 'list':
        return {
          ok: true,
          tasks: store.list().map((t) => ({
            id: t.id,
            priority: t.priority.toString(),
            cost: [t.cl.toString(), t.ch.toString()],
            duration: [t.dl.toString(), t.dh.toString()],
            precedence: t.deps,
          })),
        };
      case 'solve': {
        const budget = Rational.parse(cmd.budget ?? 0);
        const limit = Rational.parse(cmd.durationLimit ?? cmd.duration ?? 0);
        return { ok: true, ...solve(store.list(), budget, limit) };
      }
      default:
        return { ok: false, error: 'E_COMMAND', message: `unknown op: ${cmd.op}` };
    }
  } catch (error) {
    return fail(error);
  }
}

// Runs a whole stdin payload, returns one result object per command.
export function runCommands(input) {
  let commands;
  try {
    commands = parseCommands(input);
  } catch (error) {
    return [{ ok: false, error: 'E_JSON', message: error.message }];
  }
  const store = new Store();
  return commands.map((cmd) => dispatch(store, cmd));
}
