// Compile spec constraints and history ops into bytecode for the VM.
// Expression bytecode is a stack machine; op bytecode is one instruction
// per history operation.

export function compileExpr(expr, out = []) {
  switch (expr.type) {
    case 'num': out.push(['CONST', expr.value]); break;
    case 'capacity': out.push(['CAP']); break;
    case 'used': out.push(['USED', expr.strategy]); break;
    case 'quota': out.push(['QUOTA', expr.strategy]); break;
    case 'neg': compileExpr(expr.expr, out); out.push(['NEG']); break;
    case 'bin': {
      compileExpr(expr.left, out);
      compileExpr(expr.right, out);
      const op = {
        '+': 'ADD', '-': 'SUB', '*': 'MUL',
        '<=': 'LE', '<': 'LT', '>=': 'GE', '>': 'GT', '==': 'EQ', '!=': 'NE',
      }[expr.op];
      out.push([op]);
      break;
    }
    default:
      throw new Error(`cannot compile expression node '${expr.type}'`);
  }
  return out;
}

export function compile(spec, ops) {
  const accounts = new Map();
  for (const [name, a] of spec.accounts) {
    accounts.set(name, {
      name,
      capacity: a.capacity,
      quotas: new Map(a.strategies),
      constraints: a.constraints.map(c => compileExpr(c)),
    });
  }
  const instrs = ops.map(op => {
    switch (op.kind) {
      case 'reserve':
        return { code: 'RESERVE', id: op.id, account: op.account, strategy: op.strategy, amount: op.amount };
      case 'confirm':
        return { code: 'CONFIRM', id: op.id, target: op.target };
      case 'release':
        return { code: 'RELEASE', id: op.id, target: op.target };
      default:
        throw new Error(`cannot compile op kind '${op.kind}'`);
    }
  });
  return { accounts, instrs };
}
