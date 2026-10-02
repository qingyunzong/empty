import { createHash } from 'node:crypto';

const BIN_OPS = {
  and: 'AND', or: 'OR',
  '==': 'EQ', '!=': 'NE',
  '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
};

export function compile(plan, params, source) {
  const code = [];
  const emit = (instr) => { code.push(instr); return code.length - 1; };
  const patch = (idx, fields) => Object.assign(code[idx], fields);
  let spCounter = 0;

  const revIdParam = params.get('rev_id');
  const revId = revIdParam != null
    ? String(revIdParam.v)
    : createHash('sha256').update(source).digest('hex').slice(0, 16);

  function compileBlock(stmts) {
    for (const s of stmts) compileStmt(s);
  }

  function compileStmt(s) {
    switch (s.kind) {
      case 'Let': {
        compileExpr(s.expr);
        emit({ op: 'STORE', name: s.name });
        return;
      }
      case 'When': {
        compileExpr(s.cond);
        const jf = emit({ op: 'JMP_IF_FALSE', target: null });
        compileBlock(s.body);
        patch(jf, { target: code.length });
        return;
      }
      case 'For': {
        if (s.list.kind === 'AllTxns') emit({ op: 'PUSH_ALL_TXNS' });
        else emit({ op: 'PUSH_TXNS', ids: s.list.ids });
        emit({ op: 'ITER_BEGIN' });
        emit({ op: 'ENTER_SCOPE', kind: 'loop' });
        const top = code.length;
        const it = emit({ op: 'ITER_NEXT', name: s.name, end: null });
        emit({ op: 'ENTER_SCOPE', kind: 'txn' });
        compileBlock(s.body);
        emit({ op: 'EXIT_SCOPE' });
        emit({ op: 'JMP', target: top });
        const end = code.length;
        patch(it, { end });
        emit({ op: 'EXIT_SCOPE' });
        emit({ op: 'ITER_END' });
        return;
      }
      case 'Revoke': {
        emit({ op: 'SAVEPOINT', label: `sp${spCounter++}` });
        compileExpr(s.expr);
        emit({ op: 'LOCK_CHECK' });
        const d = emit({ op: 'DISPATCH', targets: null });
        const rAddr = code.length;
        emit({ op: 'REVERSE' });
        const j1 = emit({ op: 'JMP', target: null });
        const cAddr = code.length;
        emit({ op: 'COMPENSATE' });
        const j2 = emit({ op: 'JMP', target: null });
        const xAddr = code.length;
        emit({ op: 'CANCEL_REQUEST' });
        const k = code.length;
        emit({ op: 'COMMIT' });
        patch(j1, { target: k });
        patch(j2, { target: k });
        patch(d, { targets: { reverse: rAddr, compensate: cAddr, cancel: xAddr, skip: k } });
        return;
      }
      default:
        throw new Error(`cannot compile statement kind ${s.kind}`);
    }
  }

  function compileExpr(e) {
    switch (e.kind) {
      case 'Number': emit({ op: 'PUSH', value: { t: 'Number', v: e.value } }); return;
      case 'Amount': emit({ op: 'PUSH', value: { t: 'Amount', v: e.value } }); return;
      case 'String': emit({ op: 'PUSH', value: { t: 'String', v: e.value } }); return;
      case 'Bool': emit({ op: 'PUSH', value: { t: 'Bool', v: e.value } }); return;
      case 'Status': emit({ op: 'PUSH', value: { t: 'Status', v: e.value } }); return;
      case 'Txn': emit({ op: 'PUSH', value: { t: 'Txn', v: e.value } }); return;
      case 'Acct': emit({ op: 'PUSH', value: { t: 'Acct', v: e.value } }); return;
      case 'Ident': {
        const p = params.get(e.name);
        if (p) emit({ op: 'PUSH', value: p });
        else emit({ op: 'LOAD', name: e.name });
        return;
      }
      case 'Field': {
        compileExpr(e.obj);
        emit({ op: 'LOAD_FIELD', field: e.name });
        return;
      }
      case 'Unary': {
        compileExpr(e.expr);
        emit({ op: e.op === 'not' ? 'NOT' : 'NEG' });
        return;
      }
      case 'Binary': {
        compileExpr(e.left);
        compileExpr(e.right);
        emit({ op: BIN_OPS[e.op] });
        return;
      }
      default:
        throw new Error(`cannot compile expression kind ${e.kind}`);
    }
  }

  compileBlock(plan.body);
  emit({ op: 'HALT' });
  return { code, revId, params: Object.fromEntries(params) };
}
