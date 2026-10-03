import { readFileSync, writeFileSync } from 'node:fs';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check, DENOM } from './checker.js';
import { Scheduler } from './scheduler.js';
import { buildPlan, verifyPlan, round6 } from './plan.js';
import { DslError } from './errors.js';

const USAGE = `usage:
  energy schedule <site.dsl> [--json plan.json]
  energy verify <plan.json>

exit codes:
  0  success (plan within budgets / plan verified)
  1  verify: plan is invalid or not optimal
  2  usage, I/O, lexical, syntax or type error (reported with line:col)
  3  schedule: hard constraints are infeasible (INFEASIBLE)
  4  schedule: feasible but over costBudget/carbonBudget (OVER_BUDGET)`;

function cmdSchedule(args, io) {
  let file = null;
  let jsonPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') {
      jsonPath = args[i + 1];
      if (!jsonPath) throw new DslError('--json requires a path');
      i += 1;
    } else if (a.startsWith('--json=')) {
      jsonPath = a.slice('--json='.length);
    } else if (file === null) {
      file = a;
    } else {
      throw new DslError(`unexpected argument '${a}'`);
    }
  }
  if (!file) throw new DslError('schedule requires a .dsl file');

  const sourceText = readFileSync(file, 'utf8');
  const model = check(parse(lex(sourceText, file)));
  const results = model.sites.map((site) => ({ site, res: new Scheduler(site).solve() }));
  const plan = buildPlan(file, sourceText, model, results);
  const json = `${JSON.stringify(plan, null, 2)}\n`;

  const lines = [];
  let exitCode = 0;
  for (const { site, res } of results) {
    if (res.status === 'INFEASIBLE') {
      lines.push(`site '${site.name}': INFEASIBLE (hard constraints cannot be satisfied)`);
      exitCode = Math.max(exitCode, 3);
    } else {
      const o = res.optimum;
      const cost = round6(o.costNum / DENOM);
      const carbon = round6(o.carbonNum / DENOM);
      const peak = o.peakW / 1000;
      if (res.status === 'OVER_BUDGET') {
        const parts = res.budgetsExceeded.map((b) => {
          if (b === 'cost') return `minimum cost ${cost} exceeds costBudget ${site.costBudget}`;
          return `minimum carbon ${carbon} exceeds carbonBudget ${site.carbonBudget}`;
        });
        lines.push(`site '${site.name}': OVER_BUDGET (${parts.join('; ')}) peak=${peak} kW`);
        exitCode = Math.max(exitCode, 4);
      } else {
        lines.push(`site '${site.name}': OK cost=${cost} peak=${peak} kW carbon=${carbon} kg`);
      }
    }
  }

  if (jsonPath) {
    writeFileSync(jsonPath, json);
    for (const l of lines) io.out(l);
    io.out(`plan written to ${jsonPath}`);
  } else {
    for (const l of lines) io.err(l);
    io.writeOut(json);
  }
  return exitCode;
}

function cmdVerify(args, io) {
  const [file, ...rest] = args;
  if (!file || rest.length > 0) throw new DslError('verify requires exactly one plan.json file');
  const { ok, problems } = verifyPlan(file);
  if (ok) {
    io.out(`${file}: plan is VALID and optimal`);
    return 0;
  }
  for (const p of problems) io.err(`invalid: ${p}`);
  io.err(`${file}: plan is INVALID`);
  return 1;
}

export function main(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  const writeOut = io.writeOut ?? ((s) => process.stdout.write(s));
  const ioFns = { out, err, writeOut };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'schedule') return cmdSchedule(rest, ioFns);
    if (cmd === 'verify') return cmdVerify(rest, ioFns);
    err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof DslError) {
      err(e.toString());
    } else if (e && e.code === 'ENOENT') {
      err(`error: cannot read file: ${e.path}`);
    } else {
      err(`error: ${e.message}`);
    }
    return 2;
  }
}
