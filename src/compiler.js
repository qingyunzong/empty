// Compiles checked rule expressions into stack-machine bytecode for the VM.
//
// Instruction set:
//   { op: 'PUSH', value }            push a numeric constant
//   { op: 'LOAD', field }            push last-known value of a field (or null)
//   { op: 'GT'|'GE'|'LT'|'LE'|'EQ'|'NE' }
//   { op: 'AND' } { op: 'OR' } { op: 'NOT' }
//   { op: 'HOLD', duration, slot }   true iff input held continuously for duration ms

const CMP_OP = { '>': 'GT', '>=': 'GE', '<': 'LT', '<=': 'LE', '==': 'EQ', '!=': 'NE' };

export function compile(program, { fields, groups }) {
  const rules = [];
  for (const decl of program.decls) {
    if (decl.kind !== 'rule') continue;
    const target = compileTarget(decl.target, groups);
    for (const stmt of decl.body) {
      if (stmt.kind !== 'alert') continue;
      const code = [];
      const holds = [];
      emitExpr(stmt.expr, code, holds);
      rules.push({
        name: decl.name,
        level: stmt.level,
        target,
        code,
        exprAst: stmt.expr,
        holdCount: holds.length,
        holdDurations: holds.map((h) => h.duration),
        line: stmt.line,
        col: stmt.col,
      });
    }
  }
  return { fields, groups, rules };
}

function compileTarget(target, groups) {
  switch (target.kind) {
    case 'all': return { kind: 'all' };
    case 'regex': return { kind: 'regex', pattern: target.pattern, re: new RegExp(target.pattern) };
    case 'device': return { kind: 'device', id: target.id };
    case 'name': { // resolved by the checker to a declared group
      const pattern = groups.get(target.name);
      return { kind: 'regex', pattern, re: new RegExp(pattern), group: target.name };
    }
    default: throw new Error(`unknown target kind ${target.kind}`);
  }
}

function emitExpr(expr, code, holds) {
  switch (expr.kind) {
    case 'number':
      code.push({ op: 'PUSH', value: expr.value });
      return;
    case 'ident':
      // After resolveAliases, remaining identifiers are declared fields.
      code.push({ op: 'LOAD', field: expr.name });
      return;
    case 'compare':
      emitOperand(expr.left, code, holds);
      emitOperand(expr.right, code, holds);
      code.push({ op: CMP_OP[expr.op] });
      return;
    case 'logic':
      emitExpr(expr.left, code, holds);
      emitExpr(expr.right, code, holds);
      code.push({ op: expr.op === 'and' ? 'AND' : 'OR' });
      return;
    case 'not':
      emitExpr(expr.operand, code, holds);
      code.push({ op: 'NOT' });
      return;
    case 'hold': {
      emitExpr(expr.operand, code, holds);
      const slot = holds.length;
      holds.push({ duration: expr.duration });
      code.push({ op: 'HOLD', duration: expr.duration, slot });
      return;
    }
    default:
      throw new Error(`cannot compile expression kind ${expr.kind}`);
  }
}

// Numeric operands: fields load from the device state, constants push.
// Aliases to quantities were substituted by resolveAliases below.
function emitOperand(expr, code, holds) {
  emitExpr(expr, code, holds);
}

// Resolves let-aliases to their definitions (copying AST nodes) so the
// compiler only sees fields and constants. Honors lexical scoping exactly
// like the checker: global lets in order, then rule-local lets shadowing them.
export function resolveAliases(program) {
  const resolve = (expr, scope) => {
    switch (expr.kind) {
      case 'number': return expr;
      case 'ident':
        if (scope.has(expr.name)) return scope.get(expr.name);
        return expr; // a field reference
      case 'not': return { ...expr, operand: resolve(expr.operand, scope) };
      case 'logic': return { ...expr, left: resolve(expr.left, scope), right: resolve(expr.right, scope) };
      case 'compare': return { ...expr, left: resolve(expr.left, scope), right: resolve(expr.right, scope) };
      case 'hold': return { ...expr, operand: resolve(expr.operand, scope) };
      default: throw new Error(`cannot resolve ${expr.kind}`);
    }
  };
  const globalScope = new Map();
  for (const decl of program.decls) {
    // Store fully-resolved expressions so aliases of aliases expand completely.
    if (decl.kind === 'let') globalScope.set(decl.name, resolve(decl.expr, globalScope));
  }
  for (const decl of program.decls) {
    if (decl.kind !== 'rule') continue;
    const scope = new Map(globalScope);
    for (const stmt of decl.body) {
      if (stmt.kind === 'let') scope.set(stmt.name, resolve(stmt.expr, scope));
      else if (stmt.kind === 'alert') stmt.expr = resolve(stmt.expr, scope);
    }
  }
  return program;
}
