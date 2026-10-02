#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateInstance, SchemaError } from './src/validate.js';
import { solveCanonical, buildUnsatCertificate, buildSchedule } from './src/solver.js';

const USAGE = 'usage: node cli.js <input.json> [--max-states N] [--max-solutions N]';

/**
 * Run the CLI. Returns the process exit code:
 *   0  success (status may be FEASIBLE / UNSAT / UNKNOWN — see stdout JSON)
 *   2  schema/parse error (ERR_SCHEMA printed to stderr)
 *   64 usage error
 */
export function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const inputPath = argv.find((a) => !a.startsWith('--'));
  if (!inputPath) {
    io.err(USAGE);
    return 64;
  }
  const numOpt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : undefined;
  };

  let raw;
  try {
    raw = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (e) {
    io.err(`ERR_SCHEMA: cannot read/parse input: ${e.message}`);
    return 2;
  }

  let instance;
  try {
    instance = validateInstance(raw);
  } catch (e) {
    if (e instanceof SchemaError) {
      io.err(`ERR_SCHEMA: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const result = solveCanonical(instance, {
    maxStates: numOpt('--max-states'),
    maxSolutions: numOpt('--max-solutions'),
  });

  const out = { status: result.status };
  if (result.status === 'FEASIBLE') {
    out.objective = result.objective;
    out.schedule = buildSchedule(instance, result.solutions[0]);
    out.tiedOptima = result.solutions.length;
    out.truncated = result.truncated;
    out.solutions = result.solutions;
  } else if (result.status === 'UNSAT') {
    out.certificate = buildUnsatCertificate(instance, result);
  } else {
    out.reason = result.reason; // UNKNOWN is reported as-is, never as UNSAT
  }
  out.enumerationHash = result.enumerationHash ?? null;
  out.stats = result.stats;
  io.out(JSON.stringify(out, null, 2));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
