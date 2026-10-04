#!/usr/bin/env node
// NDJSON CLI: one command per line on stdin, one JSON result per line on
// stdout. Any failing line yields a JSON error object and a final exit
// code of 1 (processing of subsequent lines continues).
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerError } from './ledger.js';

function requireStrings(cmd, fields) {
  for (const f of fields) {
    if (typeof cmd[f] !== 'string' || cmd[f].length === 0) {
      throw new LedgerError('BAD_FIELD', `field "${f}" must be a non-empty string`);
    }
  }
  return fields.map((f) => cmd[f]);
}

export function execute(ledger, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new LedgerError('BAD_COMMAND', 'command must be a JSON object');
  }
  switch (cmd.op) {
    case 'add-dep': {
      const [u, v] = requireStrings(cmd, ['u', 'v']);
      ledger.addDep(u, v);
      return { ok: true, op: 'add-dep', u, v };
    }
    case 'remove-dep': {
      const [u, v] = requireStrings(cmd, ['u', 'v']);
      ledger.removeDep(u, v);
      return { ok: true, op: 'remove-dep', u, v };
    }
    case 'cancel': {
      const [id, tx] = requireStrings(cmd, ['id', 'tx']);
      return { ok: true, op: 'cancel', ...ledger.cancel(id, tx) };
    }
    case 'restore': {
      const [id, tx] = requireStrings(cmd, ['id', 'tx']);
      return { ok: true, op: 'restore', ...ledger.restore(id, tx) };
    }
    case 'query':
      return { ok: true, op: 'query', ...ledger.query() };
    default:
      throw new LedgerError('UNKNOWN_OP', `unknown op: ${JSON.stringify(cmd.op)}`);
  }
}

// Pure-ish driver: NDJSON string in, per-line results + exit code out.
export function run(input) {
  const ledger = new Ledger();
  let hadError = false;
  const results = [];
  for (const raw of input.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    let out;
    try {
      out = execute(ledger, JSON.parse(trimmed));
    } catch (err) {
      hadError = true;
      out = {
        ok: false,
        error: {
          code: err instanceof LedgerError ? err.code : 'INVALID_LINE',
          message: String(err?.message ?? err),
        },
      };
    }
    results.push(out);
  }
  return { results, exitCode: hadError ? 1 : 0 };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const { results, exitCode } = run(input);
  for (const r of results) process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exitCode = exitCode;
}
