#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { AlarmEngine } from './engine.js';
import { AlarmError, serializeError } from './errors.js';

const USAGE = 'usage: node src/cli.js alarms <events.json> <rules.json> [-o <out.json>]';

function fatal(error, code) {
  const payload = { ok: false, error: serializeError(error) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new AlarmError('READ_FAILED', `cannot read ${what} file "${path}"`, { path });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AlarmError('BAD_JSON', `${what} file "${path}" is not valid JSON: ${cause.message}`, { path });
  }
}

function normalizeOps(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.ops) ? raw.ops : null;
  if (!list) {
    throw new AlarmError('BAD_INPUT', 'events file must be a JSON array of commands (or {"ops": [...]})', null);
  }
  return list.map((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) && 'op' in entry
      ? entry
      : { op: 'append', event: entry },
  );
}

function normalizeRules(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.rules) ? raw.rules : null;
  if (!list) {
    throw new AlarmError('BAD_INPUT', 'rules file must be a JSON array of rules (or {"rules": [...]})', null);
  }
  return list;
}

function parseArgs(argv) {
  const positionals = [];
  let outPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--output') {
      if (i + 1 >= argv.length) {
        throw new AlarmError('USAGE', `missing value for ${arg}\n${USAGE}`, null);
      }
      outPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new AlarmError('USAGE', `unknown option "${arg}"\n${USAGE}`, null);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 3 || positionals[0] !== 'alarms') {
    throw new AlarmError('USAGE', USAGE, null);
  }
  return { eventsPath: positionals[1], rulesPath: positionals[2], outPath };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fatal(error, 2);
  }

  let ops;
  let rules;
  try {
    ops = normalizeOps(readJson(args.eventsPath, 'events'));
    rules = normalizeRules(readJson(args.rulesPath, 'rules'));
  } catch (error) {
    fatal(error, 1);
  }

  const engine = new AlarmEngine();
  try {
    engine.loadRules(rules);
  } catch (error) {
    fatal(error, 1);
  }

  const steps = [];
  let ok = true;
  ops.forEach((raw, index) => {
    try {
      const result = engine.applyOp(raw);
      steps.push({ index, op: result.op, ok: true, added: result.added, removed: result.removed });
    } catch (error) {
      ok = false;
      const opName = raw && typeof raw === 'object' && 'op' in raw ? raw.op : 'append';
      steps.push({ index, op: opName, ok: false, error: serializeError(error) });
    }
  });

  const out = { ok, steps, alarms: engine.snapshot() };
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (args.outPath) {
    writeFileSync(args.outPath, text);
    process.stdout.write(
      `wrote ${args.outPath}: ${out.alarms.length} alarm(s) active after ${steps.length} command(s)\n`,
    );
  } else {
    process.stdout.write(text);
  }
}

main(process.argv.slice(2));
