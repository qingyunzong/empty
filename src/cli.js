#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { plan, verifyCertificate, ERR_WINDOW, ERR_LOCK } from './planner.js';

const USAGE = `usage: node src/cli.js [input.json] [--require-all] [--all] [--node-limit N] [--lock order:tech:start ...]
  reads instance JSON from file or stdin, writes result JSON to stdout`;

// Pure-ish entry: takes argv (without node/script) and optional stdin text,
// returns { code, output }. Throws only on unexpected bugs.
export function runCli(argv, stdinText = null) {
  let inputFile = null;
  let requireAll = false;
  let showAll = false;
  let nodeLimit;
  const locks = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--require-all') requireAll = true;
    else if (a === '--all') showAll = true;
    else if (a === '--node-limit') nodeLimit = Number(argv[++i]);
    else if (a === '--lock') {
      const [order, tech, start] = argv[++i].split(':');
      locks.push({ order, tech, start: Number(start) });
    } else if (a.startsWith('--')) return { code: 64, output: USAGE };
    else inputFile = a;
  }

  let instance;
  try {
    const text = inputFile ? readFileSync(inputFile, 'utf8') : stdinText;
    instance = JSON.parse(text);
  } catch (err) {
    return { code: 2, output: JSON.stringify({ status: 'ERROR', error: 'ERR_INPUT', message: err.message }) };
  }

  try {
    const result = plan(instance, {
      requireAll,
      locks: locks.length ? locks : undefined,
      nodeLimit: Number.isFinite(nodeLimit) ? nodeLimit : undefined,
    });

    const out = {
      status: result.status,
      objective: result.objective,
      optimalCount: result.optimalCount,
      assignments: result.assignments,
    };
    if (result.truncated) out.truncated = true;
    if (showAll) out.solutions = result.solutions;
    if (result.error) out.error = result.error;
    if (result.certificate) {
      out.certificate = result.certificate;
      out.certificateHash = result.certificateHash;
      out.certificateValid = verifyCertificate(instance, result.certificate).valid;
    }
    const code = out.status === 'INFEASIBLE' || out.status === ERR_LOCK ? 1 : 0;
    return { code, output: JSON.stringify(out, null, 2) };
  } catch (err) {
    if (err.code === ERR_WINDOW) {
      return {
        code: 2,
        output: JSON.stringify({ status: 'ERROR', error: ERR_WINDOW, order: err.order, message: err.message }),
      };
    }
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const hasFileArg = process.argv.slice(2).some((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !a.includes(':'));
  const stdinText = hasFileArg ? null : readFileSync(0, 'utf8');
  const { code, output } = runCli(process.argv.slice(2), stdinText);
  console.log(output);
  process.exit(code);
}
