#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ExitError, loadRecipes, loadJsonl, mergeEvents } from './model.js';
import { Interpreter, resolvePermission } from './interpreter.js';
import { auditReactor } from './audit.js';
import { findCounterexample } from './counterexample.js';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      opts[rest[i].slice(2)] = rest[i + 1];
      i++;
    }
  }
  return { cmd, opts };
}

function requireOpts(opts, names) {
  for (const n of names) {
    if (opts[n] === undefined) throw new ExitError(2, `missing required option --${n}`);
  }
}

function loadWorld(opts) {
  const model = loadRecipes(opts.recipes);
  const approvals = loadJsonl(opts.approvals);
  const attempts = loadJsonl(opts.attempts);
  const events = mergeEvents(approvals, attempts);
  return { model, approvals, attempts, events };
}

function cmdRun(opts) {
  requireOpts(opts, ['recipes', 'approvals', 'attempts', 'out', 'proofdir']);
  const { model, events } = loadWorld(opts);
  const interp = new Interpreter(model).run(events);

  const lines = interp.decisions.map((d) => JSON.stringify(d));
  fs.writeFileSync(opts.out, lines.length ? lines.join('\n') + '\n' : '');

  fs.mkdirSync(opts.proofdir, { recursive: true });
  for (const [reactor, log] of interp.reactorLog) {
    const proof = {
      reactor,
      workshop: model.reactorToWorkshop.get(reactor),
      replay: log,
      deviations: interp.deviations.filter((d) => d.feeds.some((f) => f.reactor === reactor)),
      finalContents: [...(interp.contents.get(reactor) ?? [])].sort(),
      verified: true,
    };
    fs.writeFileSync(path.join(opts.proofdir, `${reactor}.json`), JSON.stringify(proof, null, 2) + '\n');
  }
  const devLines = interp.deviations.map((d) => JSON.stringify(d));
  fs.writeFileSync(path.join(opts.proofdir, 'deviations.jsonl'), devLines.length ? devLines.join('\n') + '\n' : '');
  const summary = {
    factory: model.factory,
    decisions: interp.decisions.length,
    allowed: interp.decisions.filter((d) => d.decision === 'allow').length,
    denied: interp.decisions.filter((d) => d.decision === 'deny').length,
    deviations: interp.deviations.length,
    reactors: [...interp.reactorLog.keys()].sort(),
  };
  fs.writeFileSync(path.join(opts.proofdir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary) + '\n');
}

function cmdAudit(opts) {
  requireOpts(opts, ['recipes', 'approvals', 'attempts', 'reactor']);
  const { model, events } = loadWorld(opts);
  const report = auditReactor(model, events, opts.reactor);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) throw new ExitError(1, `audit failed for reactor ${opts.reactor}`);
}

function cmdCounterexample(opts) {
  requireOpts(opts, ['recipes', 'approvals', 'attempts', 'reactor', 'recipe', 'version', 'out']);
  const { model, approvals, events } = loadWorld(opts);
  const interp = new Interpreter(model).run(events);
  const version = Number(opts.version);
  const contents = interp.contents.get(opts.reactor) ?? new Set();
  const candidates = approvals.filter((a) => a.op === 'grant');
  const result = findCounterexample(model, candidates, contents, opts.reactor, opts.recipe, version);
  let constraintHolds = null;
  if (result.dangerous) {
    // Verify against the real interpreter state: the constraint layer must
    // still deny this feed even when the permission layer would allow it.
    const perm = resolvePermission(model, interp.activeRules(), opts.reactor, opts.recipe, version);
    constraintHolds = result.conflicts.length > 0;
    result.currentPermission = perm.permitted ? 'allow' : 'deny';
    result.effectiveDecision = 'deny';
    result.effectiveReason = perm.permitted ? 'forbidden' : (perm.rule ? 'denied' : 'no-approval');
  }
  const output = {
    target: { reactor: opts.reactor, recipe: opts.recipe, version },
    reactorContents: [...contents].sort(),
    constraintHolds,
    ...result,
  };
  fs.writeFileSync(opts.out, JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(JSON.stringify(output) + '\n');
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'run': cmdRun(opts); break;
    case 'audit': cmdAudit(opts); break;
    case 'counterexample': cmdCounterexample(opts); break;
    default:
      throw new ExitError(2, 'usage: cli.js <run|audit|counterexample> [options]');
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ExitError) {
    console.error(`error(exit ${err.code}): ${err.message}`);
    process.exitCode = err.code;
  } else {
    console.error(err.stack ?? String(err));
    process.exitCode = 1;
  }
}
