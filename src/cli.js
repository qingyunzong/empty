#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { normalizePlan, PlanError } from './plan.js';
import { explore } from './explore.js';

const INVALID_PLAN = JSON.stringify({ error: 'INVALID_PLAN' });

// Runs the CLI and returns the process exit code. Output sinks are
// injectable so tests can drive the CLI in-process.
export function run(argv, { stdout = console.log, stderr = console.error } = {}) {
  const [command, planPath, ...rest] = argv;
  if (command !== 'explore' || !planPath || rest.length > 0) {
    stderr('usage: node src/cli.js explore <plan.json>');
    return 2;
  }

  let raw;
  try {
    raw = readFileSync(planPath, 'utf8');
  } catch (error) {
    stderr(`cannot read plan file: ${error.message}`);
    stdout(INVALID_PLAN);
    return 1;
  }

  let plan;
  try {
    plan = normalizePlan(JSON.parse(raw));
  } catch (error) {
    if (error instanceof PlanError) {
      for (const detail of error.details) {
        stderr(`invalid plan: ${detail}`);
      }
    } else if (error instanceof SyntaxError) {
      stderr(`invalid JSON: ${error.message}`);
    } else {
      throw error;
    }
    stdout(INVALID_PLAN);
    return 1;
  }

  const result = explore(plan);
  stdout(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
