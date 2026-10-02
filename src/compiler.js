// Compiles template AST into flat bytecode for the stack-machine VM.
//
// Ops:
//   { op: 'text', value }                 append literal text
//   { op: 'emit' }                        pop value, stringify, append
//   { op: 'const', value }                push constant
//   { op: 'load', name }                  push variable from scope chain
//   { op: 'field', name }                 pop object, push object[name]
//   { op: 'neg' }                         numeric negation
//   { op: 'arith', operator }             pop b, pop a, push a <op> b
//   { op: 'filter', name, argc }          pop args + value, push filter result
//   { op: 'enter_scope', name }           pop value, push frame { name: value }
//   { op: 'exit_scope' }                  pop frame

function compileExpr(expr, ops) {
  switch (expr.type) {
    case 'num':
    case 'str':
      ops.push({ op: 'const', value: expr.value });
      return;
    case 'var':
      ops.push({ op: 'load', name: expr.name });
      return;
    case 'field':
      compileExpr(expr.object, ops);
      ops.push({ op: 'field', name: expr.name });
      return;
    case 'neg':
      compileExpr(expr.expr, ops);
      ops.push({ op: 'neg' });
      return;
    case 'bin':
      compileExpr(expr.left, ops);
      compileExpr(expr.right, ops);
      ops.push({ op: 'arith', operator: expr.op });
      return;
    case 'filter':
      compileExpr(expr.expr, ops);
      for (const arg of expr.args) compileExpr(arg, ops);
      ops.push({ op: 'filter', name: expr.name, argc: expr.args.length });
      return;
    default:
      throw new Error(`unknown expr node: ${expr.type}`);
  }
}

function compileNodes(nodes, ops) {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        ops.push({ op: 'text', value: node.value });
        break;
      case 'interp':
        compileExpr(node.expr, ops);
        ops.push({ op: 'emit' });
        break;
      case 'scope':
        if (node.init) compileExpr(node.init, ops);
        else ops.push({ op: 'load', name: node.name });
        ops.push({ op: 'enter_scope', name: node.name });
        compileNodes(node.body, ops);
        ops.push({ op: 'exit_scope' });
        break;
      default:
        throw new Error(`unknown template node: ${node.type}`);
    }
  }
}

export function compileTemplate(nodes) {
  const ops = [];
  compileNodes(nodes, ops);
  return ops;
}
