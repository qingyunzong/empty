import { readFileSync } from 'node:fs';
import { Ledger } from './engine.js';
import { LedgerError } from './events.js';
import { verifyCertificate } from './verify.js';

export const EXIT_CODES = {
  ok: 0,
  infeasible: 1,
  E_PARSE: 2,
  E_REF: 3,
  E_PENDING: 4,
};

const USAGE = `fx-settle - exact rational multi-currency net settlement

usage:
  node bin/settle.js settle <events.jsonl|-> [--base CCY] [--scale N]
  node bin/settle.js verify <events.jsonl|-> <certificate.json>
  node bin/settle.js hash   <events.jsonl|->

exit codes: 0 ok | 1 infeasible/invalid | 2 E_PARSE | 3 E_REF | 4 E_PENDING
`;

function readInput(path) {
  return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--base') flags.base = args[++i];
    else if (a.startsWith('--base=')) flags.base = a.slice('--base='.length);
    else if (a === '--scale') flags.scale = Number(args[++i]);
    else if (a.startsWith('--scale=')) flags.scale = Number(a.slice('--scale='.length));
    else positional.push(a);
  }
  if (flags.scale !== undefined && (!Number.isInteger(flags.scale) || flags.scale < 0 || flags.scale > 18)) {
    throw new LedgerError('E_PARSE', `--scale must be an integer in [0, 18], got ${flags.scale}`);
  }
  return { flags, positional };
}

function loadLedger(text, base) {
  const ledger = new Ledger({ base: base ?? null });
  const lines = text.split(/\r?\n/);
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    if (!raw.trim()) continue;
    ledger.applyLine(raw, lineNo);
  }
  return ledger;
}

export function run(argv, io = { out: process.stdout, err: process.stderr }) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'settle') {
      const { flags, positional } = parseFlags(rest);
      if (positional.length !== 1) throw new LedgerError('E_PARSE', 'settle expects exactly one events file');
      const ledger = loadLedger(readInput(positional[0]), flags.base);
      const result = ledger.settle({ scale: flags.scale ?? 2 });
      io.out.write(`${JSON.stringify(result, null, 2)}\n`);
      const code =
        result.status === 'ok' ? EXIT_CODES.ok : result.status === 'pending' ? EXIT_CODES.E_PENDING : EXIT_CODES.infeasible;
      return code;
    }
    if (cmd === 'verify') {
      const { positional } = parseFlags(rest);
      if (positional.length !== 2) throw new LedgerError('E_PARSE', 'verify expects <events.jsonl> <certificate.json>');
      let cert;
      try {
        cert = JSON.parse(readInput(positional[1]));
      } catch (e) {
        throw new LedgerError('E_PARSE', `certificate is not valid JSON: ${e.message}`);
      }
      const result = verifyCertificate(readInput(positional[0]), cert);
      io.out.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.valid ? EXIT_CODES.ok : EXIT_CODES.infeasible;
    }
    if (cmd === 'hash') {
      const { flags, positional } = parseFlags(rest);
      if (positional.length !== 1) throw new LedgerError('E_PARSE', 'hash expects exactly one events file');
      const ledger = loadLedger(readInput(positional[0]), flags.base);
      io.out.write(`${ledger.historyHash()}\n`);
      return EXIT_CODES.ok;
    }
    io.err.write(USAGE);
    return 64;
  } catch (e) {
    if (e instanceof LedgerError) {
      io.err.write(`${JSON.stringify({ error: { code: e.code, message: e.message, line: e.line } })}\n`);
      return EXIT_CODES[e.code] ?? 1;
    }
    if (e && e.code === 'ENOENT') {
      io.err.write(`${JSON.stringify({ error: { code: 'E_IO', message: e.message } })}\n`);
      return 2;
    }
    throw e;
  }
}
