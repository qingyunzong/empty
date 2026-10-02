export const Op = Object.freeze({
  CONST: 'CONST',
  LOAD: 'LOAD',
  FIELD: 'FIELD',
  ADD: 'ADD',
  SUB: 'SUB',
  MUL: 'MUL',
  DIV: 'DIV',
  MOD: 'MOD',
  NEG: 'NEG',
  FILTER: 'FILTER',
  EMIT: 'EMIT',
  TEXT: 'TEXT',
  PUSH_SCOPE: 'PUSH_SCOPE',
  POP_SCOPE: 'POP_SCOPE',
});

const BINARY_OP = Object.freeze({
  '+': Op.ADD,
  '-': Op.SUB,
  '*': Op.MUL,
  '/': Op.DIV,
  '%': Op.MOD,
});

export function compile(nodes) {
  const program = [];
  compileNodes(nodes, program);
  return Object.freeze(program);
}

function compileNodes(nodes, program) {
  for (const node of nodes) {
    if (node.type === 'text') {
      program.push({ op: Op.TEXT, value: node.value });
    } else if (node.type === 'output') {
      compileExpr(node.expr, program);
      program.push({ op: Op.EMIT });
    } else if (node.type === 'scope') {
      compileExpr(node.expr, program);
      program.push({ op: Op.PUSH_SCOPE });
      compileNodes(node.body, program);
      program.push({ op: Op.POP_SCOPE });
    }
  }
}

function compileExpr(expr, program) {
  switch (expr.kind) {
    case 'literal':
      program.push({ op: Op.CONST, value: expr.value });
      return;
    case 'var':
      program.push({ op: Op.LOAD, name: expr.name });
      return;
    case 'field':
      compileExpr(expr.object, program);
      program.push({ op: Op.FIELD, name: expr.name });
      return;
    case 'binary':
      compileExpr(expr.left, program);
      compileExpr(expr.right, program);
      program.push({ op: BINARY_OP[expr.op] });
      return;
    case 'negate':
      compileExpr(expr.expr, program);
      program.push({ op: Op.NEG });
      return;
    case 'filter':
      compileExpr(expr.input, program);
      for (const arg of expr.args) compileExpr(arg, program);
      program.push({ op: Op.FILTER, name: expr.name, argc: expr.args.length });
      return;
    default:
      throw new Error(`unknown expression kind "${expr.kind}"`);
  }
}
