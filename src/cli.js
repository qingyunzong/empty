import { readFileSync } from 'node:fs';
import { run, CorpError } from './index.js';

// CLI entry, callable in-process for tests. Returns the exit code.
export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const args = argv;
  if (args[0] !== 'apply' || args.length < 3) {
    io.err('usage: corp apply <actions.ca> <lots.json> [--ledger]');
    return 2;
  }
  const [, actionsPath, lotsPath] = args;
  const wantLedger = args.includes('--ledger');
  try {
    const src = readFileSync(actionsPath, 'utf8');
    const lotsInput = JSON.parse(readFileSync(lotsPath, 'utf8'));
    const result = run(src, lotsInput);
    const out = {
      positions: result.positions,
      cash: result.cash,
      adjustments: result.adjustments,
    };
    if (wantLedger) out.ledger = result.ledger;
    io.out(JSON.stringify(out, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CorpError) {
      io.err(`${e.code}: ${e.message}`);
      return 1;
    }
    if (e && e.code === 'ENOENT') {
      io.err(`E_LOT: cannot read file: ${e.path}`);
      return 1;
    }
    if (e instanceof SyntaxError) {
      io.err(`E_LOT: invalid JSON in lots file: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
