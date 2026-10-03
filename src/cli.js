#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Lab } from './lab.js';

function main() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: { code: 'E_PARSE', message: String(err) } }) + '\n');
    process.exit(1);
  }
  const ops = Array.isArray(spec) ? spec : spec.ops ?? [];
  const lab = new Lab();
  if (!Array.isArray(spec) && spec.now !== undefined) {
    lab.apply({ op: 'setNow', now: spec.now });
  }
  const results = [];
  for (const op of ops) {
    if (op && op.op === 'undo') results.push(lab.undo());
    else if (op && op.op === 'redo') results.push(lab.redo());
    else if (op && op.op === 'evaluate') results.push({ ok: true, evaluation: lab.evaluate() });
    else results.push(lab.apply(op));
  }
  const final = lab.evaluate();
  process.stdout.write(JSON.stringify({ results, final }, null, 2) + '\n');
  process.exit(final.error ? 2 : 0);
}

main();
