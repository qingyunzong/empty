// Compiles constraints and the objective to stack bytecode and, in parallel,
// extracts affine coefficient vectors used by the solver for pruning.
import { Diagnostic } from './lexer.js';
import { MICRO_PER_CNY } from './check.js';

const UNIT_SCALE = { g: 1, kg: 1000, ppm: 1, CNY: MICRO_PER_CNY, '¥': MICRO_PER_CNY };

const show = (e) => {
  switch (e.kind) {
    case 'num':
      return `${e.value}${e.unit ?? ''}`;
    case 'ref':
      return e.name;
    case 'grams':
      return `grams(${e.name})`;
    case 'neg':
      return `(-${show(e.expr)})`;
    case 'bin':
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    default:
      return '?';
  }
};

export function compile(model) {
  const names = model.ingredients.map((i) => i.name);
  const n = names.length;
  const indexOf = new Map(names.map((nm, i) => [nm, i]));
  const price = model.ingredients.map((i) => i.costMicroPerG);
  const allergen = model.ingredients.map((i) => i.allergenPpm);
  const indicatorValue = (name) =>
    model.ingredients.map((ing) => ing.indicators.get(name) ?? 0);
  const T = model.targetG;

  const zeroAff = () => ({ k: 0, c: new Array(n).fill(0) });
  const isConstAff = (a) => a.c.every((x) => x === 0);

  function compileExpr(expr) {
    switch (expr.kind) {
      case 'num': {
        const v = expr.unit ? expr.value * UNIT_SCALE[expr.unit] : expr.value;
        return { code: [['PUSH', v]], aff: { k: v, c: new Array(n).fill(0) } };
      }
      case 'neg': {
        const s = compileExpr(expr.expr);
        return {
          code: [...s.code, ['NEG']],
          aff: { k: -s.aff.k, c: s.aff.c.map((x) => -x) },
        };
      }
      case 'grams': {
        const i = indexOf.get(expr.name);
        const aff = zeroAff();
        aff.c[i] = 1;
        return { code: [['LOAD', i]], aff };
      }
      case 'ref': {
        const aff = zeroAff();
        const code = [];
        if (expr.name === 'cost') {
          for (let i = 0; i < n; i++) {
            code.push(['LOAD', i], ['PUSH', price[i]], ['MUL']);
            if (i > 0) code.push(['ADD']);
            aff.c[i] = price[i];
          }
        } else if (expr.name === 'mass') {
          for (let i = 0; i < n; i++) {
            code.push(['LOAD', i]);
            if (i > 0) code.push(['ADD']);
            aff.c[i] = 1;
          }
        } else {
          const vals = indicatorValue(expr.name);
          for (let i = 0; i < n; i++) {
            code.push(['LOAD', i], ['PUSH', vals[i]], ['MUL']);
            if (i > 0) code.push(['ADD']);
            aff.c[i] = vals[i];
          }
          code.push(['PUSH', T], ['DIV']);
          for (let i = 0; i < n; i++) aff.c[i] /= T;
        }
        return { code, aff };
      }
      case 'bin': {
        const l = compileExpr(expr.left);
        const r = compileExpr(expr.right);
        const code = [...l.code, ...r.code, [expr.op === '+' ? 'ADD' : expr.op === '-' ? 'SUB' : expr.op === '*' ? 'MUL' : 'DIV']];
        if (expr.op === '+') {
          return { code, aff: { k: l.aff.k + r.aff.k, c: l.aff.c.map((x, i) => x + r.aff.c[i]) } };
        }
        if (expr.op === '-') {
          return { code, aff: { k: l.aff.k - r.aff.k, c: l.aff.c.map((x, i) => x - r.aff.c[i]) } };
        }
        if (expr.op === '*') {
          if (isConstAff(l.aff)) {
            return { code, aff: { k: l.aff.k * r.aff.k, c: r.aff.c.map((x) => x * l.aff.k) } };
          }
          if (isConstAff(r.aff)) {
            return { code, aff: { k: l.aff.k * r.aff.k, c: l.aff.c.map((x) => x * r.aff.k) } };
          }
        } else if (isConstAff(r.aff) && r.aff.k !== 0) {
          return { code, aff: { k: l.aff.k / r.aff.k, c: l.aff.c.map((x) => x / r.aff.k) } };
        }
        throw new Diagnostic('expression is not linear in the recipe', expr.line, expr.col, model.file);
      }
      default:
        throw new Diagnostic(`internal: cannot compile '${expr.kind}'`, expr.line, expr.col, model.file);
    }
  }

  const CMP_OPCODE = { '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE', '==': 'EQ' };
  const constraints = [];
  for (const c of model.constraints) {
    if (c.kind === 'range') {
      const vals = indicatorValue(c.indicator);
      const code = [];
      const aff = zeroAff();
      for (let i = 0; i < n; i++) {
        code.push(['LOAD', i], ['PUSH', vals[i]], ['MUL']);
        if (i > 0) code.push(['ADD']);
        aff.c[i] = vals[i] / T;
      }
      code.push(['PUSH', T], ['DIV'], ['RNG', c.loPpm, c.hiPpm]);
      constraints.push({
        kind: 'range',
        desc: `${c.indicator} in [${c.loPpm} ppm, ${c.hiPpm} ppm]`,
        code,
        aff,
        lo: c.loPpm,
        hi: c.hiPpm,
      });
    } else {
      const l = compileExpr(c.left);
      const r = compileExpr(c.right);
      const code = [...l.code, ...r.code, [CMP_OPCODE[c.op]]];
      constraints.push({
        kind: 'cmp',
        op: c.op,
        desc: `${show(c.left)} ${c.op} ${show(c.right)}`,
        code,
        affL: l.aff,
        affR: r.aff,
        aff: {
          k: l.aff.k - r.aff.k,
          c: l.aff.c.map((x, i) => x - r.aff.c[i]),
        },
      });
    }
  }

  const objective = compileExpr({ kind: 'ref', name: 'cost', line: 0, col: 0 });
  const allergenCode = [];
  const allergenAff = zeroAff();
  for (let i = 0; i < n; i++) {
    allergenCode.push(['LOAD', i], ['PUSH', allergen[i]], ['MUL']);
    if (i > 0) allergenCode.push(['ADD']);
    allergenAff.c[i] = allergen[i];
  }

  return {
    file: model.file,
    names,
    n,
    targetG: T,
    stepG: model.stepG,
    capsG: model.ingredients.map((i) => i.stockG),
    priceMicro: price,
    allergenPpm: allergen,
    budgetMicro: model.budgetMicro,
    objectiveCode: objective.code,
    objectiveAff: objective.aff,
    allergenCode,
    allergenAff,
    constraints,
  };
}
