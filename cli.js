#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generatePool } from './src/generate.js';
import { analyzePool } from './src/enumerate.js';
import { ModelError } from './src/model.js';
import { stateHash } from './src/hash.js';

export function buildReport(pool) {
  const analysis = analyzePool(pool);
  const summary = {
    seed: pool.seed ?? null,
    accounts: pool.accounts.length,
    tasks: pool.tasks.length,
    prng: pool.prng ?? null,
    legalSchedules: analysis.legalSchedules.toString(),
    statesExplored: analysis.statesExplored,
    verdict: analysis.verdict,
    violation: analysis.violation,
    maxLoad: analysis.maxLoad,
    maxLoadAccount: analysis.maxLoadAccount,
  };
  const hash = stateHash({ pool, summary });
  return { pool, analysis, summary, stateHash: hash };
}

function formatPool(pool) {
  const lines = [];
  for (const account of pool.accounts) {
    lines.push(`  account ${account.id} limit=${account.limit}`);
  }
  for (const task of pool.tasks) {
    const detail =
      task.kind === 'freeze' || task.kind === 'debit'
        ? `amount=${task.amount}`
        : `target=${task.target}`;
    lines.push(`  task ${task.id} account=${task.account} kind=${task.kind} ${detail}`);
  }
  return lines;
}

export function formatReport(report, note) {
  const { pool, summary, stateHash: hash } = report;
  const lines = [];
  lines.push(`seed: ${summary.seed}`);
  if (summary.prng) lines.push(`prng: ${summary.prng.algorithm} seed=${summary.prng.seed} draws=${summary.prng.draws}`);
  lines.push(`accounts: ${summary.accounts}`);
  lines.push(`tasks: ${summary.tasks}`);
  lines.push('pool:');
  lines.push(...formatPool(pool));
  lines.push(`legalSchedules: ${summary.legalSchedules}`);
  lines.push(`statesExplored: ${summary.statesExplored}`);
  lines.push(`verdict: ${summary.verdict}`);
  if (summary.verdict === 'SAFE') {
    lines.push(
      `certificate: all ${summary.legalSchedules} legal schedules keep used+frozen<=limit ` +
        `across ${summary.statesExplored} explored states`,
    );
    lines.push('violation: none');
  } else {
    const v = summary.violation;
    lines.push(`violation: ${v.steps.join(' -> ')}`);
    lines.push(
      `violationState: account=${v.account} used=${v.used} frozen=${v.frozen} limit=${v.limit}`,
    );
  }
  lines.push(`maxLoad: ${summary.maxLoad} (account ${summary.maxLoadAccount})`);
  lines.push(`stateHash: ${hash}`);
  if (note) lines.push(note);
  return lines.join('\n');
}

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function parseCommon(args) {
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: 'string' },
      accounts: { type: 'string' },
      tasks: { type: 'string' },
      json: { type: 'boolean', default: false },
      'expect-hash': { type: 'string' },
      pool: { type: 'string' },
    },
    strict: true,
  });
  return values;
}

function requireInt(values, name) {
  if (values[name] === undefined) throw new ModelError(`missing required option --${name}`);
  const n = Number(values[name]);
  if (!Number.isInteger(n)) throw new ModelError(`--${name} must be an integer, got ${values[name]}`);
  return n;
}

function printReport(io, report, asJson, note) {
  if (asJson) {
    io.out(
      `${JSON.stringify({ summary: report.summary, stateHash: report.stateHash, pool: report.pool, replay: note ?? null }, jsonReplacer, 2)}\n`,
    );
  } else {
    io.out(`${formatReport(report, note)}\n`);
  }
}

function cmdModel(io, args) {
  const values = parseCommon(args);
  const pool = generatePool({
    seed: requireInt(values, 'seed'),
    accounts: requireInt(values, 'accounts'),
    tasks: requireInt(values, 'tasks'),
  });
  const report = buildReport(pool);
  printReport(io, report, values.json);
  return 0;
}

function cmdReplay(io, args) {
  const values = parseCommon(args);
  const pool = generatePool({
    seed: requireInt(values, 'seed'),
    accounts: requireInt(values, 'accounts'),
    tasks: requireInt(values, 'tasks'),
  });
  const report = buildReport(pool);
  let note;
  if (values['expect-hash'] !== undefined) {
    if (values['expect-hash'] !== report.stateHash) {
      io.err(
        `REPLAY_MISMATCH: expected ${values['expect-hash']} but reconstructed ${report.stateHash}\n`,
      );
      return 1;
    }
    note = 'replay: OK reconstructed stateHash matches --expect-hash';
  } else {
    note = 'replay: OK task pool and search results reconstructed deterministically';
  }
  printReport(io, report, values.json, note);
  return 0;
}

function cmdCheck(io, args) {
  const values = parseCommon(args);
  if (values.pool === undefined) throw new ModelError('missing required option --pool <file>');
  let pool;
  try {
    pool = JSON.parse(readFileSync(values.pool, 'utf8'));
  } catch (err) {
    throw new ModelError(`cannot read pool file ${values.pool}: ${err.message}`);
  }
  const report = buildReport(pool);
  printReport(io, report, values.json);
  return 0;
}

const USAGE = `usage:
  node cli.js model  --seed <n> --accounts <n> --tasks <n> [--json]
  node cli.js replay --seed <n> --accounts <n> --tasks <n> [--expect-hash <hex>] [--json]
  node cli.js check  --pool <file.json> [--json]
`;

// Runs the CLI. io = { out, err } collects output; returns the exit code.
export function runCli(argv, io) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'model':
        return cmdModel(io, rest);
      case 'replay':
        return cmdReplay(io, rest);
      case 'check':
        return cmdCheck(io, rest);
      default:
        io.err(USAGE);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (err) {
    if (err instanceof ModelError || err?.code === 'INVALID_MODEL') {
      io.err(`INVALID_MODEL: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  const code = runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}
