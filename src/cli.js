import fs from 'node:fs';
import path from 'node:path';
import { Processor } from './stream.js';
import { PlanError } from './errors.js';
import { DEFAULTS } from './scheduler.js';

function writeJson(outDir, name, value) {
  fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[rest[i]] = rest[i + 1];
  if (cmd !== 'run' || !args['--in'] || !args['--out']) {
    process.stderr.write('usage: plan run --in <dir> --out <dir>\n');
    return 2;
  }
  const inDir = args['--in'];
  const outDir = args['--out'];
  fs.mkdirSync(outDir, { recursive: true });
  const fail = (code, msg) => {
    writeJson(outDir, 'error.json', { code, msg });
    return 1;
  };

  let files;
  try {
    files = fs.readdirSync(inDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (e) {
    return fail('IO_ERROR', `cannot read input dir: ${e.message}`);
  }

  const proc = new Processor();
  try {
    for (const f of files) {
      const lines = fs.readFileSync(path.join(inDir, f), 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const s = line.trim();
        if (!s) return;
        let obj;
        try {
          obj = JSON.parse(s);
        } catch {
          throw new PlanError('PARSE_ERROR', `${f}:${idx + 1}: invalid JSON`);
        }
        proc.ingest(obj);
      });
    }
  } catch (e) {
    if (e instanceof PlanError) return fail(e.code, e.message);
    throw e;
  }

  const horizonMs = DEFAULTS.horizonHours * 3600 * 1000;
  writeJson(outDir, 'schedule.json', {
    watermark: Number.isFinite(proc.watermark) ? proc.watermark : null,
    horizonEnd: proc.current.t0 + horizonMs,
    ...proc.current,
  });
  writeJson(outDir, 'corrections.json', proc.corrections);
  fs.writeFileSync(
    path.join(outDir, 'late.log'),
    proc.lateLog.length > 0 ? `${proc.lateLog.join('\n')}\n` : '',
  );
  return 0;
}
