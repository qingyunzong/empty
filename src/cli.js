import fs from 'node:fs';
import path from 'node:path';
import { run } from './engine.js';

const USAGE = 'usage: tool life --in <dir> --out <dir> [--rated-force N] [--watermark-delay S]';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        args[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        args[arg.slice(2)] = argv[i + 1];
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

export function readEvents(inputPath) {
  const stat = fs.statSync(inputPath);
  const files = stat.isDirectory()
    ? fs.readdirSync(inputPath).filter((f) => f.endsWith('.jsonl')).sort()
        .map((f) => path.join(inputPath, f))
    : [inputPath];
  const events = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        events.push({ type: '__parse_error__', eventTs: 0, op: `${file}:${index + 1}` });
      }
    });
  }
  return events;
}

export function runCli(argv, io = { stderr: (m) => console.error(m) }) {
  const args = parseArgs(argv);
  if (args._[0] !== 'life' || !args.in || !args.out) {
    io.stderr(USAGE);
    return 2;
  }
  const options = {};
  if (args['rated-force'] !== undefined) options.ratedForce = Number(args['rated-force']);
  if (args['watermark-delay'] !== undefined) options.watermarkDelay = Number(args['watermark-delay']);

  const events = readEvents(args.in).filter((e) => {
    if (e.type === '__parse_error__') {
      io.stderr(`PARSE_ERROR: skipped invalid JSON at ${e.op}`);
      return false;
    }
    return true;
  });
  const result = run(events, options);

  fs.mkdirSync(args.out, { recursive: true });
  const write = (name, lines) =>
    fs.writeFileSync(path.join(args.out, name), lines.length ? lines.join('\n') + '\n' : '');

  write('tools.jsonl', result.tools.map((t) => JSON.stringify(t)));
  write('parts.jsonl', result.parts.map((p) => JSON.stringify(p)));
  fs.writeFileSync(path.join(args.out, 'risk.json'), JSON.stringify(result.summary, null, 2) + '\n');
  write('late.log', result.late.map((l) => JSON.stringify(l)));

  for (const error of result.errors) {
    io.stderr(`${error.code}: ${JSON.stringify(error)}`);
  }
  return result.errors.some((e) => e.code === 'LIFE_INVALID') ? 1 : 0;
}
