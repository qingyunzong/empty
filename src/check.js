// Static checking: lexical-scope macro expansion (no recursive expansion),
// dimensional analysis, and constant evaluation into base units
// (grams, ppm, micro-CNY).
import { Diagnostic } from './lexer.js';

export const MICRO_PER_CNY = 1_000_000;

const UNIT_TABLE = {
  g: { dim: { m: 1 }, scale: 1 },
  kg: { dim: { m: 1 }, scale: 1000 },
  ppm: { dim: { c: 1 }, scale: 1 },
  CNY: { dim: { $: 1 }, scale: MICRO_PER_CNY },
  '¥': { dim: { $: 1 }, scale: MICRO_PER_CNY },
};

const dimKey = (d) => `m${d.m ?? 0},c${d.c ?? 0},$${d.$ ?? 0}`;
const DIM_NONE = {};
const DIM_MASS = { m: 1 };
const DIM_CONC = { c: 1 };
const DIM_CURR = { $: 1 };
const DIM_PRICE = { m: -1, $: 1 };
const ALLOWED_DIMS = new Set(
  [DIM_NONE, DIM_MASS, DIM_CONC, DIM_CURR, DIM_PRICE].map(dimKey),
);
const DIM_LABEL = new Map([
  [dimKey(DIM_NONE), 'dimensionless'],
  [dimKey(DIM_MASS), 'mass'],
  [dimKey(DIM_CONC), 'concentration'],
  [dimKey(DIM_CURR), 'currency'],
  [dimKey(DIM_PRICE), 'currency/mass'],
]);
const dimLabel = (d) => DIM_LABEL.get(dimKey(d)) ?? `unsupported(${dimKey(d)})`;
const dimMul = (a, b) => ({
  m: (a.m ?? 0) + (b.m ?? 0),
  c: (a.c ?? 0) + (b.c ?? 0),
  $: (a.$ ?? 0) + (b.$ ?? 0),
});
const dimDiv = (a, b) => ({
  m: (a.m ?? 0) - (b.m ?? 0),
  c: (a.c ?? 0) - (b.c ?? 0),
  $: (a.$ ?? 0) - (b.$ ?? 0),
});

