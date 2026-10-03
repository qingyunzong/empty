'use strict';

const { JeError } = require('./errors');
const { SCALE } = require('./checker');

const CENT = SCALE / 100; // units per cent

function toCents(units, batchId) {
  if (units < 0) {
    throw new JeError('E_BALANCE', `negative posting amount in batch ${batchId}`);
  }
  return Math.round(units / CENT);
}

function fmt(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function execBatch(def, batchId, event, db, ledger) {
  const stack = [];
  const totals = { dr: 0, cr: 0 };
  const perAccount = new Map(); // `${side}:${account}` -> cents

  for (const ins of def.code) {
    switch (ins.op) {
      case 'BEGIN_BATCH':
        db.beginBatch(batchId, def.period);
        break;
      case 'PUSH':
        stack.push(ins.units);
        break;
      case 'LOAD_EVENT': {
        const v = event == null ? undefined : event[ins.field];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new JeError('E_EVENT', `batch ${batchId}: event field '${ins.field}' is missing or not a number`);
        }
        stack.push(Math.round(v * SCALE));
        break;
      }
      case 'ADD': { const b = stack.pop(); const a = stack.pop(); stack.push(a + b); break; }
      case 'SUB': { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
      case 'MUL': { const b = stack.pop(); const a = stack.pop(); stack.push(Math.round((a * b) / SCALE)); break; }
      case 'DIV': {
        const b = stack.pop(); const a = stack.pop();
        if (b === 0) throw new JeError('E_BALANCE', `division by zero in batch ${batchId}`);
        stack.push(Math.round((a / b) * SCALE));
        break;
      }
      case 'NEG': stack.push(-stack.pop()); break;
      case 'POST_ENTRY': {
        const amounts = new Array(ins.legs.length);
        for (let i = ins.legs.length - 1; i >= 0; i -= 1) {
          amounts[i] = toCents(stack.pop(), batchId);
        }
        const legs = ins.legs.map((l, i) => ({ side: l.side, account: l.account, amount: amounts[i] }));
        db.post(batchId, legs);
        for (const leg of legs) {
          totals[leg.side] += leg.amount;
          const key = `${leg.side}:${leg.account}`;
          perAccount.set(key, (perAccount.get(key) || 0) + leg.amount);
          const signed = leg.side === 'dr' ? leg.amount : -leg.amount;
          ledger.set(leg.account, (ledger.get(leg.account) || 0) + signed);
        }
        break;
      }
      case 'LOAD_TOTAL': {
        const cents = ins.account == null
          ? totals[ins.side]
          : (perAccount.get(`${ins.side}:${ins.account}`) || 0);
        stack.push(cents * CENT);
        break;
      }
      case 'ASSERT_BALANCE': {
        const b = stack.pop();
        const a = stack.pop();
        if (a !== b) {
          throw new JeError('E_BALANCE', `unbalanced batch ${batchId}: dr=${fmt(Math.round(a / CENT))} cr=${fmt(Math.round(b / CENT))}`);
        }
        break;
      }
      case 'END_BATCH':
        db.endBatch(batchId);
        break;
      default:
        throw new Error(`unknown opcode ${ins.op}`);
    }
  }
}

function run(program, events, db) {
  const ledger = new Map(); // in-memory ledger (内存账): account -> cents
  const batches = [];
  let seq = 0;
  for (const event of events) {
    const type = event && typeof event === 'object' ? event.type : undefined;
    for (const def of program.batches) {
      if (def.on && def.on !== type) continue;
      seq += 1;
      const batchId = `${def.name}#${seq}`;
      execBatch(def, batchId, event, db, ledger);
      batches.push(batchId);
    }
  }
  return { batches, ledger };
}

module.exports = { run };
