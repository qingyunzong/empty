// Static semantics: resolves ingredient attributes, evaluates constant
// declarations, and performs dimensional analysis on every expression.

import { Diagnostic } from './lexer.js';
import { rat, rmul, rdiv, radd, rsub, rneg, RZERO } from './rational.js';
import { DIMLESS, MASS, CURRENCY, CURRENCY_PER_MASS, dimAdd, dimSub, dimEqual, dimToString } from './dimension.js';
import { UNITS } from './parser.js';

const GRAMS_ATTR = 'grams';

// Attribute names with prescribed dimensions; any other attribute is a
// quality indicator and must be a dimensionless fraction (declared via ppm).
const RESERVED_ATTRS = {
  cost: CURRENCY_PER_MASS,
  stock: MASS,
  allergen: DIMLESS,
};

function hintOf(node) {
  if (node.unitHint) return `'${node.unitHint}'`;
  if (node.kind === 'unit') return `'${node.name}'`;
  return null;
}

export class Context {
  constructor(program, file) {
    this.program = program;
    this.file = file;
    this.ingredients = []; // { name, attrs: Map(name -> {value, dim}), line, col }
    this.gramIndex = new Map(); // ingredient name -> index
  }

  error(message, node) {
    throw new Diagnostic(message, node.line ?? 1, node.col ?? 1, this.file);
  }

  analyze() {
    const p = this.program;
    for (const ing of p.ingredients) this.analyzeIngredient(ing);
    const total = this.checkConst(p.total.expr, MASS, 'total');
    const step = p.step ? this.checkConst(p.step.expr, MASS, 'step') : rat(1n);
    const budget = p.budget ? this.checkConst(p.budget.expr, CURRENCY, 'budget') : null;
    if (total.n < 0n) this.error('total must not be negative', p.total.expr);
    if (total.d !== 1n) this.error('total must be a whole number of grams', p.total.expr);
    if (step.d !== 1n || step.n <= 0n) this.error('step must be a positive whole number of grams', p.step ? p.step.expr : p.total.expr);
    if (total.n % step.n !== 0n) this.error('total must be a multiple of step', p.total.expr);
    const constraints = p.constraints.map((c) => this.checkConstraint(c));
    const objectiveDim = this.typeOf(p.objective.expr);
    if (!dimEqual(objectiveDim, CURRENCY)) {
      this.error(`objective must have dimension 'currency' (total cost), got '${dimToString(objectiveDim)}'`, p.objective.expr);
    }
    return {
      file: this.file,
      recipe: p.recipe,
      ingredients: this.ingredients,
      total,
      step,
      budget,
      constraints,
      objective: p.objective.expr,
    };
  }

  analyzeIngredient(ing) {
    const attrs = new Map();
    for (const decl of ing.attrs) {
      const dim = this.typeOf(decl.expr);
      const expected = RESERVED_ATTRS[decl.name] ?? DIMLESS;
      if (!dimEqual(dim, expected)) {
        this.error(
          `attribute '${decl.name}' of ingredient '${ing.name}' must have dimension '${dimToString(expected)}', got '${dimToString(dim)}'`,
          decl.expr);
      }
      const value = this.evalConst(decl.expr);
      if (decl.name === 'cost' || decl.name === 'stock' || decl.name === 'allergen') {
        if (value.n < 0n) this.error(`attribute '${decl.name}' of ingredient '${ing.name}' must not be negative`, decl.expr);
      }
      attrs.set(decl.name, { value, dim });
    }
    for (const required of ['cost', 'stock']) {
      if (!attrs.has(required)) {
        this.error(`ingredient '${ing.name}' is missing required attribute '${required}'`, ing);
      }
    }
    if (!attrs.has('allergen')) attrs.set('allergen', { value: RZERO, dim: DIMLESS });
    this.gramIndex.set(ing.name, this.ingredients.length);
    this.ingredients.push({ name: ing.name, attrs, line: ing.line, col: ing.col });
  }

  checkConstraint(c) {
    const dl = this.typeOf(c.lhs);
    const dr = this.typeOf(c.rhs);
    if (!dimEqual(dl, dr)) {
      const hl = hintOf(c.lhs);
      const hr = hintOf(c.rhs);
      const detail = hl && hr ? ` (${hl} vs ${hr})` : '';
      this.error(
        `dimension mismatch in constraint: cannot compare '${dimToString(dl)}' with '${dimToString(dr)}'${detail}`,
        { line: c.line, col: c.col });
    }
    return { lhs: c.lhs, op: c.op, rhs: c.rhs, line: c.line, col: c.col };
  }

