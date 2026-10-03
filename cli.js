#!/usr/bin/env node
// CLI for the quota freeze model verifier.
//
//   node cli.js model  --seed 7 --accounts 3 --tasks 8
//   node cli.js replay --seed 7 --accounts 3 --tasks 8
//
// `model`  generates the task pool, enumerates every legal schedule and prints
//          the seed, pool, safety verdict, shortest violating sequence (if
//          any) and the state hash.
// `replay` rebuilds the same pool and search result from the same arguments
//          and verifies that both are identical.

import { generatePool } from './src/generate.js';
import { Model } from './src/model.js';
import { enumerateSchedules } from './src/enumerate.js';
import { buildReport } from './src/report.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const USAGE = 'usage: node cli.js <model|replay> --seed N --accounts N --tasks N';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      opts[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function toInt(value, name, min) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`invalid --${name}: ${value}`);
  }
  return n;
}

function runOnce(params) {
  const pool = generatePool(params);
  const model = new Model(pool.accounts, pool.tasks);
  const stats = enumerateSchedules(model);
  return buildReport(pool, stats);
}

export function formatReport(report) {
  const { pool } = report;
  const lines = [];
  lines.push(`seed: ${report.seed}`);
  lines.push(`accounts: ${pool.accounts.length}`);
  lines.push(`tasks: ${pool.tasks.length}`);
  lines.push(`prng: seed=${pool.prng.seed} draws=${pool.prng.index}`);
  lines.push('pool:');
  for (const account of pool.accounts) {
    lines.push(`  ${account.id} limit=${account.limit}`);
  }
  for (const task of pool.tasks) {
    const target = task.target ? ` target=${task.target}` : '';
    lines.push(
      `  ${task.id} ${task.kind} account=${pool.accounts[task.account].id} amount=${task.amount}${target} draw=${task.draw}`,
    );
  }
  lines.push(`safety: ${report.safe ? 'SAFE' : 'VIOLATION'}`);
  lines.push(`violation: ${report.violation ? report.violation.join(' ') : 'none'}`);
  if (report.certificate) {
    const c = report.certificate;
    lines.push(
      `certificate: schedules=${c.schedules} states=${c.states} transitions=${c.transitions} invariantChecks=${c.invariantChecks} invariant="${c.invariant}"`,
    );
  }
  lines.push(`state-hash: ${report.stateHash}`);
  return lines;
}

export function runCli(argv) {
  const [command, ...rest] = argv;
  if (command !== 'model' && command !== 'replay') {
    return { lines: [], error: USAGE, exitCode: 2 };
  }
  let params;
  try {
    const opts = parseArgs(rest);
    params = {
      seed: toInt(opts.seed, 'seed', 0),
      accounts: toInt(opts.accounts, 'accounts', 1),
      tasks: toInt(opts.tasks, 'tasks', 1),
    };
  } catch (err) {
    return { lines: [], error: err.message, exitCode: 2 };
  }
  const report = runOnce(params);
  const lines = formatReport(report);
  if (command === 'replay') {
    const again = runOnce(params);
    const consistent =
      again.stateHash === report.stateHash &&
      JSON.stringify(again.pool) === JSON.stringify(report.pool);
    lines.push(`replay: ${consistent ? 'consistent' : 'MISMATCH'}`);
    return { lines, error: null, exitCode: consistent && report.safe ? 0 : 1 };
  }
  return { lines, error: null, exitCode: report.safe ? 0 : 1 };
}

const invokedAs = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedAs) {
  const { lines, error, exitCode } = runCli(process.argv.slice(2));
  if (error) console.error(error);
  if (lines.length > 0) console.log(lines.join('\n'));
  process.exit(exitCode);
}
