#!/usr/bin/env node
'use strict';

// Usage:
//   node cli.js <instance.json|-> [options]
//
// Options:
//   --require-all          every order must be completed, else UNSAT + certificate
//   --enumerate            enumerate all tied optima (lexicographic)
//   --max-optima <n>       cap enumerated optima (default 1024)
//   --node-limit <n>       search node budget; exceeding it yields UNKNOWN
//   --lock O:T[:start]     lock an assignment (repeatable); re-solve incrementally
//   --verify               re-verify an emitted UNSAT certificate
//
// Output: single JSON document on stdout. Validation errors (e.g. ERR_WINDOW)
// are reported as { "error": { "code", ... } } with exit code 1.

const { readFileSync } = require('node:fs');
const { PlannerError } = require('./src/planner');
const { solveWithCertificate, verifyCertificate } = require('./src/certificate');

function parseArgs(argv) {
  const opts = { locks: {}, enumerate: false, requireAll: false, verify: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--require-all') opts.requireAll = true;
    else if (arg === '--enumerate') opts.enumerate = true;
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--max-optima') opts.maxOptima = parseInt(argv[(i += 1)], 10);
    else if (arg === '--node-limit') opts.nodeLimit = parseInt(argv[(i += 1)], 10);
    else if (arg === '--lock') {
      const [order, tech, start] = argv[(i += 1)].split(':');
      opts.locks[order] = start === undefined ? { tech } : { tech, start: parseInt(start, 10) };
    } else if (arg.startsWith('--')) {
      throw new PlannerError('ERR_INPUT', `unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  opts.input = positional[0] || '-';
  if (Object.keys(opts.locks).length === 0) delete opts.locks;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = opts.input === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.input, 'utf8');

  let instance;
  try {
    instance = JSON.parse(raw);
  } catch (err) {
    throw new PlannerError('ERR_INPUT', `instance is not valid JSON: ${err.message}`);
  }

  const result = solveWithCertificate(instance, {
    requireAll: opts.requireAll,
    enumerate: opts.enumerate,
    maxOptima: opts.maxOptima,
    nodeLimit: opts.nodeLimit,
    locks: opts.locks,
  });

  const out = {
    status: result.status,
    objective: result.objective,
    assignments: result.assignments,
    nodes: result.nodes,
  };
  if (opts.enumerate) {
    out.optimaCount = result.optimaCount;
    out.truncated = result.truncated;
    out.optima = result.optima;
  }
  if (result.certificate) {
    out.certificate = result.certificate;
    out.certificateHash = result.certificate.hash;
    if (opts.verify) {
      out.certificateVerification = verifyCertificate(instance, result.certificate);
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof PlannerError) {
    process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message, details: err.details || null } }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  throw err;
}
