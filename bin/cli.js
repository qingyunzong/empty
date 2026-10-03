#!/usr/bin/env node
import { writeFileSync, renameSync } from 'node:fs';
import { Engine, validateOp } from '../src/engine.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && i + 1 < args.length) {
      outPath = args[i + 1];
      i += 1;
    } else {
      return { code: 1, stderr: `unknown argument: ${args[i]}` };
    }
  }

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return { code: 1, stderr: 'stdin is not valid JSON' };
  }

  const envelope = Array.isArray(input) ? { ops: input } : input;
  if (envelope === null || typeof envelope !== 'object') {
    return { code: 1, stderr: 'input must be an op array or { "initialBalance": n, "ops": [...] }' };
  }
  const initialBalance = envelope.initialBalance ?? 0;
  const ops = envelope.ops;
  if (!Number.isInteger(initialBalance) || initialBalance < 0) {
    return { code: 1, stderr: 'initialBalance must be a non-negative integer' };
  }
  if (!Array.isArray(ops)) return { code: 1, stderr: 'ops must be an array' };
  for (const op of ops) {
    const problem = validateOp(op);
    if (problem) return { code: 1, stderr: `invalid op ${JSON.stringify(op)}: ${problem}` };
  }

  const engine = new Engine({ initialBalance });
  const results = ops.map((op) => ({ clientOpId: op.clientOpId, ...engine.submit(op) }));
  const payload = JSON.stringify(
    { ok: true, view: engine.view(), results, log: engine.log, tipHash: engine.tipHash },
    null,
    2,
  );

  if (outPath) {
    const tmp = `${outPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, payload);
      renameSync(tmp, outPath);
    } catch (cause) {
      return { code: 1, stderr: `cannot write ${outPath}: ${cause.message}` };
    }
    return { code: 0 };
  }
  return { code: 0, stdout: payload };
}

const outcome = await main();
if (outcome.stderr) process.stderr.write(`${JSON.stringify({ ok: false, error: outcome.stderr })}\n`);
if (outcome.stdout) process.stdout.write(`${outcome.stdout}\n`);
process.exitCode = outcome.code;
