'use strict';

// Independent reference implementation, used ONLY by tests.
// Deliberately written with plain arrays and no shared code with src/,
// so that cross-checking catches bugs on either side.

function clone(instr) {
  return {
    id: instr.id,
    account: instr.account,
    debit: instr.debit,
    credit: instr.credit,
    freeze: instr.freeze,
    state: instr.state,
    currency: instr.currency === undefined ? null : instr.currency,
    memo: instr.memo === undefined ? '' : instr.memo,
  };
}

function replay(instructions, ops) {
  const table = instructions.map(clone);
  const list = Array.isArray(ops) ? ops : ops.ops;
  for (const op of list) {
    if (op.op === 'split') {
      const idx = table.findIndex((i) => i.id === op.id);
      const orig = table[idx];
      const parts = op.parts.map((p) => ({
        id: p.id,
        account: orig.account,
        debit: p.debit === undefined ? 0 : p.debit,
        credit: p.credit === undefined ? 0 : p.credit,
        freeze: p.freeze === undefined ? 0 : p.freeze,
        state: orig.state,
        currency: orig.currency,
        memo: p.memo === undefined ? '' : p.memo,
      }));
      table.splice(idx, 1, ...parts);
    } else if (op.op === 'merge') {
      const members = op.ids.map((id) => table.find((i) => i.id === id));
      const merged = {
        id: op.newId,
        account: members[0].account,
        debit: members.reduce((a, m) => a + m.debit, 0),
        credit: members.reduce((a, m) => a + m.credit, 0),
        freeze: members.reduce((a, m) => a + m.freeze, 0),
        state: members.every((m) => m.state === members[0].state) ? members[0].state : 'PENDING',
        currency: members[0].currency,
        memo: op.memo === undefined ? '' : op.memo,
      };
      for (const id of op.ids) {
        table.splice(table.findIndex((i) => i.id === id), 1);
      }
      table.push(merged);
    } else if (op.op === 'restate') {
      const target = table.find((i) => i.id === op.id);
      for (const key of ['debit', 'credit', 'freeze', 'state', 'memo']) {
        if (key in op.fields) target[key] = op.fields[key];
      }
    } else {
      throw new Error(`reference: unknown op ${op.op}`);
    }
  }
  return table;
}

function canonical(table) {
  return table
    .map(clone)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

module.exports = { replay, canonical };
