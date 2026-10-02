#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { generateRun, serializeRun } from './fuzz.js';
import { replayRun } from './replay.js';

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[arg.slice(2)] = argv[++i];
      else flags[arg.slice(2)] = 'true';
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function required(flags, name) {
  if (flags[name] === undefined) fail('INVALID_INPUT', `missing required flag --${name}`);
  return flags[name];
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'fuzz') {
      const { flags } = parseFlags(rest);
      const run = generateRun({
        seed: required(flags, 'seed'),
        steps: required(flags, 'steps'),
        accounts: required(flags, 'accounts'),
      });
      writeFileSync(required(flags, 'out'), serializeRun(run));
      const rejected = run.ops.filter((o) => o.result.status === 'rejected').length;
      process.stdout.write(
        JSON.stringify({
          seed: run.seed,
          steps: run.steps,
          accounts: run.accounts,
          ops: run.ops.length,
          rejected,
          randomSamples: run.randomSamples.length,
          stateHash: run.stateHash,
        }) + '\n',
      );
    } else if (cmd === 'replay') {
      const { positional } = parseFlags(rest);
      const file = positional[0];
      if (!file) fail('INVALID_INPUT', 'replay requires a run file path');
      let data;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        fail('INVALID_INPUT', `cannot read/parse run file ${file}: ${e.message}`);
      }
      const result = replayRun(data);
      if (!result.ok) {
        process.stderr.write(
          JSON.stringify({ error: 'REPLAY_MISMATCH', checks: result.checks }) + '\n',
        );
        process.exit(1);
      }
      process.stdout.write(
        JSON.stringify({ ok: true, checks: result.checks, stateHash: result.expectedStateHash }) +
          '\n',
      );
    } else {
      fail('INVALID_INPUT', `unknown command: ${cmd ?? '(none)'} (expected "fuzz" or "replay")`);
    }
  } catch (e) {
    if (e.code === 'INVALID_INPUT') fail('INVALID_INPUT', e.message);
    throw e;
  }
}

main();
