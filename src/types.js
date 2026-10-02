// Static type checker for DSL expressions.
// Types: Int, Dur (时长), Inst (时刻), Line (产线), Bool.

export class TypeError_ extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'TypeError';
  }
}

const NUMERIC_LIKE = new Set(['Int', 'Dur', 'Inst']);

// tenv: Map name -> 'Int' | 'Dur' | 'Inst' | 'Line' | 'Bool'
export function typeOf(expr, tenv) {
  switch (expr.t) {
    case 'int': return 'Int';
    case 'dur': return 'Dur';
    case 'inst': return 'Inst';
    case 'var': {
      const t = tenv.get(expr.name);
      if (t === undefined) throw new TypeError_(`unknown name '${expr.name}'`);
      return t;
    }
    case 'call': {
      if (expr.name !== 'count' && expr.name !== 'load') {
        throw new TypeError_(`unknown function '${expr.name}' (want count or load)`);
      }
      if (expr.args.length !== 1) throw new TypeError_(`${expr.name} takes exactly 1 argument`);
      const at = typeOf(expr.args[0], tenv);
      if (at !== 'Line') throw new TypeError_(`${expr.name} expects a Line argument, got ${at}`);
      return expr.name === 'count' ? 'Int' : 'Dur';
    }
    case 'un': {
      const t = typeOf(expr.e, tenv);
      if (expr.op === '!') {
        if (t !== 'Bool') throw new TypeError_(`! expects Bool, got ${t}`);
        return 'Bool';
      }
      if (t !== 'Int' && t !== 'Dur') throw new TypeError_(`unary - expects Int or Dur, got ${t}`);
      return t;
    }
    case 'bin': {
      const l = typeOf(expr.l, tenv);
      const r = typeOf(expr.r, tenv);
      switch (expr.op) {
        case '+':
          if (l === 'Dur' && r === 'Dur') return 'Dur';
          if (l === 'Int' && r === 'Int') return 'Int';
          if (l === 'Inst' && r === 'Dur') return 'Inst';
          if (l === 'Dur' && r === 'Inst') return 'Inst';
          throw new TypeError_(`cannot add ${l} and ${r}`);
        case '-':
          if (l === 'Dur' && r === 'Dur') return 'Dur';
          if (l === 'Int' && r === 'Int') return 'Int';
          if (l === 'Inst' && r === 'Dur') return 'Inst';
          if (l === 'Inst' && r === 'Inst') return 'Dur';
          throw new TypeError_(`cannot subtract ${r} from ${l}`);
        case '<': case '<=': case '>': case '>=':
          if (l === r && NUMERIC_LIKE.has(l)) return 'Bool';
          throw new TypeError_(`cannot compare ${l} ${expr.op} ${r}`);
        case '==': case '!=':
          if (l === r) return 'Bool';
          throw new TypeError_(`cannot compare ${l} ${expr.op} ${r}`);
        case '&&': case '||':
          if (l === 'Bool' && r === 'Bool') return 'Bool';
          throw new TypeError_(`${expr.op} expects Bool operands, got ${l} and ${r}`);
        default:
          throw new TypeError_(`unknown operator ${expr.op}`);
      }
    }
    default:
      throw new TypeError_(`unknown expression node ${expr.t}`);
  }
}
