// Compiles a statically checked script into stack-based bytecode.

const BINARY = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '%': 'MOD',
  '==': 'EQ',
  '!=': 'NE',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
  and: 'AND',
  or: 'OR',
};

export function compile(script) {
  const code = [];
  const transactions = [];
  script.transactions.forEach((tx, index) => {
    const name = tx.name ?? `tx${index}`;
    const start = code.length;
    code.push({ op: 'BEGIN_TX', name });
    compileBody(tx.body ?? [], code);
    code.push({ op: 'COMMIT', name });
    transactions.push({ name, start, code: code.slice(start) });
  });
  return { transactions, code };
}

function compileBody(body, code) {
  for (const stmt of body) {
    if ('assign' in stmt) {
      compileExpr(stmt.expr, code);
      code.push({ op: 'STORE', name: stmt.assign });
    } else if ('guard' in stmt) {
      compileExpr(stmt.guard, code);
      code.push({ op: 'GUARD' });
    } else if ('block' in stmt) {
      compileBody(stmt.body, code);
    }
  }
}

function compileExpr(expr, code) {
  if ('lit' in expr) {
    code.push({ op: 'PUSH', value: expr.lit });
    return;
  }
  if ('var' in expr) {
    code.push({ op: 'LOAD', name: expr.var });
    return;
  }
  if (expr.op === 'not') {
    compileExpr(expr.arg, code);
    code.push({ op: 'NOT' });
    return;
  }
  if (expr.op === 'neg') {
    compileExpr(expr.arg, code);
    code.push({ op: 'NEG' });
    return;
  }
  compileExpr(expr.left, code);
  compileExpr(expr.right, code);
  code.push({ op: BINARY[expr.op] });
}

function formatLiteral(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object' && 'evidence' in value) {
    return `evidence(${JSON.stringify(value.evidence)})`;
  }
  return JSON.stringify(value);
}

export function dump(code) {
  return code
    .map((ins, index) => {
      const num = String(index + 1).padStart(4, '0');
      switch (ins.op) {
        case 'PUSH':
          return `${num} PUSH ${formatLiteral(ins.value)}`;
        case 'LOAD':
          return `${num} LOAD ${ins.name}`;
        case 'STORE':
          return `${num} STORE ${ins.name}`;
        case 'BEGIN_TX':
          return `${num} BEGIN_TX ${ins.name}`;
        case 'COMMIT':
          return `${num} COMMIT ${ins.name}`;
        default:
          return `${num} ${ins.op}`;
      }
    })
    .join('\n');
}
