#!/usr/bin/env node
// CLI:
//   node src/cli.js run [--dir D] [--as-of YYYY-MM-DD]
//       [--instruments F] [--calibrations F] [--usage F]
//       [--status-out F] [--impact-out F]
//   node src/cli.js counterexample --work-order ID [--dir D] [--as-of ...]
// Exit codes: 25 invalid date, 26 untrusted institution, 27 restore self-reference.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toDays, fromDays, formatDate } from './dates.js';
import { InputError, parseInstruments, parseCalibrations, parseUsage, requireDate } from './load.js';
import { buildState, instrumentUsableAt, measurementStatus, workOrderStatus } from './engine.js';
import { findMinimalRevocations } from './counterexample.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._ = args._ ?? [];
      args._.push(a);
    }
  }
  return args;
}

function todayDays() {
  const now = new Date();
  return toDays({ y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() });
}

function loadInputs(args) {
  const dir = args.dir ?? '.';
  const read = (name, file) => readFileSync(file ?? path.join(dir, name), 'utf8');
  return {
    dir,
    model: parseInstruments(read('instruments.json', args.instruments)),
    events: parseCalibrations(read('calibrations.jsonl', args.calibrations)),
    usage: parseUsage(read('usage.jsonl', args.usage)),
  };
}

function resolveAsOf(args) {
  return args['as-of'] ? requireDate(args['as-of'], '--as-of') : todayDays();
}

function groupByWorkOrder(usage) {
  const byWO = new Map();
  for (const u of usage) {
    if (!byWO.has(u.work_order)) byWO.set(u.work_order, []);
    byWO.get(u.work_order).push(u);
  }
  return byWO;
}

function cmdRun(args) {
  const { dir, model, events, usage } = loadInputs(args);
  const asOf = resolveAsOf(args);
  const state = buildState(model, events, asOf);

  const instruments = [...model.instruments.values()].map((inst) => ({
    id: inst.id,
    type: inst.type,
    ...instrumentUsableAt(state, inst.id, asOf),
  }));

  const impactLines = [];
  const workOrders = [];
  for (const [wo, records] of groupByWorkOrder(usage)) {
    const statuses = records.map((r) => {
      const s = measurementStatus(state, r);
      impactLines.push(JSON.stringify({
        type: 'measurement',
        work_order: wo,
        measurement: r.measurement,
        instrument: r.instrument,
        date: r.dateText,
        ...s,
      }));
      return s;
    });
    workOrders.push({ id: wo, status: workOrderStatus(statuses) });
  }
  for (const w of workOrders) impactLines.push(JSON.stringify({ type: 'work_order', ...w }));

  const status = {
    as_of: formatDate(fromDays(asOf)),
    usable_instruments: instruments.filter((i) => i.usable).map((i) => i.id),
    instruments,
    work_orders: workOrders,
  };

  const statusOut = args['status-out'] ?? path.join(dir, 'status.json');
  const impactOut = args['impact-out'] ?? path.join(dir, 'impact.jsonl');
  writeFileSync(statusOut, JSON.stringify(status, null, 2) + '\n');
  writeFileSync(impactOut, impactLines.join('\n') + '\n');
  console.log(`wrote ${statusOut} and ${impactOut}`);
}

function cmdCounterexample(args) {
  if (!args['work-order']) throw new InputError(1, 'counterexample requires --work-order');
  const { model, events, usage } = loadInputs(args);
  const asOf = resolveAsOf(args);
  const state = buildState(model, events, asOf);
  const records = usage.filter((u) => u.work_order === args['work-order']);
  if (records.length === 0) {
    throw new InputError(1, `no usage records for work order ${args['work-order']}`);
  }
  const result = findMinimalRevocations(state, records);
  if (result === null) {
    console.error(`work order ${args['work-order']} is not currently ok; no counterexample exists`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    work_order: args['work-order'],
    as_of: formatDate(fromDays(asOf)),
    minimal_revocations: result.certs,
    size: result.size,
  }, null, 2));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'run') cmdRun(parseArgs(rest));
    else if (cmd === 'counterexample') cmdCounterexample(parseArgs(rest));
    else {
      console.error('usage: cli.js run [--dir D] [--as-of DATE] | cli.js counterexample --work-order ID');
      process.exit(2);
    }
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`error: ${e.message}`);
      process.exit(e.exitCode);
    }
    throw e;
  }
}

main();
