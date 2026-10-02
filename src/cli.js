import { readFileSync } from 'node:fs';
import { mergeHistories, EXIT_CODES } from './merge.js';
import { InvalidHistory } from './parse.js';

const USAGE = `Usage: eco-merge [--config <file.json>] [--budget <n>] <history1.jsonl> <history2.jsonl> ...

Merge offline quadrat-sampling histories and report:
  CONCURRENT_OK       concurrent ops, but merge is unambiguous (exit 0)
  LINEARIZABLE_MODEL  histories are totally ordered by happens-before (exit 0)
  CONFLICT            causal cycle / write conflict / constraint violation (exit 6)
  PENDING             cycle-detection budget exhausted, no verdict given (exit 4)
  INVALID_HISTORY     malformed input (exit 2)
`;

function parseArgs(argv) {
  const args = { files: [], budget: undefined, config: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--budget') args.budget = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else args.files.push(a);
  }
  return args;
}

// Returns the process exit code; output goes through `io` so tests can run
// the CLI in-process.
export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(JSON.stringify({ error: 'INVALID_HISTORY', details: [{ message: err.message }] }) + '\n');
    return EXIT_CODES.INVALID_HISTORY;
  }
  if (args.help || args.files.length === 0) {
    io.stderr(USAGE);
    return args.help ? 0 : EXIT_CODES.INVALID_HISTORY;
  }
  let config = null;
  try {
    if (args.config) config = JSON.parse(readFileSync(args.config, 'utf8'));
    const inputs = args.files.map((f) => ({ name: f, text: readFileSync(f, 'utf8') }));
    const opts = {};
    if (Number.isFinite(args.budget)) opts.budget = args.budget;
    const result = mergeHistories(inputs, config, opts);
    const { graph, effective, ...pub } = result;
    io.stdout(JSON.stringify(pub, null, 2) + '\n');
    return EXIT_CODES[result.verdict];
  } catch (err) {
    if (err instanceof InvalidHistory) {
      io.stderr(JSON.stringify({ error: 'INVALID_HISTORY', details: err.details }, null, 2) + '\n');
      return EXIT_CODES.INVALID_HISTORY;
    }
    throw err;
  }
}
