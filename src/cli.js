import { readFileSync, writeFileSync } from 'node:fs';
import { Store, DomainError } from './store.js';

const USAGE = `Usage: obs-sched --events events.jsonl [options]

Options:
  --events <path>           JSONL event stream (plan/observe/correct/revoke/checkpoint)
  --out <path>              write result JSON here (default: stdout)
  --checkpoint-file <path>  where checkpoint events persist state (default: checkpoint.json)
  --recover <path>          resume from a checkpoint snapshot before applying events
  --help                    show this help

Exit codes: 0 ok, 2 usage/IO error, 3 domain error
  (window overlap, negative duration, revoke of unknown observation, ...).
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--events') args.events = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--checkpoint-file') args.checkpointFile = argv[++i];
    else if (a === '--recover') args.recover = argv[++i];
    else throw new DomainError('USAGE', `unknown argument: ${a}`);
  }
  return args;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr.write(JSON.stringify({ error: err.code, message: err.message }) + '\n');
    return 3;
  }
  if (args.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (!args.events) {
    io.stderr.write('error: --events <path> is required\n');
    return 2;
  }
  try {
    const store = args.recover ? Store.restore(readFileSync(args.recover, 'utf8')) : new Store();
    const checkpointPath = args.checkpointFile ?? 'checkpoint.json';
    store.onCheckpoint = (s) => writeFileSync(checkpointPath, s.snapshot() + '\n');
    const events = readFileSync(args.events, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new DomainError('BAD_JSON', `line ${i + 1}: invalid JSON`);
        }
      });
    store.applyAll(events);
    const result = store.schedule();
    const certificate = store.certificate();
    const out = JSON.stringify({ ...result, certificate }, null, 2) + '\n';
    if (args.out) writeFileSync(args.out, out);
    else io.stdout.write(out);
    return 0;
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(JSON.stringify({ error: err.code, message: err.message }) + '\n');
      return 3;
    }
    if (err && err.code === 'ENOENT') {
      io.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
}
