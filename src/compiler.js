const BIN_OPS = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL',
  '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  and: 'AND', or: 'OR',
};

export function compile(program) {
  const code = [];
  const emit = (instr) => { code.push(instr); return code.length - 1; };
  const patch = (idx, addr) => { code[idx].addr = addr; };

  function compileBlock(body) {
    for (const stmt of body) compileStmt(stmt);
  }

  function compileStmt(node) {
    switch (node.kind) {
      case 'Param':
      case 'Let':
        compileExpr(node.kind === 'Param' ? node.value : node.expr);
        emit({ op: 'STORE', name: node.name });
        return;
      case 'For': {
        compileExpr(node.iterable);
        emit({ op: 'ITER_INIT' });
        const iterNext = emit({ op: 'ITER_NEXT', name: node.varName, addr: null });
        compileBlock(node.body);
        emit({ op: 'EXIT_SCOPE' });
        emit({ op: 'JMP', addr: iterNext });
        patch(iterNext, code.length);
        return;
      }
      case 'If': {
        compileExpr(node.cond);
        const jz = emit({ op: 'JZ', addr: null });
        compileBlock(node.then);
        if (node.else) {
          const jmp = emit({ op: 'JMP', addr: null });
          patch(jz, code.length);
          compileBlock(node.else);
          patch(jmp, code.length);
        } else {
          patch(jz, code.length);
        }
        return;
      }
      case 'Reverse': {
        emit({ op: 'SAVEPOINT', label: 'reverse' });
        compileExpr(node.target);
        emit({ op: 'DUP' });
        emit({ op: 'LOCK_CHECK' });
        const jz = emit({ op: 'JZ', addr: null });
        emit({ op: 'COMPENSATE' });
        const jmp = emit({ op: 'JMP', addr: null });
        patch(jz, code.length);
        emit({ op: 'REVERSE' });
        patch(jmp, code.length);
        emit({ op: 'COMMIT' });
        return;
      }
      case 'Cancel': {
        emit({ op: 'SAVEPOINT', label: 'cancel' });
        compileExpr(node.target);
        emit({ op: 'CANCEL' });
        emit({ op: 'COMMIT' });
        return;
      }
      case 'Move': {
        emit({ op: 'SAVEPOINT', label: 'move' });
        compileExpr(node.amount);
        emit({ op: 'PUSH', value: { t: 'account', v: node.from } });
        emit({ op: 'PUSH', value: { t: 'account', v: node.to } });
        emit({ op: 'MOVE' });
        emit({ op: 'COMMIT' });
        return;
      }
      default:
        throw new Error(`cannot compile statement ${node.kind}`);
    }
  }

  function compileExpr(node) {
    switch (node.kind) {
      case 'Num':
        emit({ op: 'PUSH', value: node.isMoney ? { t: 'money', v: node.value } : { t: 'int', v: node.value } });
        return;
      case 'Str': emit({ op: 'PUSH', value: { t: 'string', v: node.value } }); return;
      case 'Bool': emit({ op: 'PUSH', value: { t: 'bool', v: node.value } }); return;
      case 'Status': emit({ op: 'PUSH', value: { t: 'status', v: node.value } }); return;
      case 'Txn': emit({ op: 'PUSH', value: { t: 'txn', v: node.id } }); return;
      case 'Account': emit({ op: 'PUSH', value: { t: 'account', v: node.name } }); return;
      case 'Var': emit({ op: 'LOAD', name: node.name }); return;
      case 'Attr':
        compileExpr(node.obj);
        emit({ op: 'GETATTR', name: node.name });
        return;
      case 'List':
        for (const el of node.elements) compileExpr(el);
        emit({ op: 'LIST', n: node.elements.length });
        return;
      case 'Unary':
        compileExpr(node.expr);
        emit({ op: node.op === 'not' ? 'NOT' : 'NEG' });
        return;
      case 'Bin':
        compileExpr(node.lhs);
        compileExpr(node.rhs);
        emit({ op: BIN_OPS[node.op] });
        return;
      default:
        throw new Error(`cannot compile expression ${node.kind}`);
    }
  }

  compileBlock(program.body);
  emit({ op: 'HALT' });
  return code;
}
