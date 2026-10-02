#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadLog, serializeLog, rootOf, parseLog, verifyEvents } from '../src/log.js';
import { applyFix, atomicWritePair } from '../src/patch.js';
import { checkFiles } from '../src/check.js';
import { recoverState } from '../src/recover.js';
import { AuditError, EXIT } from '../src/errors.js';

const USAGE = `usage:
  audit verify <log.jsonl>
  audit patch <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>
  audit check <old.jsonl> <new.jsonl> <cert.json>
  audit recover <new.jsonl> <cert.json>

exit codes: 0 ok | 2 usage | 9 broken chain | 10 unauthorized seq change | 11 cert/file mismatch | 12 crash state (old/partial)`;

function parseFlags(args, flags) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) {
      if (i + 1 >= args.length) throw new AuditError(EXIT.USAGE, `missing value for ${a}`);
      opts[a] = args[++i];
    } else if (a.startsWith('--')) {
      throw new AuditError(EXIT.USAGE, `unknown flag ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

function cmdVerify(args) {
  const { pos } = parseFlags(args, new Set());
  if (pos.length !== 1) throw new AuditError(EXIT.USAGE, 'verify expects exactly 1 argument');
  const events = loadLog(pos[0]);
  console.log(JSON.stringify({ ok: true, events: events.length, root: rootOf(events) }));
}

function cmdPatch(args) {
  const { pos, opts } = parseFlags(args, new Set(['--out', '--cert']));
  if (pos.length !== 2 || !opts['--out'] || !opts['--cert']) {
    throw new AuditError(EXIT.USAGE, 'patch expects <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>');
  }
  const events = loadLog(pos[0]);
  let fix;
  try {
    fix = JSON.parse(readFileSync(pos[1], 'utf8'));
  } catch (err) {
    throw new AuditError(EXIT.USAGE, `cannot read fix.json: ${err.message}`);
  }
  const { newEvents, cert } = applyFix(events, fix);
  atomicWritePair(opts['--out'], serializeLog(newEvents), opts['--cert'], JSON.stringify(cert, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, changedSeqs: cert.changedSeqs, oldRoot: cert.oldRoot, newRoot: cert.newRoot }));
}

function cmdCheck(args) {
  const { pos } = parseFlags(args, new Set());
  if (pos.length !== 3) throw new AuditError(EXIT.USAGE, 'check expects <old.jsonl> <new.jsonl> <cert.json>');
  const result = checkFiles(pos[0], pos[1], pos[2]);
  console.log(JSON.stringify({ ok: true, ...result }));
}

function cmdRecover(args) {
  const { pos } = parseFlags(args, new Set());
  if (pos.length !== 2) throw new AuditError(EXIT.USAGE, 'recover expects <new.jsonl> <cert.json>');
  const { state, message } = recoverState(pos[0], pos[1]);
  const out = state === 'partial' ? process.stderr : process.stdout;
  out.write(message + '\n');
  if (state === 'partial') process.exitCode = EXIT.CRASH_STATE;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'verify': return cmdVerify(rest);
    case 'patch': return cmdPatch(rest);
    case 'check': return cmdCheck(rest);
    case 'recover': return cmdRecover(rest);
    default: throw new AuditError(EXIT.USAGE, 'unknown command');
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof AuditError) {
    process.stderr.write((err.seq !== undefined ? `${err.message} [first seq: ${err.seq}]` : err.message) + '\n');
    if (err.code === EXIT.USAGE) process.stderr.write(USAGE + '\n');
    process.exit(err.code);
  }
  process.stderr.write(`internal error: ${err.stack || err}\n`);
  process.exit(EXIT.GENERIC);
}
