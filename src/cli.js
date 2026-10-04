#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AlarmStore, StoreError } from './store.js';

class UsageError extends Error {}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

function getTxn(txns, op) {
  if (typeof op.txn !== 'string' || op.txn === '') {
    throw new UsageError(`op "${op.op}" requires a "txn" name`);
  }
  const txn = txns.get(op.txn);
  if (!txn) throw new UsageError(`unknown or closed txn "${op.txn}"`);
  return txn;
}

function applyOp(store, txns, op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    throw new UsageError('each op must be an object with an "op" string');
  }
  switch (op.op) {
    case 'begin': {
      if (typeof op.txn !== 'string' || op.txn === '') throw new UsageError('begin requires a "txn" name');
      if (txns.has(op.txn)) throw new UsageError(`txn "${op.txn}" is already open`);
      txns.set(op.txn, store.begin());
      return { txn: op.txn };
    }
    case 'insert': {
      const data = { deviceId: op.deviceId, alarmTime: op.alarmTime };
      if (op.state !== undefined) data.state = op.state;
      if (op.txn !== undefined) return { alarmId: getTxn(txns, op).insertAlarm(data) };
      return { alarmId: store.insertAlarm(data) };
    }
    case 'ack': {
      const count = getTxn(txns, op).ackWindow(op.deviceId, op.start, op.end, {
        by: op.by ?? null,
        at: op.at ?? null,
        note: op.note ?? null,
      });
      return { count };
    }
    case 'commit': {
      const txn = getTxn(txns, op);
      const result = txn.commit();
      txns.delete(op.txn);
      return { commitSeq: result.commitSeq };
    }
    case 'rollback': {
      getTxn(txns, op).rollback();
      txns.delete(op.txn);
      return {};
    }
    case 'list':
      return { alarms: store.list(op.deviceId ?? null) };
    case 'records':
      return { records: store.ackRecords() };
    default:
      throw new UsageError(`unknown op "${op.op}"`);
  }
}

// Pure entry point: JSON string in, { code, stdout, stderr } out.
// Exit codes: 0 = all ops ok, 1 = an op failed (e.g. E_PHANTOM), 2 = bad input/usage.
export function run(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { code: 2, stdout: '', stderr: `${JSON.stringify({ error: 'input is not valid JSON' })}\n` };
  }
  if (!doc || !Array.isArray(doc.ops)) {
    return { code: 2, stdout: '', stderr: `${JSON.stringify({ error: 'input must be a JSON object with an "ops" array' })}\n` };
  }
  const store = new AlarmStore();
  const txns = new Map();
  const results = [];
  let code = 0;
  for (const op of doc.ops) {
    try {
      results.push({ ok: true, ...applyOp(store, txns, op) });
    } catch (e) {
      if (e instanceof UsageError) {
        return {
          code: 2,
          stdout: `${JSON.stringify({ results }, null, 2)}\n`,
          stderr: `${JSON.stringify({ error: e.message })}\n`,
        };
      }
      if (e instanceof StoreError) {
        results.push({ ok: false, error: { code: e.code, message: e.message } });
        code = 1;
      } else {
        throw e;
      }
    }
  }
  return { code, stdout: `${JSON.stringify({ results }, null, 2)}\n`, stderr: '' };
}

async function main() {
  let raw;
  const file = process.argv[2];
  if (file) {
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      process.stderr.write(`${JSON.stringify({ error: `cannot read file: ${file}` })}\n`);
      process.exit(2);
    }
  } else {
    raw = await readStdin(process.stdin);
  }
  const { code, stdout, stderr } = run(raw);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main();
}
