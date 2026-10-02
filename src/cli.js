import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { normalizeConfig } from './config.js';
import { Engine, exitCodeFor } from './engine.js';
import { runSimulation } from './scheduler.js';

export function parseArgs(argv) {
  const args = { input: null, config: null, log: null, out: null, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') args.resume = true;
    else if (a === '--input' || a === '-i') args.input = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--log' || a === '-l') args.log = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  return { args };
}

// Returns the process exit code. io: { stdout(s), stderr(s) }.
export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const { args, error } = parseArgs(argv);
  if (error || !args?.input) {
    if (error) io.stderr(error + '\n');
    io.stderr('usage: labsched --input ops.jsonl [--config cfg.json] [--log run.log] [--out result.json] [--resume]\n');
    return 2;
  }

  let cfg;
  try {
    const overrides = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : {};
    cfg = normalizeConfig(overrides);
  } catch (e) {
    io.stderr(`config error: ${e.message}\n`);
    return 2;
  }

  const ops = [];
  let lines;
  try {
    lines = readFileSync(args.input, 'utf8').split('\n');
  } catch (e) {
    io.stderr(`cannot read input: ${e.message}\n`);
    return 2;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      ops.push(JSON.parse(line));
    } catch {
      io.stderr(`invalid JSON on line ${i + 1} of ${args.input}\n`);
      return 2;
    }
  }

  let engine;
  if (args.resume && args.log && existsSync(args.log)) {
    engine = Engine.recoverFile(cfg, args.log);
  } else {
    if (args.log) writeFileSync(args.log, '');
    engine = new Engine(cfg, { logPath: args.log ?? null });
  }

  const result = runSimulation(engine, ops);
  const out = JSON.stringify(result, null, 2) + '\n';
  if (args.out) writeFileSync(args.out, out);
  else io.stdout(out);

  return exitCodeFor(result.failures);
}
