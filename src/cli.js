#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RefundLedger } from './ledger.js';
import { isValidDate } from './dates.js';

const USAGE = 'usage: refund apply <ops.jsonl> [--as-of YYYY-MM-DD]';

function applyOp(ledger, op) {
  switch (op?.op) {
    case 'refund':
      return ledger.refund(op.refId, op.order, op.lines, { date: op.date, settleDays: op.settleDays });
    case 'revoke':
      return ledger.revoke(op.refId, { reverse: op.reverse === true });
    case 'budget':
      return ledger.setBudget(op.merchantId, { limit: op.limit, period: op.period });
    default:
      return { ok: false, error: { code: 'E_INVALID_OP', message: `unknown op: ${op?.op}` } };
  }
}

export function run(argv, { stdout, stderr } = {}) {
  const out = stdout ?? ((s) => process.stdout.write(s));
  const err = stderr ?? ((s) => process.stderr.write(s));
  const die = (error, code = 1) => {
    err(JSON.stringify({ code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) }) + '\n');
    return code;
  };

  const [cmd, file, ...rest] = argv;
  if (cmd !== 'apply' || !file) return die({ code: 'E_USAGE', message: USAGE }, 2);

  let asOf;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--as-of') asOf = rest[++i];
    else return die({ code: 'E_USAGE', message: `${USAGE}; unknown arg: ${rest[i]}` }, 2);
  }
  if (asOf !== undefined && !isValidDate(asOf)) {
    return die({ code: 'E_INVALID_DATE', message: `invalid --as-of date: ${asOf}` });
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return die({ code: 'E_IO', message: `cannot read ${file}` });
  }

  let ledger;
  try {
    ledger = new RefundLedger({ asOf });
  } catch (e) {
    return die({ code: 'E_INVALID_DATE', message: e.message });
  }

  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].trim();
    if (!raw || raw.startsWith('#')) continue;
    let op;
    try {
      op = JSON.parse(raw);
    } catch {
      return die({ code: 'E_INVALID_OP', message: `line ${n + 1}: invalid JSON` });
    }
    const res = applyOp(ledger, op);
    if (!res.ok) {
      // A failed settled-revoke may still emit its optional reverse flow.
      if (res.reversal) out(JSON.stringify(res.reversal) + '\n');
      return die(res.error);
    }
    if (res.record) out(JSON.stringify(res.record) + '\n');
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
