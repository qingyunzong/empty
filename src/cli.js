#!/usr/bin/env node
/**
 * furnace-plan CLI (offline, standard library only).
 *
 * Usage:
 *   node src/cli.js plan   <input.json>  [--state state.json]
 *   node src/cli.js replan <events.json> --state state.json
 *   node src/cli.js verify <input.json>
 *
 * plan:   build an initial plan from { config, orders, freezeBoundary? }.
 * replan: apply rolling events { now?, freezeHorizon?, add?, cancel?, prepare? }
 *         to the persisted state and print the new plan plus the incremental diff.
 * verify: for small instances (<= 5 orders) compare the greedy plan against an
 *         exhaustive enumeration of every batch partition and run ordering.
 *
 * Exit codes: 0 ok / 1 verify mismatch or usage error / 2 infeasible input.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Engine } from './engine.js';
import { enumerateOptimal } from './enumerate.js';
import { normalizeConfig, normalizeOrder, validateOrders } from './model.js';
import { greedySchedule } from './scheduler.js';

const USAGE =
  'usage: furnace-plan plan <input.json> [--state f] | ' +
  'replan <events.json> --state f | verify <input.json>';

/**
 * Programmatic entry point.
 * @param argv arguments after `node cli.js`
 * @param io { out, err, readFile, writeFile } injectable for tests
 * @returns exit code
 */
export function runCli(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const readFile = io.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const writeFile = io.writeFile ?? ((p, s) => writeFileSync(p, s));

  const readJson = (path) => JSON.parse(readFile(path));
  const [cmd, ...rest] = argv;
  const positional = [];
  let statePath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state') {
      statePath = rest[++i];
    } else {
      positional.push(rest[i]);
    }
  }

  try {
    if (cmd === 'plan' && positional.length === 1) {
      const engine = new Engine();
      const result = engine.plan(readJson(positional[0]));
      out(JSON.stringify(result, null, 2));
      if (!result.ok) return 2;
      if (statePath) writeFile(statePath, JSON.stringify(engine.state, null, 2));
      return 0;
    }

    if (cmd === 'replan' && positional.length === 1 && statePath) {
      const engine = Engine.fromState(readJson(statePath));
      const result = engine.replan(readJson(positional[0]));
      out(JSON.stringify(result, null, 2));
      if (!result.ok) return 2;
      writeFile(statePath, JSON.stringify(engine.state, null, 2));
      return 0;
    }

    if (cmd === 'verify' && positional.length === 1) {
      const input = readJson(positional[0]);
      const cfg = normalizeConfig(input.config);
      const orders = (input.orders ?? []).map((o) => normalizeOrder(o, 0));
      const errors = validateOrders(cfg, orders);
      if (errors.length > 0) {
        out(JSON.stringify({ ok: false, errors }, null, 2));
        return 2;
      }
      const greedy = greedySchedule(cfg, orders.map((o) => ({ ...o })), { now: 0 });
      const optimal = enumerateOptimal(cfg, orders);
      const greedyTotal = greedy.tardiness + greedy.cleaning;
      const report = {
        ok: greedyTotal === optimal.total,
        orders: orders.length,
        greedy: { total: greedyTotal, tardiness: greedy.tardiness, cleaning: greedy.cleaning },
        enumerated: {
          total: optimal.total,
          tardiness: optimal.tardiness,
          cleaning: optimal.cleaning,
          explored: optimal.explored,
        },
      };
      out(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
  } catch (error) {
    err(`error: ${error.message}`);
    return 1;
  }

  err(USAGE);
  return 1;
}

const invokedAsMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
