'use strict';

const { parseDecimal } = require('./checker');

// Bytecode instruction set (JSON-serializable):
//   BEGIN_BATCH                       -> notify db, push batch frame
//   PUSH {units}                      -> push constant (integer micro-yuan)
//   LOAD_EVENT {field}                -> push event field as units
//   ADD | SUB | MUL | DIV | NEG       -> arithmetic on units
//   POST_ENTRY {legs:[{side,account}]}-> pop legs.length amounts, emit one posting
//   LOAD_TOTAL {side, account|null}   -> push batch running total (units)
//   ASSERT_BALANCE                    -> pop two, E_BALANCE if unequal
//   END_BATCH                         -> close batch frame

function compileExpr(e, code) {
  switch (e.kind) {
    case 'num':
      code.push({ op: 'PUSH', units: parseDecimal(e.raw) });
      break;
    case 'event':
      code.push({ op: 'LOAD_EVENT', field: e.field });
      break;
    case 'bin':
      compileExpr(e.l, code);
      compileExpr(e.r, code);
      code.push({ op: { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV' }[e.op] });
      break;
    case 'neg':
      compileExpr(e.e, code);
      code.push({ op: 'NEG' });
      break;
    case 'total':
      code.push({ op: 'LOAD_TOTAL', side: e.side, account: e.account });
      break;
    default:
      throw new Error(`cannot compile expression kind ${e.kind}`);
  }
}

function compileBatch(b) {
  const code = [{ op: 'BEGIN_BATCH' }];
  for (const item of b.body) {
    if (item.kind === 'post') {
      for (const leg of item.legs) compileExpr(leg.amount, code);
      code.push({
        op: 'POST_ENTRY',
        legs: item.legs.map((l) => ({ side: l.side, account: l.account })),
      });
    } else if (item.kind === 'balance') {
      compileExpr(item.left, code);
      compileExpr(item.right, code);
      code.push({ op: 'ASSERT_BALANCE' });
    }
  }
  code.push({ op: 'END_BATCH' });
  return { name: b.name, period: b.period, on: b.on, code };
}

function compile(checked) {
  const periods = {};
  for (const [id, p] of checked.periods) periods[id] = p.state;
  return {
    periods,
    batches: checked.batches.map(compileBatch),
  };
}

module.exports = { compile };
