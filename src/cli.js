#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commit, loadStateAt, loadHeadState, auditParty, AuditError } from './store.js';
import { verify } from './verify.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(code, message, exitCode = 1) {
  process.stderr.write(JSON.stringify({ ok: false, code, message }) + '\n');
  process.exitCode = exitCode;
}

function dataDir(flags) {
  if (typeof flags.data !== 'string') {
    throw new AuditError('E_INVALID', 'missing required --data <dir>');
  }
  return flags.data;
}

function opInputFromFlags(flags) {
  const type = flags.type;
  const input = { type };
  if (flags['tx-id'] !== undefined) input.txId = String(flags['tx-id']);
  if (flags.party !== undefined) input.party = String(flags.party);
  if (flags.from !== undefined) input.from = String(flags.from);
  if (flags.to !== undefined) input.to = String(flags.to);
  if (flags.reverses !== undefined) input.reverses = String(flags.reverses);
  if (flags.amount !== undefined) input.amount = Number(flags.amount);
  return input;
}

// Copy the store, corrupt one amount in the copied WAL, and verify the copy.
async function tamperTest(dir) {
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), 'tamper-test-'));
  fs.cpSync(dir, probe, { recursive: true });
  const walFile = path.join(probe, 'wal.log');
  const lines = fs.readFileSync(walFile, 'utf8').split('\n').filter((l) => l.length > 0);
  const records = lines.map((l) => JSON.parse(l));
  const target = records.find((r) => typeof r.op?.amount === 'number' && r.op.amount > 0);
  if (!target) {
    return { ok: false, code: 'E_INVALID', message: 'no amount-bearing record to corrupt' };
  }
  target.op.amount += 1;
  records[target.seq] = target;
  fs.writeFileSync(walFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const result = verify(probe);
  return {
    ok: result.code === 'E_TAMPER',
    probeDir: probe,
    corruptedSeq: target.seq,
    result,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  switch (command) {
    case 'commit': {
      const cert = await commit(dataDir(flags), opInputFromFlags(flags));
      print({ ok: true, certificate: cert });
      break;
    }
    case 'get': {
      const dir = dataDir(flags);
      const version = flags.at !== undefined ? Number(flags.at) : loadHeadState(dir).version;
      print({ ok: true, state: loadStateAt(dir, version) });
      break;
    }
    case 'audit': {
      if (typeof flags.party !== 'string') {
        throw new AuditError('E_INVALID', 'audit requires --party <name>');
      }
      const at = flags.at !== undefined ? Number(flags.at) : null;
      print({ ok: true, ...auditParty(dataDir(flags), flags.party, at) });
      break;
    }
    case 'verify': {
      const result = verify(dataDir(flags));
      print(result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'tamper-test': {
      const result = await tamperTest(dataDir(flags));
      print(result);
      if (!result.ok) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(
        'usage: cli.js <commit|get|audit|verify|tamper-test> --data DIR [options]\n',
      );
      process.exitCode = 2;
  }
}

main().catch((err) => {
  if (err instanceof AuditError) {
    fail(err.code, err.message);
  } else {
    fail('E_INTERNAL', err.stack ?? String(err));
  }
});
