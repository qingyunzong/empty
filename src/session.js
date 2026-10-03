// Session runner shared by the CLI and tests: executes a sequence of
// operations against a fresh Engine and collects one result per operation.

import { Engine } from './engine.js';

export function runSession(ops, engine = new Engine()) {
  const results = [];
  let failed = false;
  for (const op of ops) {
    let res;
    try {
      switch (op.op) {
        case 'invoice':
          res = engine.invoice(op);
          break;
        case 'credit':
          res = engine.credit(op);
          break;
        case 'voidCredit':
          res = engine.voidCredit(op);
          break;
        case 'check':
          res = engine.check(op);
          break;
        case 'verify':
          res = engine.verifyCertificate(op.certificate);
          break;
        default:
          res = { error: 'E_INPUT', message: `unknown op ${JSON.stringify(op.op)}` };
      }
    } catch (e) {
      res = { error: e.code ?? 'E_INPUT', message: e.message };
    }
    if (res.error) failed = true;
    results.push({ op: op.op, ...res });
  }
  return { results, failed };
}

export function parseSession(text) {
  const t = text.trim();
  if (t === '') return [];
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
