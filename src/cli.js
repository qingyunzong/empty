import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runAudit, AuditError } from './audit.js';

const USAGE = 'usage: demand audit --in <dir> --out <dir> [--budget <kw>]';

function parseArgs(argv) {
  const opts = { budget: Infinity };
  const rest = [...argv];
  const cmd = rest.shift();
  if (cmd !== 'audit') return { error: USAGE };
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (value === undefined) return { error: `missing value for ${flag}\n${USAGE}` };
    if (flag === '--in') opts.inDir = value;
    else if (flag === '--out') opts.outDir = value;
    else if (flag === '--budget') {
      const b = Number(value);
      if (!Number.isFinite(b) || b < 0) return { error: `invalid --budget: ${value}` };
      opts.budget = b;
    } else {
      return { error: `unknown flag: ${flag}\n${USAGE}` };
    }
  }
  if (!opts.inDir || !opts.outDir) return { error: USAGE };
  return { opts };
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''));
}

export function main(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => console.log(s));
  const stderr = io.stderr ?? ((s) => console.error(s));
  const { opts, error } = parseArgs(argv);
  if (error) {
    stderr(error);
    return 2;
  }

  let files;
  try {
    files = readdirSync(opts.inDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch (e) {
    stderr(`cannot read input dir ${opts.inDir}: ${e.message}`);
    return 2;
  }
  if (files.length === 0) {
    stderr(`no .jsonl files in ${opts.inDir}`);
    return 2;
  }
  const lines = files.flatMap((f) => readFileSync(path.join(opts.inDir, f), 'utf8').split('\n'));

  let result;
  try {
    result = runAudit(lines, { budget: opts.budget });
  } catch (e) {
    if (e instanceof AuditError && e.code === 'METER_ROLLBACK') {
      stderr(`METER_ROLLBACK: ${e.message}`);
      return 1;
    }
    throw e;
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeJsonl(path.join(opts.outDir, 'windows.jsonl'), result.windows);
  writeFileSync(path.join(opts.outDir, 'settlement.json'), JSON.stringify(result.settlement, null, 2) + '\n');
  writeJsonl(path.join(opts.outDir, 'comp.jsonl'), result.comp);
  writeJsonl(path.join(opts.outDir, 'late.log'), result.late);

  const s = result.settlement;
  stdout(
    `audited ${s.windowCount} windows; peak ${s.peak ? `${s.peak.demandKw} kW @ ${s.peak.windowStart}` : 'n/a'}; ` +
      `optimal cost ${s.optimal.cost} (${s.optimal.method}, ${s.optimal.planCount} plan(s)); ` +
      `executed cost ${s.executed.cost}; executedIsOptimal=${s.executedIsOptimal}`,
  );
  return 0;
}
