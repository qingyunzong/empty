#!/usr/bin/env node
// Usage:
//   node src/cli.js wave [file]          plan a wave from JSONL (stdin if no file)
//   node src/cli.js rollback <id> [file] cascade-rollback from a JSONL journal
//   node src/cli.js verify [file]        causal lane-occupancy admission check
//
// Exit codes: 0 ok, 2 usage/invalid input, 17 budget insufficient, 18 level-skip.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonl, JsonlError } from './jsonl.js';
import { planWave, minimalCut } from './planner.js';
import { loadJournal, rollback, RollbackError } from './journal.js';
import { verifyEvents } from './causal.js';

export const EXIT = { OK: 0, USAGE: 2, BUDGET: 17, LEVEL: 18 };

class CliExit extends Error {
  constructor(exitCode) {
    super(`exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function cmdWave(records, ctx) {
  const wave = records.find((r) => r.type === 'wave');
  const shuttles = records.filter((r) => r.type === 'shuttle');
  const tasks = records.filter((r) => r.type === 'task');
  const reuseHints = new Set(
    records.filter((r) => r.type === 'reuse').map((r) => `${r.task}:${r.route}`),
  );

  if (!wave || typeof wave.id !== 'string' || !isNonNegNumber(wave.budget)) {
    ctx.fail('INVALID_INPUT', EXIT.USAGE, { message: 'need one wave record: {type:"wave",id,budget}' });
  }
  if (shuttles.length === 0) {
    ctx.fail('INVALID_INPUT', EXIT.USAGE, { message: 'need at least one shuttle record' });
  }
  const shuttleIds = new Set();
  for (const s of shuttles) {
    if (typeof s.id !== 'string' || !isNonNegNumber(s.battery) || shuttleIds.has(s.id)) {
      ctx.fail('INVALID_INPUT', EXIT.USAGE, { message: `invalid shuttle record: ${JSON.stringify(s)}` });
    }
    shuttleIds.add(s.id);
  }
  const taskIds = new Set();
  for (const t of tasks) {
    const ok =
      typeof t.id === 'string' &&
      !taskIds.has(t.id) &&
      Array.isArray(t.routes) &&
      t.routes.length > 0 &&
      t.routes.every(
        (r) =>
          Array.isArray(r.moves) &&
          r.moves.length > 0 &&
          r.moves.every(
            (m) =>
              typeof m.lane === 'string' &&
              typeof m.from === 'string' &&
              typeof m.to === 'string' &&
              isNonNegNumber(m.energy) &&
              isNonNegNumber(m.duration),
          ),
      );
    if (!ok) ctx.fail('INVALID_INPUT', EXIT.USAGE, { message: `invalid task record: ${JSON.stringify(t)}` });
    taskIds.add(t.id);
  }

  const plan = planWave({ tasks, shuttles, budget: wave.budget, reuseHints });
  if (!plan) {
    const mc = minimalCut(tasks, shuttles, wave.budget);
    ctx.fail('BUDGET_INSUFFICIENT', EXIT.BUDGET, {
      wave: wave.id,
      budget: wave.budget,
      demand: mc.demand,
      deficit: mc.deficit,
      cut: mc.cut,
      removedEnergy: mc.removedEnergy,
    });
  }

  ctx.emit({ type: 'wave', id: wave.id, budget: wave.budget });
  ctx.emit({ type: 'plan', wave: wave.id, tasks: plan.assignments.length, makespan: plan.makespan, energy: plan.energy });
  for (const a of plan.assignments) {
    ctx.emit({ type: 'task', id: a.task, wave: wave.id, shuttle: a.shuttle, route: a.route });
    const route = tasks.find((t) => t.id === a.task).routes[a.route];
    route.moves.forEach((m, i) => {
      ctx.emit({
        type: 'move',
        id: `${wave.id}/${a.task}/${i}`,
        task: a.task,
        wave: wave.id,
        shuttle: a.shuttle,
        lane: m.lane,
        from: m.from,
        to: m.to,
        energy: m.energy,
        duration: m.duration,
        status: 'planned',
      });
    });
  }
}

function cmdRollback(records, id, ctx) {
  const journal = loadJournal(records);
  let entries;
  try {
    entries = rollback(journal, id);
  } catch (err) {
    if (err instanceof RollbackError) {
      if (err.code === 'LEVEL_SKIP') ctx.fail('LEVEL_SKIP', EXIT.LEVEL, { id: err.id, message: err.message });
      ctx.fail(err.code, EXIT.USAGE, { id: err.id, message: err.message });
    }
    throw err;
  }
  for (const e of entries) ctx.emit(e);
}

function cmdVerify(records, ctx) {
  const lanes = records.filter((r) => r.type === 'lane');
  const events = records.filter((r) => r.type === 'event');
  for (const e of events) {
    const ok =
      typeof e.id === 'string' &&
      typeof e.shuttle === 'string' &&
      (e.op === 'enter' || e.op === 'exit') &&
      typeof e.lane === 'string' &&
      (e.after === undefined || Array.isArray(e.after));
    if (!ok) ctx.fail('INVALID_INPUT', EXIT.USAGE, { message: `invalid event record: ${JSON.stringify(e)}` });
  }
  const decisions = verifyEvents({ lanes, events });
  for (const d of decisions) ctx.emit(d);
  ctx.emit({
    type: 'summary',
    admitted: decisions.filter((d) => d.verdict === 'admitted').length,
    pending: decisions.filter((d) => d.verdict === 'pending').length,
  });
}

// Pure entry point: argv (without node/script) plus stdin text (used when no
// file argument is given). Returns { exitCode, records, stderr }.
export function runCli(argv, inputText = '') {
  const records = [];
  const stderrChunks = [];
  const ctx = {
    emit: (rec) => records.push(rec),
    fail: (code, exitCode, extra = {}) => {
      records.push({ type: 'error', code, ...extra });
      throw new CliExit(exitCode);
    },
  };

  const readRecords = (file) => {
    const text = file && file !== '-' ? readFileSync(file, 'utf8') : inputText;
    try {
      return parseJsonl(text);
    } catch (err) {
      if (err instanceof JsonlError) {
        ctx.fail('INVALID_JSONL', EXIT.USAGE, { line: err.line, message: err.message });
      }
      throw err;
    }
  };

  try {
    const [cmd, ...args] = argv;
    if (cmd === 'wave') {
      cmdWave(readRecords(args[0]), ctx);
    } else if (cmd === 'rollback') {
      const id = args[0];
      if (!id) ctx.fail('USAGE', EXIT.USAGE, { message: 'rollback requires a target id' });
      cmdRollback(readRecords(args[1]), id, ctx);
    } else if (cmd === 'verify') {
      cmdVerify(readRecords(args[0]), ctx);
    } else {
      stderrChunks.push('usage: node src/cli.js <wave|rollback <id>|verify> [file]\n');
      throw new CliExit(EXIT.USAGE);
    }
    return { exitCode: EXIT.OK, records, stderr: stderrChunks.join('') };
  } catch (err) {
    if (err instanceof CliExit) return { exitCode: err.exitCode, records, stderr: stderrChunks.join('') };
    throw err;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const fileArg = cmd === 'rollback' ? argv[2] : argv[1];
  const inputText = !fileArg || fileArg === '-' ? await readStdin() : '';
  const { exitCode, records, stderr } = runCli(argv, inputText);
  for (const rec of records) process.stdout.write(JSON.stringify(rec) + '\n');
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}
