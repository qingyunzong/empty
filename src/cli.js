// CLI logic, exported for in-process testing.
// Usage: node cli.js exec ops.jsonl --budget day=1000
import { readFileSync } from 'node:fs';
import { Ledger } from './ledger.js';

export function runCli(argv, { readFile = readFileSync } = {}) {
  const stdout = [];
  const stderr = [];
  const fail = (msg, code) => {
    stderr.push(msg);
    return { code, stdout, stderr };
  };
  if (argv[0] !== 'exec' || !argv[1]) {
    return fail('usage: node cli.js exec <ops.jsonl> [--budget day=<amount>]', 2);
  }
  const file = argv[1];
  let budget = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--budget') {
      const spec = argv[++i];
      const m = /^day=(\d+(?:\.\d+)?)$/.exec(spec ?? '');
      if (!m) return fail(`invalid --budget spec: ${spec} (expected day=<amount>)`, 2);
      budget = Number(m[1]);
    } else {
      return fail(`unknown argument: ${argv[i]}`, 2);
    }
  }
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (e) {
    return fail(`cannot read ${file}: ${e.message}`, 1);
  }
  const ledger = new Ledger({ budget });
  let step = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    step += 1;
    let op;
    try {
      op = JSON.parse(line);
    } catch (e) {
      stdout.push(JSON.stringify({
        step,
        status: 'error',
        input: line,
        error: { code: 'INVALID_INPUT', message: `invalid JSON: ${e.message}` },
      }));
      continue;
    }
    stdout.push(JSON.stringify({ step, ...ledger.execute(op) }));
  }
  return { code: 0, stdout, stderr };
}
