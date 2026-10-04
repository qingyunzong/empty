#!/usr/bin/env node
// CLI: wave | rollback | verify. JSONL in via stdin (or --file), JSONL out
// via stdout. Exit codes: 0 ok, 1 verify failed, 2 usage/parse error,
// 17 budget insufficient, 18 rollback level violation.

import { readFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { normalizeShuttle } from './model.js';
import { planWave, minimalReduction } from './planner.js';
import { parseJournal, applyRollback, JournalError } from './journal.js';
import { verifyJournal } from './verify.js';

export const EXIT = {
  OK: 0,
  VERIFY_FAILED: 1,
  USAGE: 2,
  BUDGET_INSUFFICIENT: 17,
  ROLLBACK_LEVEL_VIOLATION: 18,
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = value;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

function readLines(flags) {
  const raw = flags.file !== undefined ? readFileSync(String(flags.file), 'utf8') : readFileSync(0, 'utf8');
  const lines = [];
  const text = raw.split('\n');
  for (let i = 0; i < text.length; i++) {
    const trimmed = text[i].trim();
    if (trimmed === '') continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch (err) {
      emit({ type: 'error', code: 'PARSE_ERROR', line: i + 1, message: err.message });
      process.exit(EXIT.USAGE);
    }
  }
  return lines;
}

function emit(obj) {
  writeSync(1, JSON.stringify(obj) + '\n');
}

function fail(code, message, extra, exitCode) {
  emit({ type: 'error', code, message, ...extra });
  process.exit(exitCode);
}

function cmdWave(lines, flags) {
  const config = lines.find((l) => l.type === 'config') ?? {};
  const waveId = flags.wave !== undefined ? String(flags.wave) : (config.wave ?? 'W1');
  const budget = flags.budget !== undefined ? Number(flags.budget) : config.budget;
  if (!Number.isFinite(budget)) fail('USAGE', 'wave requires a budget (config line or --budget)', {}, EXIT.USAGE);
  const shuttlesRaw = config.shuttles;
  if (!Array.isArray(shuttlesRaw) || shuttlesRaw.length === 0) {
    fail('USAGE', 'wave requires config.shuttles', {}, EXIT.USAGE);
  }
  let shuttles;
  try {
    shuttles = shuttlesRaw.map(normalizeShuttle);
  } catch (err) {
    fail('USAGE', err.message, {}, EXIT.USAGE);
  }
  const tasks = lines.filter((l) => l.type === 'task').map((l) => ({ id: l.id, moves: l.moves ?? [] }));
  const reusable = lines.filter((l) => l.type === 'reusable' && l.move).map((l) => l.move);
  const candidateCap = flags.cap !== undefined ? Number(flags.cap) : undefined;

  let result;
  try {
    result = planWave({ waveId, tasks, shuttles, budget, reusable, ...(candidateCap !== undefined ? { candidateCap } : {}) });
  } catch (err) {
    fail('USAGE', err.message, {}, EXIT.USAGE);
  }

  if (!result.feasible) {
    const reduction = minimalReduction({ tasks, shuttles, budget, reusable });
    fail('BUDGET_INSUFFICIENT',
      `budget ${budget} cannot cover the wave; remove ${reduction.length} task(s) to proceed`,
      { budget, minimalReduction: reduction },
      EXIT.BUDGET_INSUFFICIENT);
  }

  emit({
    type: 'wave', id: waveId, status: 'planned', budget,
    makespan: result.makespan, energy: result.energy, exhaustive: result.exhaustive,
  });
  for (const a of result.assignments) emit({ type: 'assignment', ...a });
  for (const m of result.moves) emit({ type: 'move', ...m });
  process.exit(EXIT.OK);
}

function cmdRollback(lines, flags) {
  const state = parseJournal(lines);
  const request = flags.level !== undefined && flags.id !== undefined
    ? { level: String(flags.level), id: String(flags.id) }
    : state.rollbackRequests.at(-1);
  if (!request) fail('USAGE', 'rollback requires --level/--id or a rollback line', {}, EXIT.USAGE);
  let outcome;
  try {
    outcome = applyRollback(state, request);
  } catch (err) {
    if (err instanceof JournalError) {
      const exitCode = err.code === 'ROLLBACK_LEVEL_VIOLATION'
        ? EXIT.ROLLBACK_LEVEL_VIOLATION
        : EXIT.USAGE;
      fail(err.code, err.message, err.details, exitCode);
    }
    throw err;
  }
  // Append-only: echo the original journal, then the rollback records.
  for (const line of lines) emit(line);
  for (const line of outcome.lines) emit(line);
  process.exit(EXIT.OK);
}

function cmdVerify(lines) {
  const state = parseJournal(lines);
  const { ok, checks, releases } = verifyJournal(state);
  for (const check of checks) {
    emit({ type: 'check', name: check.name, ok: check.ok, violations: check.violations });
  }
  for (const rel of releases) {
    emit({ type: 'release', ...rel });
  }
  emit({ type: 'summary', ok, failed: checks.filter((c) => !c.ok).map((c) => c.name) });
  process.exit(ok ? EXIT.OK : EXIT.VERIFY_FAILED);
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!['wave', 'rollback', 'verify'].includes(command)) {
    process.stderr.write('usage: cli.js <wave|rollback|verify> [--file F] [--budget N] [--wave ID] [--level L --id X] [--cap N]\n');
    process.exit(EXIT.USAGE);
  }
  const lines = readLines(flags);
  if (command === 'wave') cmdWave(lines, flags);
  else if (command === 'rollback') cmdRollback(lines, flags);
  else cmdVerify(lines);
}

main();
