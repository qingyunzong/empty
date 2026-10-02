// Compiles the checked program into bytecode for the stack VM.
//
// Instruction set:
//   PUSH_NUM  {value}            push constant
//   PUSH_ARG  {name}             push value-parameter binding
//   PUSH_TOTAL{side}             push running debit/credit total
//   ADD|SUB|MUL|DIV              binary arithmetic on stack
//   DEBIT|CREDIT {account}       account = {literal} or {param}; pops amount
//   CHECK_BALANCE                pops residual, must be ~0
//   POST      {batch,seq,period} flush pending entry through the store
//   BEGIN_BATCH {id,period} / END_BATCH {id}

export function compile(checked) {
  const templates = new Map();
  for (const [name, t] of checked.templates) {
    const code = [];
    for (const stmt of t.body) {
      if (stmt.type === 'debit' || stmt.type === 'credit') {
        code.push(...compileExpr(stmt.expr, false));
        const account = t.kinds.get(stmt.account) === 'account'
          ? { param: stmt.account }
          : { literal: stmt.account };
        code.push({ op: stmt.type === 'debit' ? 'DEBIT' : 'CREDIT', account });
      } else if (stmt.type === 'balance') {
        code.push(...compileExpr(stmt.expr, true));
        code.push({ op: 'CHECK_BALANCE' });
      }
    }
    if (!t.hasExplicitBalance) {
      code.push({ op: 'PUSH_TOTAL', side: 'debit' });
      code.push({ op: 'PUSH_TOTAL', side: 'credit' });
      code.push({ op: 'SUB' });
      code.push({ op: 'CHECK_BALANCE' });
    }
    templates.set(name, { name, params: t.params, kinds: t.kinds, code });
  }
  return { periods: checked.periods, templates, batches: checked.batches };
}

function compileExpr(expr, inBalance) {
  switch (expr.kind) {
    case 'num': return [{ op: 'PUSH_NUM', value: expr.value }];
    case 'param': return [{ op: 'PUSH_ARG', name: expr.name }];
    case 'total': return [{ op: 'PUSH_TOTAL', side: expr.side }];
    case 'bin': {
      if (expr.op === '==') {
        return [...compileExpr(expr.left, inBalance), ...compileExpr(expr.right, inBalance), { op: 'SUB' }];
      }
      const op = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV' }[expr.op];
      return [...compileExpr(expr.left, inBalance), ...compileExpr(expr.right, inBalance), { op }];
    }
    default: throw new Error(`cannot compile expression kind '${expr.kind}'`);
  }
}
