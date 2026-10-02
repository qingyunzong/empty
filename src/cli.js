import { readFileSync } from 'node:fs';
import { validateProblem, requireInt, ValidationError } from './problem.js';
import { Solver } from './solver.js';

const EXIT_BY_STATUS = { optimal: 0, ok: 0, infeasible: 1, unknown: 3 };

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ValidationError(`cannot read file '${path}'`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`invalid JSON in '${path}': ${err.message}`);
  }
}

function cmdSchedule(args, io) {
  const positional = [];
  let budget = 100000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--budget') {
      const raw = args[++i];
      if (raw === undefined) throw new ValidationError('--budget requires a value');
      const parsed = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
      budget = requireInt(parsed, 'budget', { min: 0 });
    } else if (args[i].startsWith('--')) {
      throw new ValidationError(`unknown option '${args[i]}'`);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1) {
    throw new ValidationError('usage: schedule <problem.json> [--budget N]');
  }
  const problem = validateProblem(readJson(positional[0]));
  const solver = new Solver(problem, { budget });
  const result = solver.solve();
  io.stdout(JSON.stringify(result, null, 2) + '\n');
  return EXIT_BY_STATUS[result.status];
}

function cmdReplace(args, io) {
  if (args.length !== 1) {
    throw new ValidationError('usage: replace <replace.json>');
  }
  const spec = readJson(args[0]);
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('replace spec must be a JSON object');
  }
  const problem = validateProblem(spec.problem);
  if (spec.assignment === null || typeof spec.assignment !== 'object') {
    throw new ValidationError('replace spec requires an assignment object');
  }
  if (typeof spec.op !== 'string') {
    throw new ValidationError("replace spec requires an 'op' id string");
  }
  if (spec.newOp === undefined) {
    throw new ValidationError("replace spec requires a 'newOp' object");
  }
  const solver = new Solver(problem);
  solver.commit(spec.assignment);
  const result = solver.replaceOp(spec.op, spec.newOp);
  io.stdout(JSON.stringify(result, null, 2) + '\n');
  return EXIT_BY_STATUS[result.status];
}

const USAGE =
  'usage:\n  mach-sched schedule <problem.json> [--budget N]\n  mach-sched replace <replace.json>\n';

export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const [command, ...rest] = argv;
    if (command === 'schedule') return cmdSchedule(rest, io);
    if (command === 'replace') return cmdReplace(rest, io);
    io.stderr(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof ValidationError) {
      io.stderr(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}
