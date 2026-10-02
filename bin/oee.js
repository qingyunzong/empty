#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { analyze } from '../src/analyze.js';
import { minimizeMisjudgment } from '../src/counterexample.js';
import { OeeError } from '../src/errors.js';

function readJson(path) {
  return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    params: { type: 'string' },
    inject: { type: 'string' },
    seed: { type: 'string', default: '1' },
    at: { type: 'string' },
  },
});

const [cmd, file] = positionals;

try {
  if (cmd === 'analyze') {
    const events = readJson(file);
    const params = values.params ? readJson(values.params) : {};
    const options = values.inject
      ? { injection: { spec: readJson(values.inject), seed: Number(values.seed) } }
      : {};
    process.stdout.write(`${JSON.stringify(analyze(events, params, options), null, 2)}\n`);
  } else if (cmd === 'counterexample') {
    if (values.at === undefined) throw new OeeError('ERR_SCHEMA', '--at <epoch-ms> is required');
    const events = readJson(file);
    const params = values.params ? readJson(values.params) : {};
    process.stdout.write(
      `${JSON.stringify(minimizeMisjudgment(events, Number(values.at), params), null, 2)}\n`,
    );
  } else {
    throw new OeeError(
      'ERR_SCHEMA',
      'usage: oee <analyze|counterexample> <events.json|-> [--params p.json] [--inject spec.json --seed N] [--at ms]',
    );
  }
} catch (err) {
  const payload = err instanceof OeeError ? err.toJSON() : { code: 'ERR_SCHEMA', message: String(err?.message ?? err) };
  process.stdout.write(`${JSON.stringify({ error: payload }, null, 2)}\n`);
  process.exitCode = 1;
}
