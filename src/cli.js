#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger } from './ledger.js';
import { RefundError } from './errors.js';

function applyOp(ledger, op, asOf) {
  switch (op.op) {
    case 'order':
      ledger.addOrder(op.order);
      return { op: 'order', orderId: op.order.orderId, status: 'ok' };
    case 'budget':
      ledger.setBudget(op.merchantId, op.period, op.limit);
      return { op: 'budget', merchantId: op.merchantId, period: op.period, status: 'ok' };
    case 'refund': {
      if (op.order) ledger.addOrder(op.order);
      const orderId = op.orderId ?? op.order?.orderId;
      const node = ledger.refund(op.refId, orderId, op.lines, { date: op.date ?? asOf });
      return { op: 'refund', refId: node.refId, status: 'ok', gross: node.gross, effects: node.effects };
    }
    case 'settle':
      ledger.settle(op.refId);
      return { op: 'settle', refId: op.refId, status: 'ok' };
    case 'revoke': {
      const res = ledger.revoke(op.refId, { reverse: !!op.reverse });
      return { op: 'revoke', refId: op.refId, status: 'ok', revoked: res.revoked };
    }
    default:
      throw new RefundError('E_VALIDATION', `unknown op ${JSON.stringify(op.op)}`);
  }
}

// Returns the process exit code; writes results to io.stdout / io.stderr.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const fail = (err, exitCode) => {
    const e = err instanceof RefundError ? err : new RefundError('E_INTERNAL', err.message);
    const out = { code: e.code, message: e.message };
    if (e.path) out.path = e.path;
    if (e.reversal) out.reversal = e.reversal;
    io.stderr(JSON.stringify(out) + '\n');
    return exitCode;
  };
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'apply' || !file) {
    return fail(new RefundError('E_USAGE', 'usage: refund apply ops.jsonl --as-of YYYY-MM-DD'), 2);
  }
  let asOf = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--as-of') asOf = rest[i + 1];
  }
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    return fail(new RefundError('E_USAGE', 'missing or invalid --as-of YYYY-MM-DD'), 2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fail(new RefundError('E_IO', `cannot read ${file}`), 2);
  }
  const ledger = new Ledger();
  try {
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        throw new RefundError('E_VALIDATION', `line ${i + 1}: invalid JSON`);
      }
      if (op.date && op.date > asOf) continue; // --as-of: skip future ops
      const result = applyOp(ledger, op, asOf);
      if (result) io.stdout(JSON.stringify(result) + '\n');
    }
  } catch (err) {
    return fail(err, 1);
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
