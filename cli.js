#!/usr/bin/env node
import fs from 'node:fs';
import {
  createState,
  addRecipe,
  lockSlot,
  unlockSlot,
  snapshot,
  restore,
  configure,
} from './src/state.js';
import { solve } from './src/solver.js';
import { enumerateOptimum } from './src/enumerate.js';

export const EXIT = { OK: 0, UNSAT: 2, PENDING: 3, ERROR: 4 };

const USAGE = `usage: node cli.js <command> [--state PATH] [options]

commands:
  configure   --data '<json>'            merge config/budgets patch into state
  add_recipe  --data '<json>'            add a recipe (finite-domain variable)
  lock_slot   --recipe ID --run N --temp T --atmosphere A --duration D
  unlock_slot --recipe ID
  snapshot                               push a snapshot, prints its id
  restore     [--id N]                   restore snapshot (default: latest);
                                         later snapshots are invalidated
  optimize    [--budgets '<json>'] [--enumerate]

exit codes: 0=OPTIMAL/ok  2=UNSAT  3=PENDING (budget exhausted)  4=usage/state error
--data accepts inline JSON, @file, or - for stdin.`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readData(flags) {
  if (flags.data === undefined || flags.data === true) {
    throw new Error('missing --data <json|@file|->');
  }
  let text = flags.data;
  if (text === '-') {
    text = fs.readFileSync(0, 'utf8');
  } else if (text.startsWith('@')) {
    text = fs.readFileSync(text.slice(1), 'utf8');
  }
  return JSON.parse(text);
}

function loadState(path) {
  if (fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  }
  return createState();
}

function saveState(path, state) {
  fs.writeFileSync(path, JSON.stringify(state, null, 2));
}

function num(flags, key) {
  if (flags[key] === undefined || flags[key] === true) {
    throw new Error(`missing --${key}`);
  }
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} must be a number, got: ${flags[key]}`);
  }
  return value;
}

function str(flags, key) {
  if (typeof flags[key] !== 'string') {
    throw new Error(`missing --${key}`);
  }
  return flags[key];
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    process.exit(command ? EXIT.OK : EXIT.ERROR);
  }
  const statePath = typeof flags.state === 'string' ? flags.state : 'kiln.state.json';
  const state = loadState(statePath);

  switch (command) {
    case 'configure': {
      configure(state, readData(flags));
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, config: state.config, budgets: state.budgets }));
      return EXIT.OK;
    }
    case 'add_recipe': {
      const recipe = addRecipe(state, readData(flags));
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, added: recipe.id }));
      return EXIT.OK;
    }
    case 'lock_slot': {
      const recipe = str(flags, 'recipe');
      const lock = {
        run: num(flags, 'run'),
        temp: num(flags, 'temp'),
        atmosphere: str(flags, 'atmosphere'),
        duration: num(flags, 'duration'),
      };
      lockSlot(state, recipe, lock);
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, locked: recipe, lock }));
      return EXIT.OK;
    }
    case 'unlock_slot': {
      const recipe = str(flags, 'recipe');
      unlockSlot(state, recipe);
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, unlocked: recipe }));
      return EXIT.OK;
    }
    case 'snapshot': {
      const id = snapshot(state);
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, snapshot: id }));
      return EXIT.OK;
    }
    case 'restore': {
      const id = flags.id === undefined || flags.id === true ? undefined : Number(flags.id);
      if (id !== undefined && !Number.isInteger(id)) {
        throw new Error(`--id must be an integer, got: ${flags.id}`);
      }
      const restored = restore(state, id);
      saveState(statePath, state);
      console.log(JSON.stringify({ ok: true, restored }));
      return EXIT.OK;
    }
    case 'optimize': {
      const budgets = { ...state.budgets };
      if (flags.budgets !== undefined && flags.budgets !== true) {
        Object.assign(budgets, JSON.parse(flags.budgets));
      }
      const instance = { config: state.config, recipes: state.recipes, locks: state.locks };
      const result = flags.enumerate
        ? enumerateOptimum(instance)
        : solve(instance, budgets);
      const scheduled = result.scheduled.map((s) => ({
        recipe: s.id,
        run: s.run,
        day: Math.floor(s.run / state.config.maxRunsPerDay),
        temp: s.temp,
        atmosphere: s.atmosphere,
        duration: s.duration,
        gas: s.gas,
      }));
      const out = {
        status: result.status,
        weight: result.weight,
        bound: result.bound ?? result.weight,
        scheduled,
      };
      if (result.core) out.core = result.core;
      if (result.budgetsUsed) out.budgetsUsed = result.budgetsUsed;
      state.lastSolution = { status: result.status, weight: result.weight, scheduled };
      saveState(statePath, state);
      console.log(JSON.stringify(out, null, 2));
      if (result.status === 'OPTIMAL') return EXIT.OK;
      if (result.status === 'UNSAT') return EXIT.UNSAT;
      return EXIT.PENDING;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  // Use exitCode (not process.exit) so piped stdout is flushed first.
  process.exitCode = main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = EXIT.ERROR;
}
