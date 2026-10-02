// Static type checker for evidence-guard scripts.
// Types: int, float, bool, evidence.

export class StaticTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaticTypeError';
  }
}

export const TYPES = new Set(['int', 'float', 'bool', 'evidence']);
const NUMERIC = new Set(['int', 'float']);

export function literalType(value) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (value !== null && typeof value === 'object' && typeof value.evidence === 'string') {
    return 'evidence';
  }
  throw new StaticTypeError(`unsupported literal: ${JSON.stringify(value)}`);
}

function requireNumeric(type, op) {
  if (!NUMERIC.has(type)) {
    throw new StaticTypeError(`operator "${op}" expects numeric operands, got ${type}`);
  }
}

function requireType(type, expected, what) {
  if (type !== expected) {
    throw new StaticTypeError(`${what} expects ${expected}, got ${type}`);
  }
}

const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', 'and', 'or']);
const UNARY_OPS = new Set(['not', 'neg']);

export function typeOfExpr(expr, env) {
  if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) {
    throw new StaticTypeError(`malformed expression: ${JSON.stringify(expr)}`);
  }
  if ('lit' in expr) return literalType(expr.lit);
  if ('var' in expr) {
    const type = env[expr.var];
    if (!type) throw new StaticTypeError(`unknown observation "${expr.var}"`);
    return type;
  }
  if ('op' in expr) {
    const op = expr.op;
    if (UNARY_OPS.has(op)) {
      const arg = typeOfExpr(expr.arg, env);
      if (op === 'not') {
        requireType(arg, 'bool', 'operator "not"');
        return 'bool';
      }
      requireNumeric(arg, op);
      return arg;
    }
    if (BINARY_OPS.has(op)) {
      const left = typeOfExpr(expr.left, env);
      const right = typeOfExpr(expr.right, env);
      switch (op) {
        case '+':
        case '-':
        case '*':
        case '/':
          requireNumeric(left, op);
          requireNumeric(right, op);
          return left === 'float' || right === 'float' ? 'float' : 'int';
        case '%':
          requireType(left, 'int', 'operator "%"');
          requireType(right, 'int', 'operator "%"');
          return 'int';
        case '<':
        case '<=':
        case '>':
        case '>=':
          requireNumeric(left, op);
          requireNumeric(right, op);
          return 'bool';
        case '==':
        case '!=':
          if (left !== right && !(NUMERIC.has(left) && NUMERIC.has(right))) {
            throw new StaticTypeError(`cannot compare ${left} with ${right}`);
          }
          return 'bool';
        case 'and':
        case 'or':
          requireType(left, 'bool', `operator "${op}"`);
          requireType(right, 'bool', `operator "${op}"`);
          return 'bool';
        default:
          throw new StaticTypeError(`unknown operator "${op}"`);
      }
    }
    throw new StaticTypeError(`unknown operator "${op}"`);
  }
  throw new StaticTypeError(`malformed expression: ${JSON.stringify(expr)}`);
}

function checkStatements(body, env, where) {
  if (!Array.isArray(body)) {
    throw new StaticTypeError(`${where}: block body must be an array`);
  }
  for (const stmt of body) {
    if (stmt !== null && typeof stmt === 'object' && 'assign' in stmt) {
      const target = env[stmt.assign];
      if (!target) throw new StaticTypeError(`${where}: unknown observation "${stmt.assign}"`);
      const source = typeOfExpr(stmt.expr, env);
      const ok = source === target || (source === 'int' && target === 'float');
      if (!ok) {
        throw new StaticTypeError(
          `${where}: cannot bind ${source} to ${target} field "${stmt.assign}"`,
        );
      }
    } else if (stmt !== null && typeof stmt === 'object' && 'guard' in stmt) {
      const type = typeOfExpr(stmt.guard, env);
      if (type !== 'bool') {
        throw new StaticTypeError(`${where}: guard must be bool, got ${type}`);
      }
    } else if (stmt !== null && typeof stmt === 'object' && 'block' in stmt) {
      checkStatements(stmt.body, env, `${where}/${stmt.block}`);
    } else {
      throw new StaticTypeError(`${where}: unknown statement ${JSON.stringify(stmt)}`);
    }
  }
}

export function checkScript(script) {
  if (script === null || typeof script !== 'object') {
    throw new StaticTypeError('script must be a JSON object');
  }
  const observations = script.observations ?? {};
  const env = {};
  for (const [name, obs] of Object.entries(observations)) {
    if (obs === null || typeof obs !== 'object' || !TYPES.has(obs.type)) {
      throw new StaticTypeError(`observation "${name}" has invalid type declaration`);
    }
    const valid =
      (obs.type === 'int' && Number.isInteger(obs.value)) ||
      (obs.type === 'float' && typeof obs.value === 'number') ||
      (obs.type === 'bool' && typeof obs.value === 'boolean') ||
      (obs.type === 'evidence' && typeof obs.value === 'string');
    if (!valid) {
      throw new StaticTypeError(
        `observation "${name}" declared ${obs.type} but holds ${JSON.stringify(obs.value)}`,
      );
    }
    env[name] = obs.type;
  }
  if (!Array.isArray(script.transactions)) {
    throw new StaticTypeError('script.transactions must be an array');
  }
  script.transactions.forEach((tx, index) => {
    if (tx === null || typeof tx !== 'object') {
      throw new StaticTypeError(`transaction #${index} must be an object`);
    }
    checkStatements(tx.body ?? [], env, tx.name ?? `tx${index}`);
  });
  return env;
}