  checkConst(expr, expectedDim, what) {
    const dim = this.typeOf(expr);
    if (!dimEqual(dim, expectedDim)) {
      this.error(`'${what}' must have dimension '${dimToString(expectedDim)}', got '${dimToString(dim)}'`, expr);
    }
    return this.evalConst(expr);
  }

  // Dimension of an expression; raises Diagnostic on mismatch.
  typeOf(node) {
    switch (node.kind) {
      case 'num': return DIMLESS;
      case 'unit': return UNITS[node.name].dim;
      case 'attr': return this.attrDim(node);
      case 'neg': return this.typeOf(node.operand);
      case 'bin': {
        const dl = this.typeOf(node.lhs);
        const dr = this.typeOf(node.rhs);
        if (node.op === '+' || node.op === '-') {
          if (!dimEqual(dl, dr)) {
            const hl = hintOf(node.lhs);
            const hr = hintOf(node.rhs);
            const detail = hl && hr ? ` (${hl} vs ${hr})` : '';
            this.error(
              `dimension mismatch: cannot ${node.op === '+' ? 'add' : 'subtract'} '${dimToString(dl)}' and '${dimToString(dr)}'${detail}`,
              node);
          }
          return dl;
        }
        if (node.op === '*') return dimAdd(dl, dr);
        return dimSub(dl, dr);
      }
      default:
        throw new Error(`cannot type node kind ${node.kind}`);
    }
  }

  attrDim(node) {
    const idx = this.gramIndex.get(node.ingredient);
    if (idx === undefined) {
      const declared = this.program.ingredientNames.has(node.ingredient);
      if (!declared) this.error(`undeclared ingredient '${node.ingredient}'`, node);
      if (node.attr === GRAMS_ATTR) return MASS;
      const decl = this.program.ingredients.find((i) => i.name === node.ingredient);
      const attr = decl.attrs.find((a) => a.name === node.attr);
      if (!attr) this.error(`ingredient '${node.ingredient}' has no attribute '${node.attr}'`, node);
      return RESERVED_ATTRS[node.attr] ?? DIMLESS;
    }
    if (node.attr === GRAMS_ATTR) return MASS;
    const ing = this.ingredients[idx];
    if (!ing.attrs.has(node.attr)) {
      this.error(`ingredient '${node.ingredient}' has no attribute '${node.attr}'`, node);
    }
    return ing.attrs.get(node.attr).dim;
  }

  attrValue(node) {
    const idx = this.gramIndex.get(node.ingredient);
    if (idx === undefined) {
      if (this.program.ingredientNames.has(node.ingredient)) {
        this.error(`ingredient '${node.ingredient}' is used before its declaration`, node);
      }
      this.error(`undeclared ingredient '${node.ingredient}'`, node);
    }
    const ing = this.ingredients[idx];
    if (!ing.attrs.has(node.attr)) {
      this.error(`ingredient '${node.ingredient}' has no attribute '${node.attr}'`, node);
    }
    return ing.attrs.get(node.attr).value;
  }

  // Evaluate a constant expression (no .grams references) to a rational.
  evalConst(node) {
    switch (node.kind) {
      case 'num': return node.value;
      case 'unit': return UNITS[node.name].scale;
      case 'attr': {
        if (node.attr === GRAMS_ATTR) {
          this.error(`'${node.ingredient}.grams' is a variable and cannot appear in a constant declaration`, node);
        }
        return this.attrValue(node);
      }
      case 'neg': return rneg(this.evalConst(node.operand));
      case 'bin': {
        const l = this.evalConst(node.lhs);
        const r = this.evalConst(node.rhs);
        switch (node.op) {
          case '+': return radd(l, r);
          case '-': return rsub(l, r);
          case '*': return rmul(l, r);
          case '/':
            if (r.n === 0n) this.error('division by zero in constant expression', node);
            return rdiv(l, r);
          default: throw new Error(`bad op ${node.op}`);
        }
      }
      default:
        throw new Error(`cannot evaluate node kind ${node.kind}`);
    }
  }
}

export function analyze(program, file) {
  return new Context(program, file).analyze();
}
