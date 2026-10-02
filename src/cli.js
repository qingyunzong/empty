#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { DqError, NO_FEASIBLE, BAD_INPUT } from './errors.js';
import { checkData } from './rules.js';
import { optimalRepair, enumeratePlans } from './solver.js';
import { genesis, applyRepair, mergeVersions, isVersion } from './version.js';
import { explain } from './explain.js';

const USAGE = `dq - data quality rules over versioned datasets

Usage:
  dq check   --data dataset.json --rules rules.json
  dq repair  --data datasetOrVersion.json --rules rules.json --budget N --node NAME [--max-nodes K]
  dq plan    --data datasetOrVersion.json --rules rules.json --budget N [--limit N] [--max-nodes K]
  dq merge   --left versionA.json --right versionB.json
  dq explain --version version.json

Dataset:  { "data": {var: int}, "domains": {var: [lo, hi]}, "costs": {var: unitCost} }
Rules:    [ { "id", "type": range|leq|eq|sumLeq|sumEq, ..., "dependsOn": [id] } ]
Version:  output of repair/merge (carries vector clock + causal history).
All output is JSON on stdout; errors are JSON on stderr with exit code 1.
Error codes: RULE_CYCLE, NO_FEASIBLE, HISTORY_CONFLICT, SEARCH_LIMIT, BAD_INPUT.`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new DqError(BAD_INPUT, `unexpected argument: ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

function readJson(path, what) {
  if (!path) throw new DqError(BAD_INPUT, `missing --${what}`);
  try {
    return JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
  } catch (e) {
    throw new DqError(BAD_INPUT, `cannot read ${what} from ${path}: ${e.message}`);
  }
}

function toInt(v, name, dflt) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new DqError(BAD_INPUT, `--${name} must be a non-negative integer`);
  return n;
}

// Accept either a bare dataset or a full version; returns { base, costs }.
function asBaseVersion(input) {
  if (isVersion(input)) return { base: input, costs: input.costs || {} };
  if (!input.data || !input.domains) {
    throw new DqError(BAD_INPUT, 'dataset must have "data" and "domains"');
  }
  return { base: genesis(input.data, input.domains), costs: input.costs || {} };
}

function cmdCheck(args) {
  const dataset = readJson(args.data, 'data');
  const rules = readJson(args.rules, 'rules');
  const data = isVersion(dataset) ? dataset.data : dataset.data;
  const { order, violations } = checkData(rules, data);
  return { ok: violations.length === 0, violations, order };
}

function cmdRepair(args) {
  const { base, costs } = asBaseVersion(readJson(args.data, 'data'));
  const rules = readJson(args.rules, 'rules');
  const budget = toInt(args.budget, 'budget', null);
  const node = args.node || 'repair';
  const maxNodes = toInt(args['max-nodes'], 'max-nodes', Infinity);
  const result = optimalRepair({ data: base.data, domains: base.domains, costs, rules, budget, maxNodes });
  if (!result.feasible) {
    throw new DqError(NO_FEASIBLE,
      `exhaustively verified: no assignment satisfies all rules with cost <= ${budget === null ? 'infinity' : budget}`,
      { budget, nodes: result.nodes });
  }
  const version = applyRepair(base, result.assignment, result.cost, node);
  return { feasible: true, cost: result.cost, assignment: result.assignment, nodes: result.nodes, version };
}

function cmdPlan(args) {
  const { base, costs } = asBaseVersion(readJson(args.data, 'data'));
  const rules = readJson(args.rules, 'rules');
  const budget = toInt(args.budget, 'budget', null);
  const limit = toInt(args.limit, 'limit', 10);
  const maxNodes = toInt(args['max-nodes'], 'max-nodes', 1_000_000);
  return enumeratePlans({ data: base.data, domains: base.domains, costs, rules, budget, limit, maxNodes });
}

function cmdMerge(args) {
  const left = readJson(args.left, 'left');
  const right = readJson(args.right, 'right');
  const version = mergeVersions(left, right);
  return { version };
}

function cmdExplain(args) {
  const version = readJson(args.version, 'version');
  return explain(version);
}

const commands = { check: cmdCheck, repair: cmdRepair, plan: cmdPlan, merge: cmdMerge, explain: cmdExplain };

// Programmatic entry: execute(['check', '--data', ...]) -> output object.
// Throws DqError on failure. Used by the bin wrapper and by tests.
export function execute(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { usage: USAGE };
  const fn = commands[cmd];
  if (!fn) throw new DqError(BAD_INPUT, `unknown command: ${cmd}`);
  return fn(parseArgs(rest));
}

function main() {
  const out = execute(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

const invokedAsScript = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedAsScript) {
  try {
    main();
  } catch (e) {
    if (e instanceof DqError) {
      const err = { error: { code: e.code, message: e.message } };
      if (e.details !== undefined) err.error.details = e.details;
      process.stderr.write(JSON.stringify(err, null, 2) + '\n');
      process.exit(1);
    }
    throw e;
  }
}
