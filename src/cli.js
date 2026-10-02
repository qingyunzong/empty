import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAudit } from './audit.js';
import { AuditError } from './engine.js';

const USAGE = 'usage: demand audit --in <dir> --out <dir>';

function parseArgs(argv) {
  if (argv[0] !== 'audit') throw new AuditError('USAGE', USAGE);
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--in') opts.inDir = argv[++i];
    else if (argv[i] === '--out') opts.outDir = argv[++i];
    else throw new AuditError('USAGE', USAGE);
  }
  if (!opts.inDir || !opts.outDir) throw new AuditError('USAGE', USAGE);
  return opts;
}

async function readEvents(inDir) {
  const files = (await readdir(inDir)).filter((f) => f.endsWith('.jsonl')).sort();
  const events = [];
  for (const file of files) {
    const text = await readFile(path.join(inDir, file), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        throw new AuditError('BAD_JSON', `${file}:${i + 1}: invalid JSON line`);
      }
    }
  }
  return events;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const { inDir, outDir } = parseArgs(argv);
    const events = await readEvents(inDir);
    const { outputs, settlement } = runAudit(events);
    await mkdir(outDir, { recursive: true });
    for (const [name, content] of Object.entries(outputs)) {
      await writeFile(path.join(outDir, name), content);
    }
    io.stdout.write(
      `audited ${settlement.windowCount} window(s); ` +
      `peak ${settlement.peak ? settlement.peak.grossKw : 0} kW; ` +
      `optimal cost ${settlement.optimal.demandCost}; ` +
      `outputs written to ${outDir}\n`);
    return 0;
  } catch (err) {
    if (err instanceof AuditError) {
      io.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
