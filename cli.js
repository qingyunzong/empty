#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const settle = require('./lib/settle');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new settle.InputError('cannot read ' + file + ': ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new settle.InputError('invalid JSON in ' + file + ': ' + err.message);
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function printMetrics(prefix, m) {
  return (
    prefix +
    'principal=' + m.principal +
    ' fee=' + m.fee +
    ' freeze=' + m.freeze +
    ' days=' + m.days +
    ' amount=' + m.amount
  );
}

function loadInputs(ctx, args) {
  const obligationsPath = ctx.resolve(args.obligations || 'obligations.json');
  const constraintsPath = ctx.resolve(args.constraints || 'constraints.json');
  const obligations = settle.normalizeObligations(readJson(obligationsPath));
  const constraints = settle.normalizeConstraints(readJson(constraintsPath));
  return { obligations, constraints };
}

function cmdOptimize(ctx, args) {
  let input;
  try {
    input = loadInputs(ctx, args);
  } catch (err) {
    ctx.stderr('error(2): ' + err.message);
    return 2;
  }
  const result = settle.optimize(input.obligations, input.constraints, {
    excludePending: !!args['exclude-pending'],
  });
  if (!result.ok) {
    ctx.stderr('error(' + result.code + '): ' + result.error);
    if (result.pending) ctx.stderr('pending obligations: ' + result.pending.join(', '));
    return result.code;
  }
  const out = ctx.resolve(args.out || 'plan.json');
  const doc = {
    ...result.plan,
    eliminated: result.eliminated,
    infeasible: result.infeasible,
    evaluated: result.evaluated,
    pendingExcluded: result.pendingExcluded,
    inputs: {
      obligationsHash: settle.sha256hex(settle.canonicalize(input.obligations)),
      constraintsHash: settle.sha256hex(settle.canonicalize(input.constraints)),
    },
  };
  writeJsonAtomic(out, doc);
  const cert = result.plan.certificate;
  ctx.stdout('plan ' + result.plan.planId + ' written to ' + out);
  ctx.stdout('  payments:');
  for (const p of result.plan.payments) {
    ctx.stdout('    ' + p.from + ' -> ' + p.to + ' amount=' + p.amount + ' days=' + p.days);
  }
  ctx.stdout(printMetrics('  ', result.plan.metrics));
  ctx.stdout(
    '  evaluated=' + cert.evaluated +
      ' feasible=' + cert.feasibleCount +
      ' tied=' + cert.tiedCount
  );
  ctx.stdout('  certificate candidateSetHash=' + cert.candidateSetHash);
  if (result.pendingExcluded.length > 0) {
    ctx.stdout('  pending excluded: ' + result.pendingExcluded.join(', '));
  }
  return 0;
}

