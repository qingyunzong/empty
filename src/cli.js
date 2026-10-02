import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine, DispatchError } from './events.js';
import { Engine, DEFAULT_WATERMARK_LAG_MS, formatLateLine } from './engine.js';

const USAGE = `usage: dispatch solve --in <dir> --out <dir> [--lag-ms <ms>]`;

export function readEventsFromDir(inDir) {
  let names;
  try {
    names = readdirSync(inDir);
  } catch {
    throw new DispatchError('IN_DIR_INVALID', `cannot read input dir: ${inDir}`);
  }
  const events = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const path = join(inDir, name);
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      events.push(parseLine(line, `${name}:${i + 1}`));
    }
  }
  return events;
}

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;
  if (command !== 'solve') {
    io.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let inDir = null;
  let outDir = null;
  let lagMs = DEFAULT_WATERMARK_LAG_MS;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--in') inDir = rest[++i];
    else if (flag === '--out') outDir = rest[++i];
    else if (flag === '--lag-ms') lagMs = Number(rest[++i]);
    else {
      io.stderr.write(`unknown flag: ${flag}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!inDir || !outDir || !Number.isFinite(lagMs)) {
    io.stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    const events = readEventsFromDir(inDir);
    const engine = new Engine({ watermarkLagMs: lagMs });
    engine.applyAll(events);
    const { plan, budget, rework, late } = engine.finalize();

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(join(outDir, 'budget.json'), `${JSON.stringify(budget, null, 2)}\n`);
    writeFileSync(
      join(outDir, 'rework.jsonl'),
      rework.map((entry) => JSON.stringify(entry)).join('\n') + (rework.length ? '\n' : ''),
    );
    writeFileSync(
      join(outDir, 'late.log'),
      late.map((entry) => formatLateLine(entry)).join('\n') + (late.length ? '\n' : ''),
    );
    io.stdout.write(
      `solved: ${plan.stats.processed} events, score=${plan.objective.score}, ` +
      `${plan.solutionCount} optimal solution(s), ${plan.stats.late} late event(s)\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof DispatchError) {
      io.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
