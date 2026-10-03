#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Planner } from './src/planner.js';
import { PlannerError } from './src/scheduler.js';

const EXIT_CODES = { E_BUDGET: 2, E_CONFLICT: 3, E_EMPTY: 4 };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// Returns { code, stdout, stderr } so it can be tested in-process.
export function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const statePath = args.state ?? 'planner-state.json';
  try {
    const planner = new Planner(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
    switch (command) {
      case 'plan': {
        const out = { conflicts: planner.conflicts() };
        if (args.task) {
          out.best = planner.plan(JSON.parse(args.task), args.horizon ? Number(args.horizon) : 200);
          if (!out.best) throw new PlannerError('E_EMPTY', 'no feasible placement');
        }
        return { code: 0, stdout: JSON.stringify(out, null, 2), stderr: '' };
      }
      case 'change': {
        if (!args.op) throw new Error('missing --op');
        const id = planner.applyChange(args.note ?? null, JSON.parse(args.op));
        writeFileSync(statePath, JSON.stringify(planner.state, null, 2));
        return { code: 0, stdout: JSON.stringify({ changeId: id, conflicts: planner.conflicts() }), stderr: '' };
      }
      case 'undo': {
        const id = planner.undo();
        writeFileSync(statePath, JSON.stringify(planner.state, null, 2));
        return { code: 0, stdout: JSON.stringify({ undone: id, conflicts: planner.conflicts() }), stderr: '' };
      }
      case 'redo': {
        const id = planner.redo();
        writeFileSync(statePath, JSON.stringify(planner.state, null, 2));
        return { code: 0, stdout: JSON.stringify({ redone: id, conflicts: planner.conflicts() }), stderr: '' };
      }
      case 'query': {
        if (!args.phrase) throw new Error('missing --phrase');
        const hits = planner.query(args.phrase, {
          near: args.near !== undefined ? Number(args.near) : null,
          from: args.from !== undefined ? Number(args.from) : null,
          to: args.to !== undefined ? Number(args.to) : null,
        });
        if (!hits.length) throw new PlannerError('E_EMPTY', 'no matching change notes');
        return { code: 0, stdout: JSON.stringify({ hits }), stderr: '' };
      }
      default:
        return { code: 1, stdout: '', stderr: 'usage: node cli.js <plan|change|undo|redo|query> [--state file] [options]' };
    }
  } catch (err) {
    if (err instanceof PlannerError) {
      return { code: EXIT_CODES[err.code] ?? 1, stdout: '', stderr: `${err.code} ${err.message}` };
    }
    return { code: 1, stdout: '', stderr: `E_USAGE ${err.message}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = run(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
