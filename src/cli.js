import { readFileSync } from 'node:fs';
import { VM } from './vm.js';
import { compile } from './index.js';
import { DslError } from './errors.js';

export const USAGE = `usage:
  escrow fold <ticks.jsonl> [--at seqN] [--pretty]

  folds trade-report events (one JSON object per line: {"seq":N,"text":"<DSL>"})
  into the freeze-ledger state. --at seqN prints the state of the prefix up to
  and including seqN. exit code 1 with a JSON error on stderr on failure.`;

function parseArgs(argv) {
  const args = { pretty: false, at: null, cmd: null, file: null };
  const rest = [...argv];
  args.cmd = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === '--at') {
      args.at = Number(rest.shift());
      if (!Number.isInteger(args.at) || args.at <= 0) {
        throw new DslError('E_SEQ', `--at expects a positive integer, got ${args.at}`);
      }
    } else if (a === '--pretty') {
      args.pretty = true;
    } else if (!args.file) {
      args.file = a;
    } else {
      throw new DslError('E_PARSE', `unexpected argument ${a}`);
    }
  }
  return args;
}

// In-process CLI entry: returns {code, stdout, stderr} so it can be driven
// both from bin/escrow.js and from tests without spawning a child process.
export function runCli(argv, { readFile = readFileSync } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.cmd !== 'fold' || !args.file) {
      return { code: 2, stdout: '', stderr: `${USAGE}\n` };
    }
    const lines = readFile(args.file, 'utf8').split('\n');
    const vm = new VM();
    let applied = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (!raw) continue;
      let tick;
      try {
        tick = JSON.parse(raw);
      } catch {
        throw new DslError('E_PARSE', `line ${i + 1}: invalid JSON`);
      }
      if (!Number.isInteger(tick.seq) || typeof tick.text !== 'string') {
        throw new DslError('E_PARSE', `line ${i + 1}: need {"seq":N,"text":"..."}`);
      }
      if (args.at !== null && tick.seq > args.at) continue; // prefix cut
      const ev = compile(tick.text, i + 1);
      if (!ev) continue;
      let r;
      try {
        r = vm.apply(ev, tick.seq);
      } catch (err) {
        if (err instanceof DslError && err.seq === undefined) err.seq = tick.seq;
        throw err;
      }
      if (!r.noop) applied += 1;
    }
    const out = { ...vm.state(), applied };
    return { code: 0, stdout: `${JSON.stringify(out, null, args.pretty ? 2 : 0)}\n`, stderr: '' };
  } catch (err) {
    if (err instanceof DslError) {
      const body = { error: err.code, message: err.message };
      if (err.seq !== undefined) body.seq = err.seq;
      return { code: 1, stdout: '', stderr: `${JSON.stringify(body)}\n` };
    }
    throw err;
  }
}
