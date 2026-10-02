// Compiles the checked program into a flat bytecode state machine.
// Opcodes: CONST, LOAD, NOT, AND, OR, EQ, NE, LT, LE, GT, GE.

const CMP_OPCODE = { '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE' };

function compileExpr(node, code) {
  switch (node.kind) {
    case 'bool':
    case 'duration':
      code.push({ op: 'CONST', arg: node.value });
      break;
    case 'enumLit':
      code.push({ op: 'CONST', arg: node.name });
      break;
    case 'ref':
      code.push({ op: 'LOAD', arg: node.index });
      break;
    case 'not':
      compileExpr(node.expr, code);
      code.push({ op: 'NOT' });
      break;
    case 'and':
    case 'or':
      compileExpr(node.left, code);
      compileExpr(node.right, code);
      code.push({ op: node.kind.toUpperCase() });
      break;
    case 'cmp':
      compileExpr(node.left, code);
      compileExpr(node.right, code);
      code.push({ op: CMP_OPCODE[node.op] });
      break;
    default:
      throw new Error(`cannot compile expression kind '${node.kind}'`);
  }
}

function compileGuard(expr) {
  const code = [];
  compileExpr(expr, code);
  return code;
}

export function exprToString(node) {
  switch (node.kind) {
    case 'bool': return String(node.value);
    case 'duration': return `${node.value}ms`;
    case 'enumLit': return node.name;
    case 'name': return node.name;
    case 'ref': return node.name;
    case 'not': return `not ${exprToString(node.expr)}`;
    case 'and':
    case 'or': return `(${exprToString(node.left)} ${node.kind} ${exprToString(node.right)})`;
    case 'cmp': return `(${exprToString(node.left)} ${node.op} ${exprToString(node.right)})`;
    default: return '?';
  }
}

export function compile(checked) {
  return {
    signals: checked.signals.map((s) => ({
      name: s.name,
      label: s.label,
      kind: s.kind,
      type: s.type,
      init: s.init,
      index: s.index,
    })),
    rules: checked.rules.map((r) => ({
      name: r.name,
      guard: compileGuard(r.guard),
      targetIndex: r.targetIndex,
      value: r.value,
    })),
    invariants: checked.invariants.map((inv) => ({
      code: compileGuard(inv.expr),
      text: exprToString(inv.expr),
    })),
  };
}
