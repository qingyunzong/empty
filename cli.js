#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const model = require('./lib/model');
const store = require('./lib/store');

const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  INFEASIBLE: 70,
  PENDING: 71,
  EXECUTED_ROLLBACK: 72,
};

function fail(message, code) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    obligations: 'obligations.json',
    constraints: 'constraints.json',
    state: '.settlement',
    json: false,
  };
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      if (body === 'json') {
        opts.json = true;
        continue;
      }
      const eq = body.indexOf('=');
      const key = eq === -1 ? body : body.slice(0, eq);
      const value = eq === -1 ? undefined : body.slice(eq + 1);
      if (['obligations', 'constraints', 'state'].includes(key) && value !== undefined) {
        opts[key] = value;
      } else {
        fail(`unknown option --${key}`, EXIT.USAGE);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], opts };
}

function loadInputs(opts) {
  let obligationsDoc;
  let constraintsDoc;
  try {
    obligationsDoc = store.readJson(opts.obligations);
  } catch (err) {
    fail(`cannot read obligations file ${opts.obligations}: ${err.message}`, EXIT.USAGE);
  }
  try {
    constraintsDoc = store.readJson(opts.constraints);
  } catch (err) {
    fail(`cannot read constraints file ${opts.constraints}: ${err.message}`, EXIT.USAGE);
  }
  let obligations;
  let constraints;
  try {
    obligations = obligationsDoc.obligations;
    model.validateObligations(obligations);
    constraints = model.normalizeConstraints(constraintsDoc);
  } catch (err) {
    fail(`invalid input: ${err.message}`, EXIT.USAGE);
  }
  return { obligations, constraints };
}

function cmdOptimize(opts) {
  const { obligations, constraints } = loadInputs(opts);
  const pending = obligations.filter((o) => o.status === 'pending');
  if (pending.length > 0) {
    const ids = pending.map((o) => o.id).join(', ');
    fail(`${pending.length} pending obligation(s) treated as unsatisfiable: ${ids}`, EXIT.PENDING);
  }
  const paths = store.statePaths(opts.state);
  if (store.exists(paths.executed)) {
    fail('plan already executed; re-optimize refused', EXIT.GENERIC);
  }
  let result;
  try {
    result = model.optimize(obligations, constraints);
  } catch (err) {
    fail(err.message, EXIT.USAGE);
  }
  if (result.feasibleCount === 0) {
    fail('no feasible netting plan: freeze/daily budgets unsatisfiable for every netting set', EXIT.INFEASIBLE);
  }
  const record = {
    status: 'planned',
    obligationsHash: result.certificate.obligationsHash,
    constraintsHash: result.certificate.constraintsHash,
    selected: result.selected,
    tiedCount: result.tied.length,
    certificate: result.certificate,
    evaluations: result.evaluations,
  };
  store.writeAtomic(paths.plan, record);
  const out = {
    status: 'planned',
    stateFile: paths.plan,
    selected: result.selected.ids,
    cost: result.selected.cost,
    volume: result.selected.volume,
    freeze: result.selected.freeze,
    tiedCount: result.tied.length,
    candidateSetHash: result.certificate.candidateSetHash,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(EXIT.OK);
}

function emitPayload(record, marker, alreadyExecuted) {
  return {
    status: alreadyExecuted ? 'executed (idempotent replay)' : 'executed',
    plan: {
      ids: record.selected.ids,
      netted: record.selected.netted,
      gross: record.selected.gross,
    },
    cost: record.selected.costBreakdown,
    totalCost: record.selected.cost,
    volume: record.selected.volume,
    freeze: record.selected.freeze,
    certificate: record.certificate,
    executionMarker: marker,
  };
}

function cmdEmit(opts) {
  const paths = store.statePaths(opts.state);
  if (!store.exists(paths.plan)) {
    fail('no plan found; run optimize first', EXIT.GENERIC);
  }
  const record = store.readJson(paths.plan);
  if (store.exists(paths.executed)) {
    const marker = store.readJson(paths.executed);
    console.log(JSON.stringify(emitPayload(record, marker, true), null, 2));
    process.exit(EXIT.OK);
  }
  if (process.env.SETTLE_CRASH_BEFORE_MARKER === '1') {
    process.exit(99);
  }
  const marker = {
    status: 'executed',
    planHash: model.sha256hex(model.canonical(record.selected)),
    candidateSetHash: record.certificate.candidateSetHash,
  };
  store.writeAtomic(paths.executed, marker);
  console.log(JSON.stringify(emitPayload(record, marker, false), null, 2));
  process.exit(EXIT.OK);
}

function cmdRollback(opts) {
  const paths = store.statePaths(opts.state);
  if (store.exists(paths.executed)) {
    if (store.exists(paths.plan)) {
      const record = store.readJson(paths.plan);
      const reverse = model.reversePlan(record.selected);
      store.writeAtomic(paths.reverse, reverse);
      console.error(`reverse plan written to ${paths.reverse}`);
    }
    fail('plan already executed; rollback refused, only a reverse plan can be generated', EXIT.EXECUTED_ROLLBACK);
  }
  if (store.exists(paths.plan)) {
    const record = store.readJson(paths.plan);
    store.writeAtomic(paths.rolledBack, { ...record, status: 'rolled-back' });
    fs.rmSync(paths.plan);
    console.log(JSON.stringify({ status: 'rolled-back', revoked: record.selected.ids }, null, 2));
    process.exit(EXIT.OK);
  }
  fail('nothing to rollback', EXIT.GENERIC);
}

function cmdExplain(opts) {
  const paths = store.statePaths(opts.state);
  if (!store.exists(paths.plan)) {
    fail('no optimization record; run optimize first', EXIT.GENERIC);
  }
  const record = store.readJson(paths.plan);
  const best = record.certificate.optimalCost;
  const selectedKey = record.certificate.selectedKey;
  const lines = [];
  const entries = [...record.evaluations].sort((a, b) => {
    const ka = model.planKey(a.ids);
    const kb = model.planKey(b.ids);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const explanations = [];
  for (const ev of entries) {
    const key = model.planKey(ev.ids);
    if (key === selectedKey) continue;
    let why;
    if (!ev.feasible) {
      why = `eliminated: infeasible (${ev.reason})`;
    } else if (ev.cost > best) {
      why = `eliminated: dominated (cost ${ev.cost} > optimal ${best})`;
    } else {
      why = 'tied optimal: not selected by fixed key order';
    }
    explanations.push({ plan: ev.ids, why });
    lines.push(`- [${key}] ${why}`);
  }
  if (opts.json) {
    console.log(JSON.stringify({
      optimalCost: best,
      selected: record.selected.ids,
      tiedCount: record.tiedCount,
      candidateSetHash: record.certificate.candidateSetHash,
      explanations,
    }, null, 2));
  } else {
    console.log(`optimal cost: ${best}`);
    console.log(`selected: [${selectedKey}]`);
    console.log(`tied optimal plans: ${record.tiedCount}`);
    console.log(`candidate set hash: ${record.certificate.candidateSetHash}`);
    for (const line of lines) console.log(line);
  }
  process.exit(EXIT.OK);
}

function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'optimize':
      cmdOptimize(opts);
      break;
    case 'emit':
      cmdEmit(opts);
      break;
    case 'rollback':
      cmdRollback(opts);
      break;
    case 'explain':
      cmdExplain(opts);
      break;
    default:
      console.error('usage: node cli.js optimize|emit|rollback|explain [--obligations=f] [--constraints=f] [--state=dir] [--json]');
      process.exit(EXIT.USAGE);
  }
}

main();
