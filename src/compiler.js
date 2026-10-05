'use strict';

// Compiles a checked script into flat stack-machine bytecode.

const BIN_OPS = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '%': 'MOD',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
  '==': 'EQ',
  '!=': 'NE',
  '&&': 'AND',
  '||': 'OR',
};

function compileExpr(node, out) {
  switch (node.kind) {
    case 'int':
      out.push({ op: 'PUSH_INT', arg: node.value });
      break;
    case 'float':
      out.push({ op: 'PUSH_FLOAT', arg: node.value });
      break;
    case 'bool':
      out.push({ op: 'PUSH_BOOL', arg: node.value });
      break;
    case 'evidence':
      out.push({ op: 'PUSH_EV', arg: node.value });
      break;
    case 'obs':
      out.push({ op: 'LOAD', arg: node.name });
      break;
    case 'un':
      compileExpr(node.operand, out);
      out.push({ op: node.op === '!' ? 'NOT' : 'NEG' });
      break;
    case 'bin':
      compileExpr(node.left, out);
      compileExpr(node.right, out);
      out.push({ op: BIN_OPS[node.op] });
      break;
    default:
      throw new Error(`cannot compile expression kind: ${node.kind}`);
  }
}

function compileBody(stmts, out) {
  for (const stmt of stmts) {
    if (stmt.kind === 'block') {
      compileBody(stmt.body, out);
    } else if (stmt.kind === 'txn') {
      out.push({ op: 'TXN_BEGIN', arg: stmt.seq });
      for (const st of stmt.body) {
        if (st.kind === 'assign') {
          compileExpr(st.expr, out);
          out.push({ op: 'STORE', arg: st.name });
        } else if (st.kind === 'guard') {
          compileExpr(st.expr, out);
          out.push({ op: 'GUARD' });
        }
      }
      out.push({ op: 'TXN_COMMIT', arg: stmt.seq });
    }
  }
}

function compile(script) {
  const out = [];
  compileBody(script.body, out);
  return out;
}

function formatArg(arg) {
  return typeof arg === 'string' ? JSON.stringify(arg) : String(arg);
}

function dump(instructions) {
  return instructions
    .map(
      (ins, i) =>
        `${String(i).padStart(4, '0')} ${ins.op}${ins.arg === undefined ? '' : ' ' + formatArg(ins.arg)}`
    )
    .join('\n');
}

module.exports = { compile, dump };