export function check(program, file = '<input>') {
  const err = (msg, node) => {
    throw new Diagnostic(msg, node.line, node.col, file);
  };

  // ---- collect ingredients and indicator names ---------------------------
  const ingredientDecls = new Map();
  for (const st of program.body) {
    if (st.kind !== 'ingredient') continue;
    if (ingredientDecls.has(st.name)) {
      err(`duplicate ingredient '${st.name}'`, st);
    }
    ingredientDecls.set(st.name, st);
  }
  const indicatorNames = new Set();
  for (const decl of ingredientDecls.values()) {
    for (const it of decl.items) {
      if (it.kind === 'prop' && it.prop === 'indicator') indicatorNames.add(it.name);
    }
  }

  // ---- lexical scopes: one scope per block, macros visible block-wide ----
  const globalScope = { parent: null, defs: new Map() };
  const registerMacros = (items, scope) => {
    for (const it of items) {
      if (it.kind !== 'macro') continue;
      if (scope.defs.has(it.name)) err(`duplicate macro '${it.name}'`, it);
      scope.defs.set(it.name, { expr: it.expr, defScope: scope });
    }
  };
  registerMacros(program.body, globalScope);
  const ingredientScopes = new Map();
  for (const decl of ingredientDecls.values()) {
    const scope = { parent: globalScope, defs: new Map() };
    registerMacros(decl.items, scope);
    ingredientScopes.set(decl.name, scope);
  }
  const lookupMacro = (scope, name) => {
    for (let s = scope; s; s = s.parent) {
      if (s.defs.has(name)) return s.defs.get(name);
    }
    return null;
  };

  // ---- macro expansion with cycle detection ------------------------------
  function expand(expr, scope, stack) {
    switch (expr.kind) {
      case 'num':
        return expr;
      case 'neg':
        return { ...expr, expr: expand(expr.expr, scope, stack) };
      case 'bin':
        return {
          ...expr,
          left: expand(expr.left, scope, stack),
          right: expand(expr.right, scope, stack),
        };
      case 'grams':
        if (!ingredientDecls.has(expr.name)) {
          err(`undeclared ingredient '${expr.name}'`, expr);
        }
        return expr;
      case 'ref': {
        const def = lookupMacro(scope, expr.name);
        if (!def) return expr;
        if (stack.includes(expr.name)) {
          err(`circular macro expansion involving '${expr.name}'`, expr);
        }
        return expand(def.expr, def.defScope, [...stack, expr.name]);
      }
      default:
        err(`internal: unknown expr kind '${expr.kind}'`, expr);
    }
  }

  // ---- dimensional analysis ----------------------------------------------
  function dimOf(expr, ctx) {
    switch (expr.kind) {
      case 'num':
        return expr.unit ? UNIT_TABLE[expr.unit].dim : DIM_NONE;
      case 'neg':
        return dimOf(expr.expr, ctx);
      case 'grams':
        if (ctx !== 'constraint') err(`'grams(...)' is only allowed in constraints`, expr);
        return DIM_MASS;
      case 'ref': {
        const known =
          expr.name === 'cost' || expr.name === 'mass' || indicatorNames.has(expr.name);
        if (!known) err(`unknown name '${expr.name}'`, expr);
        if (ctx !== 'constraint') {
          err(`'${expr.name}' is only allowed in constraints`, expr);
        }
        if (expr.name === 'cost') return DIM_CURR;
        if (expr.name === 'mass') return DIM_MASS;
        return DIM_CONC;
      }
      case 'bin': {
        const l = dimOf(expr.left, ctx);
        const r = dimOf(expr.right, ctx);
        if (expr.op === '+' || expr.op === '-') {
          if (dimKey(l) !== dimKey(r)) {
            err(
              `dimension mismatch: cannot ${expr.op === '+' ? 'add' : 'subtract'} ` +
                `${dimLabel(l)} and ${dimLabel(r)}`,
              expr,
            );
          }
          return l;
        }
        const d = expr.op === '*' ? dimMul(l, r) : dimDiv(l, r);
        if (!ALLOWED_DIMS.has(dimKey(d))) {
          err(`unsupported dimension ${dimLabel(d)} resulting from '${expr.op}'`, expr);
        }
        return d;
      }
      default:
        err(`internal: unknown expr kind '${expr.kind}'`, expr);
    }
  }

  const requireDim = (expr, ctx, expected, what) => {
    const d = dimOf(expr, ctx);
    if (dimKey(d) !== dimKey(expected)) {
      err(`${what} must be ${dimLabel(expected)}, got ${dimLabel(d)}`, expr);
    }
  };

  // ---- constant evaluation (base units: g, ppm, micro-CNY) ---------------
  function evalConst(expr) {
    switch (expr.kind) {
      case 'num':
        return expr.unit ? expr.value * UNIT_TABLE[expr.unit].scale : expr.value;
      case 'neg':
        return -evalConst(expr.expr);
      case 'bin': {
        const l = evalConst(expr.left);
        const r = evalConst(expr.right);
        switch (expr.op) {
          case '+':
            return l + r;
          case '-':
            return l - r;
          case '*':
            return l * r;
          case '/':
            if (r === 0) err('division by zero', expr);
            return l / r;
          default:
            err(`internal: unknown operator '${expr.op}'`, expr);
        }
        break;
      }
      default:
        err('expected a constant expression', expr);
    }
  }

  // ---- statements ----------------------------------------------------------
  let targetG = null;
  let stepG = 1;
  let budgetMicro = null;
  let minimizeSeen = false;
  const constraints = [];

  const single = (current, node, what) => {
    if (current !== null && current !== undefined) err(`duplicate ${what} statement`, node);
  };

  for (const st of program.body) {
    switch (st.kind) {
      case 'macro':
      case 'ingredient':
        break;
      case 'target': {
        single(targetG, st, 'target');
        const e = expand(st.expr, globalScope, []);
        requireDim(e, 'const', DIM_MASS, 'target');
        targetG = evalConst(e);
        if (!Number.isInteger(targetG) || targetG <= 0) {
          err('target must be a positive whole number of grams', st);
        }
        break;
      }
      case 'step': {
        const e = expand(st.expr, globalScope, []);
        requireDim(e, 'const', DIM_MASS, 'step');
        stepG = evalConst(e);
        if (!Number.isInteger(stepG) || stepG <= 0) {
          err('step must be a positive whole number of grams', st);
        }
        break;
      }
      case 'budget': {
        single(budgetMicro, st, 'budget');
        const e = expand(st.expr, globalScope, []);
        requireDim(e, 'const', DIM_CURR, 'budget');
        budgetMicro = evalConst(e);
        if (budgetMicro < 0) err('budget must not be negative', st);
        break;
      }
      case 'minimize':
        if (minimizeSeen) err('duplicate minimize statement', st);
        minimizeSeen = true;
        break;
      case 'range': {
        if (!indicatorNames.has(st.indicator)) {
          err(`unknown indicator '${st.indicator}'`, st);
        }
        const lo = expand(st.lo, globalScope, []);
        const hi = expand(st.hi, globalScope, []);
        requireDim(lo, 'const', DIM_CONC, 'range lower bound');
        requireDim(hi, 'const', DIM_CONC, 'range upper bound');
        const loPpm = evalConst(lo);
        const hiPpm = evalConst(hi);
        if (loPpm > hiPpm) err('range lower bound exceeds upper bound', st);
        constraints.push({ ...st, lo, hi, loPpm, hiPpm });
        break;
      }
      case 'cmp': {
        const left = expand(st.left, globalScope, []);
        const right = expand(st.right, globalScope, []);
        const dl = dimOf(left, 'constraint');
        const dr = dimOf(right, 'constraint');
        if (dimKey(dl) !== dimKey(dr)) {
          err(
            `dimension mismatch in constraint: ${dimLabel(dl)} vs ${dimLabel(dr)}`,
            st,
          );
        }
        constraints.push({ ...st, left, right });
        break;
      }
      default:
        err(`internal: unknown statement '${st.kind}'`, st);
    }
  }
  if (targetG === null) err('missing target statement', program.body[0] ?? { line: 1, col: 1 });
  if (ingredientDecls.size === 0) {
    err('no ingredients declared', program.body[0] ?? { line: 1, col: 1 });
  }
  if (targetG % stepG !== 0) {
    err(`target ${targetG} g is not a multiple of step ${stepG} g`, program.body[0]);
  }

  // ---- ingredients ---------------------------------------------------------
  const ingredients = [];
  for (const decl of ingredientDecls.values()) {
    const scope = ingredientScopes.get(decl.name);
    const props = new Map();
    const indicators = new Map();
    for (const it of decl.items) {
      if (it.kind !== 'prop') continue;
      const e = expand(it.expr, scope, []);
      if (it.prop === 'indicator') {
        if (indicators.has(it.name)) err(`duplicate indicator '${it.name}'`, it);
        requireDim(e, 'const', DIM_CONC, `indicator '${it.name}'`);
        const v = evalConst(e);
        if (v < 0) err(`indicator '${it.name}' must not be negative`, it);
        indicators.set(it.name, v);
        continue;
      }
      if (props.has(it.prop)) err(`duplicate property '${it.prop}'`, it);
      props.set(it.prop, { expr: e, node: it });
    }
    for (const req of ['cost', 'stock']) {
      if (!props.has(req)) err(`ingredient '${decl.name}' is missing '${req}'`, decl);
    }
    const costExpr = props.get('cost').expr;
    const costDim = dimOf(costExpr, 'const');
    if (dimKey(costDim) !== dimKey(DIM_CURR) && dimKey(costDim) !== dimKey(DIM_PRICE)) {
      err(`cost must be currency or currency/mass, got ${dimLabel(costDim)}`, props.get('cost').node);
    }
    const costMicroPerG = evalConst(costExpr);
    if (costMicroPerG < 0) err('cost must not be negative', props.get('cost').node);
    const stockExpr = props.get('stock').expr;
    requireDim(stockExpr, 'const', DIM_MASS, 'stock');
    const stockG = evalConst(stockExpr);
    if (stockG < 0) err('stock must not be negative', props.get('stock').node);
    let allergenPpm = 0;
    if (props.has('allergen')) {
      const e = props.get('allergen').expr;
      requireDim(e, 'const', DIM_CONC, 'allergen');
      allergenPpm = evalConst(e);
      if (allergenPpm < 0) err('allergen must not be negative', props.get('allergen').node);
    }
    ingredients.push({
      name: decl.name,
      costMicroPerG,
      stockG,
      allergenPpm,
      indicators,
    });
  }

  return {
    file,
    ingredients,
    indicatorNames: [...indicatorNames].sort(),
    targetG,
    stepG,
    budgetMicro,
    constraints,
  };
}
