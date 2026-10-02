import { DiagnosticError } from './errors.js';
import { UNITS } from './lexer.js';

export const ALERT_LEVELS = new Set(['info', 'warning', 'critical']);

// Static type checking: declared fields, unit consistency, alert levels,
// lexically scoped let-aliases (rule-local scope shadows the global scope).
// Returns { fields: Map<name, unit>, groups: Map<name, pattern>, rules: [...] }.
export function check(program) {
  const errors = [];
  const fail = (msg, node) => errors.push(new DiagnosticError(msg, {
    phase: 'check', line: node.line ?? null, col: node.col ?? null,
  }));

  const fields = new Map();
  const groups = new Map();
  const globalScope = new Map(); // alias name -> type

  // Pass 1: field and group declarations (usable from anywhere).
  for (const decl of program.decls) {
    if (decl.kind === 'field') {
      if (!UNITS.has(decl.unit)) {
        errors.push(new DiagnosticError(
          `unknown unit "${decl.unit}" (supported: ${[...UNITS].join(', ')})`,
          { phase: 'check', line: decl.unitLine, col: decl.unitCol }));
        continue;
      }
      if (fields.has(decl.name)) fail(`duplicate field "${decl.name}"`, decl);
      else fields.set(decl.name, decl.unit);
    } else if (decl.kind === 'group') {
      if (groups.has(decl.name)) fail(`duplicate group "${decl.name}"`, decl);
      else groups.set(decl.name, decl.pattern);
    }
  }

  // Expression typing. Returns { sort: 'num', unit } | { sort: 'bool' } | null.
  function typeOf(expr, scope) {
    switch (expr.kind) {
      case 'number':
        return { sort: 'num', unit: expr.unit };
      case 'ident': {
        if (fields.has(expr.name)) return { sort: 'num', unit: fields.get(expr.name) };
        if (scope.has(expr.name)) return scope.get(expr.name);
        fail(`undeclared field or alias "${expr.name}"`, expr);
        return null;
      }
      case 'not': {
        const t = typeOf(expr.operand, scope);
        if (t && t.sort !== 'bool') fail('"not" expects a boolean operand', expr);
        return { sort: 'bool' };
      }
      case 'logic': {
        const l = typeOf(expr.left, scope);
        const r = typeOf(expr.right, scope);
        if (l && l.sort !== 'bool') fail(`"${expr.op}" expects boolean operands`, expr.left);
        if (r && r.sort !== 'bool') fail(`"${expr.op}" expects boolean operands`, expr.right);
        return { sort: 'bool' };
      }
      case 'compare': {
        const l = typeOf(expr.left, scope);
        const r = typeOf(expr.right, scope);
        if (l && l.sort !== 'num') fail('comparison left side must be numeric', expr.left);
        if (r && r.sort !== 'num') fail('comparison right side must be numeric', expr.right);
        if (l?.sort === 'num' && r?.sort === 'num' && l.unit && r.unit && l.unit !== r.unit) {
          fail(`unit mismatch: cannot compare ${l.unit} with ${r.unit}`, expr);
        }
        return { sort: 'bool' };
      }
      case 'hold': {
        const t = typeOf(expr.operand, scope);
        if (t && t.sort !== 'bool') fail('"for" expects a boolean (comparison) operand', expr);
        return { sort: 'bool' };
      }
      default:
        fail(`unknown expression kind "${expr.kind}"`, expr);
        return null;
    }
  }

  // Pass 2: global lets in order (lexical scope, no forward references).
  for (const decl of program.decls) {
    if (decl.kind !== 'let') continue;
    const t = typeOf(decl.expr, globalScope);
    if (globalScope.has(decl.name)) fail(`duplicate alias "${decl.name}"`, decl);
    else if (t) globalScope.set(decl.name, t);
  }

  // Pass 3: rules.
  const ruleNames = new Set();
  for (const decl of program.decls) {
    if (decl.kind !== 'rule') continue;
    if (ruleNames.has(decl.name)) fail(`duplicate rule "${decl.name}"`, decl);
    ruleNames.add(decl.name);

    if (decl.target.kind === 'name' && !groups.has(decl.target.name)) {
      // An unknown target name is treated as a literal device ID.
      decl.target = { kind: 'device', id: decl.target.name, line: decl.target.line, col: decl.target.col };
    }

    // Rule-local lexical scope: a fresh child scope over the globals.
    const scope = new Map(globalScope);
    for (const stmt of decl.body) {
      if (stmt.kind === 'let') {
        const t = typeOf(stmt.expr, scope);
        if (scope.has(stmt.name) && !globalScope.has(stmt.name)) {
          fail(`duplicate alias "${stmt.name}"`, stmt);
        } else if (t) {
          scope.set(stmt.name, t); // may shadow a global alias
        }
      } else if (stmt.kind === 'alert') {
        if (!ALERT_LEVELS.has(stmt.level)) {
          errors.push(new DiagnosticError(
            `unknown alert level "${stmt.level}" (expected one of: ${[...ALERT_LEVELS].join(', ')})`,
            { phase: 'check', line: stmt.levelLine, col: stmt.levelCol }));
        }
        const t = typeOf(stmt.expr, scope);
        if (t && t.sort !== 'bool') fail('alert condition must be boolean', stmt);
      }
    }
  }

  if (errors.length) throw errors;
  return { fields, groups };
}
