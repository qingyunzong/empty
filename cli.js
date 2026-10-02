#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Planner, PlannerError } from './src/planner.js';

const DEFAULT_DB = process.env.PLANNER_DB ?? './planner-db.json';

const COMMANDS = {
  add: {
    options: {
      id: { type: 'string' },
      desc: { type: 'string' },
      material: { type: 'string' },
      equipment: { type: 'string' },
      cost: { type: 'string' },
      overdue: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
    },
    run(planner, v) {
      const job = planner.addJob({
        id: v.id,
        description: v.desc,
        material: v.material,
        equipment: v.equipment,
        cost: Number(v.cost),
        overdue: Number(v.overdue),
      });
      return { added: job.id };
    },
    persist: true,
  },
  void: {
    options: {
      id: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
    },
    run(planner, v) {
      planner.voidJob(v.id);
      return { voided: v.id };
    },
    persist: true,
  },
  restore: {
    options: {
      id: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
    },
    run(planner, v) {
      planner.restoreJob(v.id);
      return { restored: v.id };
    },
    persist: true,
  },
  select: {
    options: {
      material: { type: 'string' },
      equipment: { type: 'string' },
      k: { type: 'string' },
      budget: { type: 'string' },
      one: { type: 'boolean', default: false },
      db: { type: 'string', default: DEFAULT_DB },
    },
    run(planner, v) {
      return planner.select({
        material: v.material,
        equipment: v.equipment,
        k: Number(v.k),
        budget: Number(v.budget),
        one: v.one,
      });
    },
    persist: false,
  },
  explain: {
    options: {
      id: { type: 'string' },
      material: { type: 'string' },
      equipment: { type: 'string' },
      db: { type: 'string', default: DEFAULT_DB },
    },
    run(planner, v) {
      return planner.explain(v.id, { material: v.material, equipment: v.equipment });
    },
    persist: false,
  },
};

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) {
    io.stderr.write(`usage: planner <${Object.keys(COMMANDS).join('|')}> [options]\n`);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: spec.options, strict: true }));
  } catch (err) {
    io.stderr.write(`${JSON.stringify({ error: { code: 'E_USAGE', message: err.message } })}\n`);
    return 2;
  }
  const dbPath = values.db;
  const planner = existsSync(dbPath)
    ? Planner.fromJSON(JSON.parse(readFileSync(dbPath, 'utf8')))
    : new Planner();
  try {
    const output = spec.run(planner, values);
    if (spec.persist) writeFileSync(dbPath, `${JSON.stringify(planner.toJSON(), null, 2)}\n`);
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof PlannerError) {
      io.stderr.write(`${JSON.stringify({ error: { code: err.code, message: err.message } })}\n`);
      return 1;
    }
    throw err;
  }
}

const invokedAsMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsMain) {
  process.exit(run(process.argv.slice(2)));
}
