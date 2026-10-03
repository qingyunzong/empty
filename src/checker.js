// Static checker: known fields, unit compatibility, alert levels,
// let-alias lexical scoping, non-empty device groups.

export class CheckError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'CheckError';
    this.line = line;
    this.col = col;
  }
}

export const FIELDS = Object.freeze({
  temp: { unit: 'C' },
  current: { unit: 'A' },
});

export const LEVELS = Object.freeze(new Set(['info', 'warning', 'critical']));

const fail = (msg, node) => { throw new CheckError(msg, node.line, node.col); };

// exprType: { kind: 'bool' } | { kind: 'num', unit: 'C' | 'A' | null }

function checkConstExpr(expr, scope) {
  if (expr.kind === 'num') return { value: expr.value, unit: expr.unit };
  if (expr.kind === 'ident') {
    const binding = scope.get(expr.name);
    if (!binding) fail(`unknown name '${expr.name}' in let (aliases must refer to constants)`, expr);
    return binding;
  }
  fail('let value must be a constant (e.g. let limit = 80C)', expr);
}

function checkExpr(expr, scope) {
  switch (expr.kind) {
    case 'num':
      expr.resolved = { kind: 'const', value: expr.value, unit: expr.unit };
      return { kind: 'num', unit: expr.unit };
    case 'ident': {
      const binding = scope.get(expr.name);
      if (binding) {
        expr.resolved = { kind: 'const', value: binding.value, unit: binding.unit };
        return { kind: 'num', unit: binding.unit };
      }
      const field = FIELDS[expr.name];
      if (field) {
        expr.resolved = { kind: 'field', field: expr.name, unit: field.unit };
        return { kind: 'num', unit: field.unit };
      }
      fail(`undeclared field or alias '${expr.name}'`, expr);
      break;
    }
    case 'cmp': {
      const lt = checkExpr(expr.left, scope);
      const rt = checkExpr(expr.right, scope);
      if (lt.kind !== 'num' || rt.kind !== 'num') {
        fail(`comparison '${expr.op}' requires numeric operands`, expr);
      }
      if (lt.unit && rt.unit && lt.unit !== rt.unit) {
        fail(`unit mismatch: cannot compare ${lt.unit} with ${rt.unit}`, expr);
      }
      return { kind: 'bool' };
    }
    case 'and':
    case 'or': {
      const lt = checkExpr(expr.left, scope);
      const rt = checkExpr(expr.right, scope);
      if (lt.kind !== 'bool' || rt.kind !== 'bool') {
        fail(`'${expr.kind}' requires boolean operands`, expr);
      }
      return { kind: 'bool' };
    }
    case 'not': {
      const t = checkExpr(expr.expr, scope);
      if (t.kind !== 'bool') fail(`'not' requires a boolean operand`, expr);
      return { kind: 'bool' };
    }
    case 'for': {
      const t = checkExpr(expr.expr, scope);
      if (t.kind !== 'bool') fail(`'for' requires a boolean condition`, expr);
      if (!(expr.ms > 0)) fail(`'for' duration must be positive`, expr);
      return { kind: 'bool' };
    }
    default:
      fail(`unsupported expression '${expr.kind}'`, expr);
  }
}

export function check(program) {
  // Lexical scope: a single top-level scope chain processed in order.
  // A later `let` shadows an earlier binding for subsequent statements only;
  // each rule captures the scope as it exists at its definition point.
  const scope = new Map();
  const rules = [];
  const ruleNames = new Set();

  for (const stmt of program.statements) {
    if (stmt.kind === 'let') {
      scope.set(stmt.name, checkConstExpr(stmt.expr, scope));
      continue;
    }
    if (stmt.kind === 'rule') {
      if (ruleNames.has(stmt.name)) {
        fail(`duplicate rule name '${stmt.name}'`, stmt);
      }
      ruleNames.add(stmt.name);
      if (!LEVELS.has(stmt.level.value)) {
        fail(`unknown alert level '${stmt.level.value}' (expected info, warning or critical)`, stmt.level);
      }
      const { idents, regexes } = stmt.devices;
      if (idents.length === 0 && regexes.length === 0) {
        fail(`empty device group in rule '${stmt.name}'`, stmt.devices);
      }
      const compiled = {
        kind: 'rule',
        name: stmt.name,
        level: stmt.level.value,
        devices: {
          idents: idents.map((d) => d.value),
          regexes: regexes.map((r) => new RegExp(r.value)),
        },
        expr: stmt.expr,
        line: stmt.line,
        col: stmt.col,
      };
      const t = checkExpr(stmt.expr, scope);
      if (t.kind !== 'bool') {
        fail(`rule '${stmt.name}' condition must be boolean`, stmt.expr);
      }
      rules.push(compiled);
      continue;
    }
    fail(`unsupported statement '${stmt.kind}'`, stmt);
  }

  if (rules.length === 0) {
    throw new CheckError('no alert rules defined', 1, 1);
  }
  return { rules };
}
