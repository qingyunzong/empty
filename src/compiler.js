export function compile(contract) {
  const classes = new Map();
  for (const cls of contract.classes.values()) {
    const fns = new Map();
    for (const fn of cls.fns.values()) {
      fns.set(fn.name, compileFn(fn, contract.rounding));
    }
    classes.set(cls.name, { name: cls.name, params: cls.params, fns });
  }
  return {
    currency: contract.currency,
    rounding: contract.rounding,
    params: contract.params,
    classes,
  };
}

function compileFn(fn, rounding) {
  const consts = [];
  const code = [];
  let tierSeq = 0;
  const tierStack = [];

  const pushConst = (val) => {
    consts.push(val);
    return consts.length - 1;
  };
  const emit = (instr) => {
    code.push(instr);
    return code.length - 1;
  };

  function genExpr(e) {
    switch (e.kind) {
      case 'lit': {
        const v = e.vtype === 'bool' ? (e.value ? 1n : 0n) : e.value;
        emit({ op: 'PUSH', k: pushConst({ t: e.vtype, v }) });
        return;
      }
      case 'ident': {
        if (e.name === 'it') {
          const top = tierStack[tierStack.length - 1];
          emit({ op: 'LOAD', name: top.temp });
        } else {
          emit({ op: 'LOAD', name: e.name });
        }
        return;
      }
      case 'neg':
        genExpr(e.expr);
        emit({ op: 'NEG' });
        return;
      case 'not':
        genExpr(e.expr);
        emit({ op: 'NOT' });
        return;
      case 'bin': {
        if (e.op === 'and' || e.op === 'or') {
          genExpr(e.l);
          genExpr(e.r);
          emit({ op: e.op === 'and' ? 'AND' : 'OR' });
          return;
        }
        genExpr(e.l);
        genExpr(e.r);
        if (e.op === '+') emit({ op: 'ADD' });
        else if (e.op === '-') emit({ op: 'SUB' });
        else if (e.op === '*') {
          emit({ op: 'MUL' });
          const lt = e.l.t;
          const rt = e.r.t;
          if ((lt === 'money' && rt === 'bps') || (lt === 'bps' && rt === 'money')) {
            emit({ op: 'ROUND', mode: rounding });
          }
        } else {
          emit({ op: 'CMP', cmp: e.op });
        }
        return;
      }
      case 'call': {
        if (e.name === 'clamp') {
          genExpr(e.args[0]);
          genExpr(e.args[1]);
          emit({ op: 'MAX' });
          genExpr(e.args[2]);
          emit({ op: 'MIN' });
          return;
        }
        genExpr(e.args[0]);
        for (let idx = 1; idx < e.args.length; idx += 1) {
          genExpr(e.args[idx]);
          emit({ op: e.name === 'min' ? 'MIN' : 'MAX' });
        }
        return;
      }
      case 'tier': {
        const id = tierSeq;
        tierSeq += 1;
        const temp = `#it${id}`;
        emit({ op: 'TIER_BEGIN', id });
        genExpr(e.on);
        emit({ op: 'STORE', name: temp });
        tierStack.push({ id, temp });
        e.arms.forEach((arm, idx) => {
          const label = arm.cond ? `arm${idx}` : 'else';
          if (arm.cond) {
            genExpr(arm.cond);
            const jmpAt = emit({ op: 'JMP_IF_FALSE', addr: null });
            genExpr(arm.value);
            emit({ op: 'TIER_ACC', id, arm: label });
            code[jmpAt].addr = code.length;
          } else {
            genExpr(arm.value);
            emit({ op: 'TIER_ACC', id, arm: label });
          }
        });
        tierStack.pop();
        emit({ op: 'TIER_END', id });
        return;
      }
      default:
        throw new Error(`cannot compile node kind '${e.kind}'`);
    }
  }

  for (const stmt of fn.body) {
    if (stmt.kind === 'let') {
      genExpr(stmt.expr);
      emit({ op: 'STORE', name: stmt.name });
    } else if (stmt.kind === 'return') {
      genExpr(stmt.expr);
      emit({ op: 'RET' });
    } else if (stmt.kind === 'conserve') {
      genExpr(stmt.left);
      genExpr(stmt.right);
      emit({ op: 'CONSERVE' });
    } else if (stmt.kind === 'allocate') {
      genExpr(stmt.total);
      for (const s of stmt.shares) genExpr(s.expr);
      emit({ op: 'ALLOC', accounts: stmt.shares.map((s) => s.account), residual: stmt.residual });
    }
  }

  return { params: fn.params, retType: fn.retType, consts, code };
}
