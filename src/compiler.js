// 编译 AST -> 字节码 (语句 op 序列, 表达式为后缀指令数组)
export function compile(ast) {
  const ops = [];

  function emitExpr(node, out) {
    switch (node.k) {
      case 'num':
      case 'str':
      case 'bool':
      case 'date':
        out.push(['const', node.v]);
        return;
      case 'regex':
        out.push(['regex', node.source, node.flags]);
        return;
      case 'var':
        out.push(['load', node.name]);
        return;
      case 'amount':
        out.push(['amount']);
        return;
      case 'note':
        out.push(['note']);
        return;
      case 'builtin':
        out.push(['builtin', node.fn, node.bucket]);
        return;
      case 'un':
        emitExpr(node.e, out);
        out.push(['un', node.op]);
        return;
      case 'bin':
        emitExpr(node.l, out);
        emitExpr(node.r, out);
        out.push(['bin', node.op]);
        return;
      default:
        throw new Error(`cannot compile expression kind '${node.k}'`);
    }
  }

  const compileExpr = (node) => {
    const code = [];
    emitExpr(node, code);
    return code;
  };

  function emit(stmts) {
    for (const s of stmts) {
      switch (s.k) {
        case 'customer':
          ops.push({ op: 'customer', id: s.id });
          break;
        case 'note_whitelist':
          ops.push({ op: 'note_whitelist', source: s.source, flags: s.flags });
          break;
        case 'validity':
          ops.push({ op: 'validity', from: s.from, to: s.to });
          break;
        case 'bucket':
          ops.push({ op: 'bucket', name: s.name, limit: s.limitValue });
          break;
        case 'scope':
          ops.push({ op: 'push_scope', name: s.name });
          emit(s.body);
          ops.push({ op: 'pop_scope' });
          break;
        case 'cap':
          ops.push({ op: 'cap', bucket: s.bucket, value: s.capValue });
          break;
        case 'decl':
          ops.push({ op: 'decl_var', name: s.name, mutable: s.mutable, expr: compileExpr(s.expr) });
          break;
        case 'set':
          ops.push({ op: 'set_var', name: s.name, expr: compileExpr(s.expr) });
          break;
        case 'guard':
          ops.push({
            op: 'guard',
            target: s.target,
            clauses: s.clauses.map((c) => ({ mode: c.mode, expr: compileExpr(c.expr) })),
          });
          break;
        default:
          throw new Error(`cannot compile statement kind '${s.k}'`);
      }
    }
  }

  emit(ast.body);
  return ops;
}
