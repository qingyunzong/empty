export class TypeCheckError extends Error {
  constructor(msg) {
    super(`type error: ${msg}`);
    this.name = 'TypeCheckError';
  }
}

const NUMERIC_ORDER = new Set(['int', 'duration', 'instant']);

function binopType(op, a, b) {
  if (op === 'and' || op === 'or') {
    if (a === 'bool' && b === 'bool') return 'bool';
    throw new TypeCheckError(`operator ${op} expects bool operands, got ${a} and ${b}`);
  }
  if (op === '==' || op === '!=') {
    if (a === b) return 'bool';
    throw new TypeCheckError(`operator ${op} expects equal types, got ${a} and ${b}`);
  }
  if (op === '<' || op === '<=' || op === '>' || op === '>=') {
    if (a === b && NUMERIC_ORDER.has(a)) return 'bool';
    throw new TypeCheckError(`operator ${op} expects int/duration/instant operands, got ${a} and ${b}`);
  }
  if (op === '+' || op === '-') {
    if (a === 'int' && b === 'int') return 'int';
    if (a === 'duration' && b === 'duration') return 'duration';
    if (a === 'instant' && b === 'duration') return 'instant';
    if (op === '+' && a === 'duration' && b === 'instant') return 'instant';
    if (op === '-' && a === 'instant' && b === 'instant') return 'duration';
    throw new TypeCheckError(`operator ${op} cannot combine ${a} and ${b}`);
  }
  if (op === '*' || op === '/') {
    if (a === 'int' && b === 'int') return 'int';
    if (op === '*' && a === 'duration' && b === 'int') return 'duration';
    if (op === '*' && a === 'int' && b === 'duration') return 'duration';
    if (op === '/' && a === 'duration' && b === 'int') return 'duration';
    throw new TypeCheckError(`operator ${op} cannot combine ${a} and ${b}`);
  }
  throw new TypeCheckError(`unknown operator ${op}`);
}

// resolve(name) -> type string | null
export function checkExpr(e, resolve) {
  switch (e.kind) {
    case 'int': return 'int';
    case 'dur': return 'duration';
    case 'instant': return 'instant';
    case 'bool': return 'bool';
    case 'ref': {
      const t = resolve(e.name);
      if (!t) throw new TypeCheckError(`unknown name '${e.name}'`);
      return t;
    }
    case 'call': {
      if (e.name !== 'overlap' && e.name !== 'total') {
        throw new TypeCheckError(`unknown function '${e.name}'`);
      }
      if (e.args.length !== 1) throw new TypeCheckError(`${e.name} expects exactly 1 argument`);
      const t = checkExpr(e.args[0], resolve);
      if (t !== 'line') throw new TypeCheckError(`${e.name} expects a line argument, got ${t}`);
      return e.name === 'overlap' ? 'int' : 'duration';
    }
    case 'un': {
      const t = checkExpr(e.e, resolve);
      if (e.op === 'not') {
        if (t !== 'bool') throw new TypeCheckError(`not expects bool, got ${t}`);
        return 'bool';
      }
      if (t === 'int' || t === 'duration') return t;
      throw new TypeCheckError(`unary - expects int/duration, got ${t}`);
    }
    case 'bin': {
      const lt = checkExpr(e.l, resolve);
      const rt = checkExpr(e.r, resolve);
      return binopType(e.op, lt, rt);
    }
    default:
      throw new TypeCheckError(`unknown expression kind ${e.kind}`);
  }
}