function cmdEmit(ctx, args) {
  const planPath = ctx.resolve(args.plan || 'plan.json');
  let plan;
  let input;
  try {
    plan = readJson(planPath);
    input = loadInputs(ctx, args);
  } catch (err) {
    ctx.stderr('error(2): ' + err.message);
    return 2;
  }
  const check = settle.buildExecution(plan, input.obligations, input.constraints);
  if (!check.ok) {
    let message = check.error;
    if (check.violations) message += ' [' + check.violations.join(', ') + ']';
    ctx.stderr('error(' + check.code + '): ' + message);
    return check.code;
  }
  const stateDir = ctx.resolve(args.state || '.settle-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const executedPath = path.join(stateDir, plan.planId + '.executed.json');
  const markerPath = path.join(stateDir, plan.planId + '.marker');
  const record = {
    planId: plan.planId,
    status: 'executed',
    plan,
    execution: { payments: check.payments, metrics: check.metrics },
    certificate: plan.certificate,
  };
  writeJsonAtomic(executedPath, record);
  if (ctx.env.SETTLE_CRASH_BEFORE_MARKER === '1') {
    ctx.stderr('simulated crash before execution marker write');
    return 1;
  }
  // The execution marker is written last; its presence alone proves execution.
  const marker = {
    planId: plan.planId,
    executed: true,
    outputHash: settle.sha256hex(settle.canonicalize(record)),
  };
  writeJsonAtomic(markerPath, marker);
  ctx.stdout('executed ' + plan.planId);
  ctx.stdout('  payments:');
  for (const p of check.payments) {
    ctx.stdout('    ' + p.from + ' -> ' + p.to + ' amount=' + p.amount + ' days=' + p.days);
  }
  ctx.stdout(printMetrics('  cost: ', {
    principal: plan.metrics.principal,
    fee: check.metrics.fee,
    freeze: check.metrics.freeze,
    days: check.metrics.days,
    amount: check.metrics.amount,
  }));
  ctx.stdout('  certificate candidateSetHash=' + plan.certificate.candidateSetHash);
  ctx.stdout('  marker ' + markerPath);
  return 0;
}

function cmdRollback(ctx, args) {
  const planPath = ctx.resolve(args.plan || 'plan.json');
  let plan;
  try {
    plan = readJson(planPath);
  } catch (err) {
    ctx.stderr('error(2): ' + err.message);
    return 2;
  }
  const stateDir = ctx.resolve(args.state || '.settle-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const markerPath = path.join(stateDir, plan.planId + '.marker');
  if (fs.existsSync(markerPath)) {
    if (args.reverse) {
      const reverse = settle.buildReversePlan(plan);
      const out = args.out
        ? ctx.resolve(args.out)
        : path.join(stateDir, plan.planId + '.reverse.json');
      writeJsonAtomic(out, reverse);
      ctx.stdout(
        'plan ' + plan.planId + ' already executed; rollback impossible, ' +
          'reverse plan ' + reverse.planId + ' written to ' + out
      );
      return 0;
    }
    ctx.stderr(
      'error(' + settle.EXIT_ROLLBACK_AFTER_EXECUTION + '): plan ' + plan.planId +
        ' already executed; rollback refused, use rollback --reverse to emit a reverse plan'
    );
    return settle.EXIT_ROLLBACK_AFTER_EXECUTION;
  }
  const cancelled = {
    planId: plan.planId,
    status: 'cancelled',
    reason: typeof args.reason === 'string' ? args.reason : 'rolled back before execution',
  };
  const out = path.join(stateDir, plan.planId + '.cancelled.json');
  writeJsonAtomic(out, cancelled);
  ctx.stdout('plan ' + plan.planId + ' cancelled (was not executed); record ' + out);
  return 0;
}

function cmdExplain(ctx, args) {
  const planPath = ctx.resolve(args.plan || 'plan.json');
  let plan;
  try {
    plan = readJson(planPath);
  } catch (err) {
    ctx.stderr('error(2): ' + err.message);
    return 2;
  }
  ctx.stdout('chosen plan ' + plan.planId);
  ctx.stdout(printMetrics('  ', plan.metrics));
  ctx.stdout('  certificate:');
  ctx.stdout('    evaluated=' + plan.certificate.evaluated +
    ' feasible=' + plan.certificate.feasibleCount +
    ' tied=' + plan.certificate.tiedCount);
  ctx.stdout('    candidateSetHash=' + plan.certificate.candidateSetHash);
  if (typeof args.subset === 'string') {
    let input;
    try {
      input = loadInputs(ctx, args);
    } catch (err) {
      ctx.stderr('error(2): ' + err.message);
      return 2;
    }
    const ids = args.subset.split(',').map((s) => s.trim()).filter(Boolean);
    const byId = new Map(input.obligations.map((o) => [o.id, o]));
    const members = [];
    for (const id of ids) {
      const o = byId.get(id);
      if (!o) {
        ctx.stderr('error(2): unknown obligation "' + id + '"');
        return 2;
      }
      members.push(o);
    }
    const payments = settle.netPayments(members);
    const metrics = settle.evaluatePayments(payments, input.constraints);
    let principal = 0;
    for (const o of members) principal += o.amount;
    const candidate = { principal, ...metrics };
    const violations = settle.violationsOf(metrics, input.constraints);
    ctx.stdout('subset ' + ids.join(','));
    ctx.stdout(printMetrics('  ', candidate));
    if (violations.length > 0) {
      ctx.stdout('  eliminated: infeasible, violates ' + violations.join(', '));
    } else {
      ctx.stdout('  eliminated: ' + settle.eliminationReason(candidate, plan.metrics));
    }
    return 0;
  }
  const infeasible = plan.infeasible || { total: 0, byConstraint: {} };
  ctx.stdout('  infeasible candidates: ' + infeasible.total);
  for (const [k, v] of Object.entries(infeasible.byConstraint || {})) {
    ctx.stdout('    violates ' + k + ': ' + v);
  }
  ctx.stdout('  eliminated feasible candidates:');
  for (const e of plan.eliminated || []) {
    ctx.stdout('    ' + e.key);
    ctx.stdout('      reason: ' + e.reason);
    ctx.stdout(printMetrics('      ', e.metrics));
  }
  return 0;
}

function usage(ctx) {
  ctx.stdout(
    [
      'usage: node cli.js <command> [options]',
      '',
      'commands:',
      '  optimize   read obligations.json + constraints.json, write plan.json',
      '  emit       validate and execute a plan, write execution marker',
      '  rollback   cancel an unexecuted plan; --reverse emits a reverse plan',
      '  explain    show elimination reasons; --subset o1,o2 explains one subset',
      '',
      'options:',
      '  --obligations <file>   (default obligations.json)',
      '  --constraints <file>   (default constraints.json)',
      '  --plan <file>          (default plan.json)',
      '  --out <file>           output path',
      '  --state <dir>          state directory (default .settle-state)',
      '  --exclude-pending      exclude pending obligations instead of failing',
      '',
      'exit codes: 70 infeasible, 71 pending treated as unsatisfiable,',
      '            72 rollback after execution',
    ].join('\n')
  );
}

// Programmatic entry point: returns the exit code. `io` supplies cwd, env and
// output sinks so tests can drive the CLI in-process.
function run(argv, io = {}) {
  const ctx = {
    cwd: io.cwd || process.cwd(),
    env: io.env || process.env,
    stdout: io.stdout || ((line) => console.log(line)),
    stderr: io.stderr || ((line) => console.error(line)),
    resolve: (p) => path.resolve(io.cwd || process.cwd(), p),
  };
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'optimize':
      return cmdOptimize(ctx, args);
    case 'emit':
      return cmdEmit(ctx, args);
    case 'rollback':
      return cmdRollback(ctx, args);
    case 'explain':
      return cmdExplain(ctx, args);
    default:
      usage(ctx);
      return command ? 64 : 0;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
