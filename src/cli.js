#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, StoreError, verify, WAL_FILE } from './store.js';

const USAGE = `settle-audit — offline verifiable settlement audit log

Usage:
  settle-audit commit --dir D --type payment|settlement --id ID --party P --amount N --currency C
  settle-audit commit --dir D --type reversal --ref ID [--id ID] [--expected-version N]
  settle-audit get    --dir D --id ID [--at VERSION]
  settle-audit audit  --dir D --party P [--at VERSION]
  settle-audit verify --dir D
  settle-audit tamper-test --dir D [--seq N]
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Programmatic entry: runs one command, returns { code, output } where
// `output` is the JSON value that would be printed. Used by tests and main().
export async function runCli(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  const ok = (value) => ({ code: 0, output: value });
  const errOut = (code, message, extra = {}) => ({ code: 1, output: { ok: false, code, message, ...extra } });

  if (!command || args.help) {
    return { code: command ? 0 : 1, output: { usage: USAGE } };
  }
  if (!args.dir || args.dir === true) {
    return errOut('E_INVALID', '--dir is required');
  }

  try {
    if (command === 'commit') {
      const store = Store.open(args.dir);
      try {
        const op = { type: args.type };
        if (typeof args.id === 'string') op.id = args.id;
        if (typeof args.ref === 'string') op.ref = args.ref;
        if (typeof args.party === 'string') op.party = args.party;
        if (typeof args.currency === 'string') op.currency = args.currency;
        if (typeof args.amount === 'string') {
          op.amount = Number(args.amount);
          if (!Number.isFinite(op.amount)) return errOut('E_INVALID', `invalid amount: ${args.amount}`);
        }
        let snapshot = null;
        if (args['expected-version'] !== undefined) {
          snapshot = { store, version: Number(args['expected-version']) };
        }
        const cert = await store.commit(op, snapshot);
        return ok({ ok: true, certificate: cert });
      } finally {
        store.close();
      }
    }

    if (command === 'get') {
      const store = Store.open(args.dir);
      try {
        const at = args.at !== undefined ? Number(args.at) : undefined;
        return ok({ ok: true, record: store.getAt(String(args.id), at) });
      } finally {
        store.close();
      }
    }

    if (command === 'audit') {
      const store = Store.open(args.dir);
      try {
        const at = args.at !== undefined ? Number(args.at) : undefined;
        return ok({ ok: true, party: args.party, records: store.auditParty(String(args.party), at) });
      } finally {
        store.close();
      }
    }

    if (command === 'verify') {
      const result = verify(args.dir);
      return { code: result.ok ? 0 : 1, output: result };
    }

    if (command === 'tamper-test') {
      let lines;
      try {
        lines = fs.readFileSync(path.join(args.dir, WAL_FILE), 'utf8').split('\n').filter((l) => l.length > 0);
      } catch (err) {
        if (err.code === 'ENOENT') return errOut('E_INVALID', 'WAL is empty, nothing to tamper');
        throw err;
      }
      if (lines.length === 0) return errOut('E_INVALID', 'WAL is empty, nothing to tamper');
      const seq = args.seq !== undefined ? Number(args.seq) : lines.length;
      if (!Number.isInteger(seq) || seq < 1 || seq > lines.length) {
        return errOut('E_INVALID', `--seq must be in 1..${lines.length}`);
      }
      const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-audit-tamper-'));
      fs.cpSync(args.dir, copyDir, { recursive: true });
      const walPath = path.join(copyDir, WAL_FILE);
      const copyLines = fs.readFileSync(walPath, 'utf8').split('\n').filter((l) => l.length > 0);
      const rec = JSON.parse(copyLines[seq - 1]);
      rec.op.amount = (typeof rec.op.amount === 'number' ? rec.op.amount : 0) + 1;
      copyLines[seq - 1] = JSON.stringify(rec);
      fs.writeFileSync(walPath, copyLines.join('\n') + '\n');
      const result = verify(copyDir);
      const detected = result.ok === false && result.code === 'E_TAMPER' && result.seq === seq;
      return { code: detected ? 0 : 1, output: { ok: detected, tamperedSeq: seq, copyDir, verify: result } };
    }

    return { code: 1, output: { ok: false, code: 'E_INVALID', message: `unknown command: ${command}`, usage: USAGE } };
  } catch (err) {
    if (err instanceof StoreError) return errOut(err.code, err.message);
    return errOut('E_INTERNAL', err.message);
  }
}

async function main() {
  const { code, output } = await runCli(process.argv.slice(2));
  if (typeof output === 'object' && output !== null && 'usage' in output && Object.keys(output).length === 1) {
    process.stdout.write(output.usage);
  } else {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  }
  process.exitCode = code;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  });
}
