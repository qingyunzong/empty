#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FeeError } from './lib/errors.js';
import { sync, verify, explainFee } from './lib/engine.js';

const USAGE = `Usage:
  node cli.js sync   --rules rules.ndjson --tx tx.ndjson --state DIR
  node cli.js fee    --state DIR (--txId ID | --time T --amount N) [--rules F] [--tx F]
  node cli.js verify --state DIR [--from T] [--to T] [--rules F] [--tx F]

Times are epoch milliseconds or ISO-8601 strings. Intervals are [from, to).
Exit codes: 0 ok, 2 invalid input, 40 rule overlap without declared priority, 41 time reversed.`;

// Runs one CLI invocation and returns { code, stdout, stderr } without
// touching process state, so tests can drive the CLI in-process.
export function run(argv) {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        rules: { type: 'string' },
        tx: { type: 'string' },
        state: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        txId: { type: 'string' },
        time: { type: 'string' },
        amount: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [cmd] = positionals;
    if (values.help || !cmd) {
      return { code: cmd ? 0 : 2, stdout: USAGE + '\n', stderr: '' };
    }
    const num = (v) => (v !== undefined && v !== null && /^-?\d+$/.test(v) ? Number(v) : v);
    switch (cmd) {
      case 'sync': {
        if (!values.state) throw new FeeError(2, 'sync requires --state');
        const result = sync({ rulesPath: values.rules, txPath: values.tx, stateDir: values.state });
        return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
      }
      case 'fee': {
        if (!values.state) throw new FeeError(2, 'fee requires --state');
        const result = explainFee({
          stateDir: values.state,
          txId: values.txId ?? null,
          time: values.time !== undefined ? num(values.time) : null,
          amount: values.amount !== undefined ? Number(values.amount) : null,
          rulesPath: values.rules ?? null,
          txPath: values.tx ?? null,
        });
        return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
      }
      case 'verify': {
        if (!values.state) throw new FeeError(2, 'verify requires --state');
        const result = verify({
          stateDir: values.state,
          from: values.from !== undefined ? num(values.from) : null,
          to: values.to !== undefined ? num(values.to) : null,
          rulesPath: values.rules ?? null,
          txPath: values.tx ?? null,
        });
        return { code: result.match ? 0 : 1, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
      }
      default:
        return { code: 2, stdout: '', stderr: USAGE + '\n' };
    }
  } catch (err) {
    if (err instanceof FeeError) {
      return { code: err.code, stdout: '', stderr: JSON.stringify({ error: err.message, code: err.code }) + '\n' };
    }
    return { code: 1, stdout: '', stderr: (err && err.stack) || String(err) + '\n' };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
