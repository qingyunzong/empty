// Recursive-descent parser for declarations + Pratt parser for expressions.
// Macro bodies are stored as unresolved ASTs capturing their definition scope
// (lexical scoping); they are expanded lazily at use sites with cycle detection.

import { Diagnostic, tokenize } from './lexer.js';
import { parseDecimal, rat } from './rational.js';
import { DIMLESS, MASS, CURRENCY } from './dimension.js';

export const UNITS = {
  g: { scale: rat(1n), dim: MASS },
  kg: { scale: rat(1000n), dim: MASS },
  ppm: { scale: rat(1n, 1000000n), dim: DIMLESS },
  CNY: { scale: rat(1n), dim: CURRENCY },
};

const KEYWORDS = new Set(['recipe', 'macro', 'ingredient', 'total', 'step', 'budget', 'constraint', 'minimize']);

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.macros = new Map();
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.macros.has(name)) return s.macros.get(name);
    }
    return null;
  }
}

class Parser {
  constructor(tokens, file) {
    this.tokens = tokens;
    this.pos = 0;
    this.file = file;
    this.scope = new Scope(null);
    this.program = {
      kind: 'program',
      recipe: null,
      ingredients: [],
      ingredientNames: new Set(),
      total: null,
      step: null,
      budget: null,
      constraints: [],
      objective: null,
    };
  }

  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }

  error(message, tok = this.peek()) {
    throw new Diagnostic(message, tok.line, tok.col, this.file);
  }

  expectPunct(value) {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== value) this.error(`expected '${value}' but found ${t.type === 'eof' ? 'end of file' : JSON.stringify(t.value)}`, t);
    return t;
  }

  expectIdent(what = 'identifier') {
    const t = this.next();
    if (t.type !== 'ident') this.error(`expected ${what} but found ${t.type === 'eof' ? 'end of file' : JSON.stringify(t.value)}`, t);
    return t;
  }

  atKeyword(name) {
    const t = this.peek();
    return t.type === 'ident' && t.value === name;
  }

  parseProgram() {
    while (this.peek().type !== 'eof') {
      const t = this.peek();
      if (t.type !== 'ident') this.error(`expected a declaration (recipe, macro, ingredient, total, step, budget, constraint, minimize)`, t);
      switch (t.value) {
        case 'recipe': this.parseRecipe(); break;
        case 'macro': this.parseMacro(this.scope); break;
        case 'ingredient': this.parseIngredient(); break;
        case 'total': this.parseTotal(); break;
        case 'step': this.parseStep(); break;
        case 'budget': this.parseBudget(); break;
        case 'constraint': this.parseConstraint(); break;
        case 'minimize': this.parseObjective(); break;
        default:
          if (UNITS[t.value]) this.error(`unit '${t.value}' cannot start a declaration`, t);
          this.error(`unknown declaration '${t.value}'`, t);
      }
    }
    const p = this.program;
    if (p.ingredients.length === 0) this.error('program declares no ingredients');
    if (!p.total) this.error("program is missing a 'total <mass>;' mass-conservation declaration");
    if (!p.objective) this.error("program is missing a 'minimize <expr>;' objective");
    return p;
  }

  parseRecipe() {
    this.next();
    const t = this.next();
    if (t.type !== 'string') this.error('expected a quoted recipe name', t);
    if (this.program.recipe) this.error('duplicate recipe declaration', t);
    this.program.recipe = t.value;
    this.expectPunct(';');
  }

  parseMacro(scope) {
    this.next();
    const nameTok = this.expectIdent('macro name');
    if (UNITS[nameTok.value]) this.error(`cannot define macro named '${nameTok.value}': it is a reserved unit`, nameTok);
    if (KEYWORDS.has(nameTok.value)) this.error(`cannot define macro named '${nameTok.value}': it is a keyword`, nameTok);
    if (scope.macros.has(nameTok.value)) this.error(`duplicate macro '${nameTok.value}' in the same scope`, nameTok);
    this.expectPunct('=');
    // Body is parsed without macro expansion; identifiers resolve in this scope
    // at expansion time (lexical scoping, lazy expansion).
    const body = this.parseExpr(0, { expand: false });
    this.expectPunct(';');
    scope.macros.set(nameTok.value, { name: nameTok.value, body, scope, defLine: nameTok.line, defCol: nameTok.col });
  }

  parseIngredient() {
    this.next();
    const nameTok = this.expectIdent('ingredient name');
    if (UNITS[nameTok.value] || KEYWORDS.has(nameTok.value)) this.error(`invalid ingredient name '${nameTok.value}'`, nameTok);
    if (this.program.ingredientNames.has(nameTok.value)) this.error(`duplicate ingredient '${nameTok.value}'`, nameTok);
    this.program.ingredientNames.add(nameTok.value);
    const blockScope = new Scope(this.scope);
    this.expectPunct('{');
    const attrs = [];
    const attrNames = new Set();
    while (!this.atPunct('}')) {
      if (this.atKeyword('macro')) { this.parseMacro(blockScope); continue; }
      const attrTok = this.expectIdent('attribute name');
      if (attrNames.has(attrTok.value)) this.error(`duplicate attribute '${attrTok.value}'`, attrTok);
      attrNames.add(attrTok.value);
      const expr = this.parseExpr(0, { expand: true, scope: blockScope });
      this.expectPunct(';');
      attrs.push({ name: attrTok.value, expr, line: attrTok.line, col: attrTok.col });
    }
    this.expectPunct('}');
    this.program.ingredients.push({ name: nameTok.value, attrs, line: nameTok.line, col: nameTok.col });
  }

  parseTotal() {
    const kw = this.next();
    if (this.program.total) this.error('duplicate total declaration', kw);
    const expr = this.parseExpr(0, { expand: true, scope: this.scope });
    this.expectPunct(';');
    this.program.total = { expr, line: kw.line, col: kw.col };
  }

  parseStep() {
    const kw = this.next();
    if (this.program.step) this.error('duplicate step declaration', kw);
    const expr = this.parseExpr(0, { expand: true, scope: this.scope });
    this.expectPunct(';');
    this.program.step = { expr, line: kw.line, col: kw.col };
  }

  parseBudget() {
    const kw = this.next();
    if (this.program.budget) this.error('duplicate budget declaration', kw);
    const expr = this.parseExpr(0, { expand: true, scope: this.scope });
    this.expectPunct(';');
    this.program.budget = { expr, line: kw.line, col: kw.col };
  }

  parseConstraint() {
    const kw = this.next();
    const lhs = this.parseExpr(0, { expand: true, scope: this.scope });
    const opTok = this.next();
    if (opTok.type !== 'punct' || !['<=', '>=', '==', '<', '>'].includes(opTok.value)) {
      this.error(`expected a comparison operator (<=, >=, ==, <, >) in constraint`, opTok);
    }
    const rhs = this.parseExpr(0, { expand: true, scope: this.scope });
    this.expectPunct(';');
    this.program.constraints.push({ lhs, op: opTok.value, rhs, line: kw.line, col: kw.col });
  }

  parseObjective() {
    const kw = this.next();
    if (this.program.objective) this.error('duplicate minimize declaration', kw);
    const expr = this.parseExpr(0, { expand: true, scope: this.scope });
    this.expectPunct(';');
    this.program.objective = { expr, line: kw.line, col: kw.col };
  }

  atPunct(v) {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }

  // ---- Pratt expression parser ----
  // Precedence: + - (10) < * / (20) < unary - (30) < implicit unit (postfix).
  parseExpr(minBp, ctx) {
    const tok = this.peek();
    let lhs;
    if (tok.type === 'punct' && tok.value === '-') {
      this.next();
      const operand = this.parseExpr(30, ctx);
      lhs = { kind: 'neg', operand, line: tok.line, col: tok.col };
    } else {
      lhs = this.parsePrimary(ctx);
    }
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct') break;
      let bp;
      if (t.value === '+' || t.value === '-') bp = 10;
      else if (t.value === '*' || t.value === '/') bp = 20;
      else break;
      if (bp < minBp) break;
      this.next();
      const rhs = this.parseExpr(bp + 1, ctx);
      lhs = { kind: 'bin', op: t.value, lhs, rhs, line: t.line, col: t.col };
    }
    return lhs;
  }

  parsePrimary(ctx) {
    const tok = this.next();
    if (tok.type === 'num') {
      let node = { kind: 'num', value: parseDecimal(tok.value), hint: null, line: tok.line, col: tok.col };
      // Implicit unit multiplication: `1 kg`, `3.2 CNY`, `80000 ppm`.
      const t = this.peek();
      if (t.type === 'ident' && UNITS[t.value]) {
        this.next();
        node = {
          kind: 'bin', op: '*', lhs: node,
          rhs: { kind: 'unit', name: t.value, line: t.line, col: t.col },
          line: tok.line, col: tok.col, unitHint: t.value,
        };
      } else if (t.type === 'ident' && !KEYWORDS.has(t.value)) {
        this.error(`unexpected identifier '${t.value}' after number; did you mean a unit (g, kg, ppm, CNY)?`, t);
      }
      return node;
    }
    if (tok.type === 'ident') {
      if (UNITS[tok.value]) return { kind: 'unit', name: tok.value, line: tok.line, col: tok.col };
      if (KEYWORDS.has(tok.value)) this.error(`unexpected keyword '${tok.value}' in expression`, tok);
      if (this.atPunct('.')) {
        this.next();
        const attrTok = this.expectIdent('attribute name');
        return { kind: 'attr', ingredient: tok.value, attr: attrTok.value, line: tok.line, col: tok.col };
      }
      if (ctx.expand) return this.expandMacro(tok, ctx.scope, []);
      return { kind: 'ident', name: tok.value, line: tok.line, col: tok.col };
    }
    if (tok.type === 'punct' && tok.value === '(') {
      const inner = this.parseExpr(0, ctx);
      this.expectPunct(')');
      return inner;
    }
    this.error(`expected an expression but found ${tok.type === 'eof' ? 'end of file' : JSON.stringify(tok.value)}`, tok);
  }

  expandMacro(useTok, scope, stack) {
    const mac = scope.lookup(useTok.value);
    if (!mac) {
      this.error(`unknown name '${useTok.value}': not a declared macro, unit, or ingredient attribute`, useTok);
    }
    if (stack.includes(mac)) {
      const chain = [...stack.map((m) => m.name), mac.name].join(' -> ');
      throw new Diagnostic(`macro expansion cycle detected: ${chain}`, useTok.line, useTok.col, this.file);
    }
    return this.expandNode(mac.body, mac.scope, [...stack, mac], useTok);
  }

  // Deep-copy a macro body, expanding nested macro references in the body's
  // own definition scope (lexical scoping).
  expandNode(node, scope, stack, useTok) {
    switch (node.kind) {
      case 'num':
      case 'unit':
      case 'attr':
        return { ...node };
      case 'ident': {
        const mac = scope.lookup(node.name);
        if (!mac) {
          throw new Diagnostic(
            `unknown name '${node.name}' while expanding macro (referenced at ${node.line}:${node.col})`,
            useTok.line, useTok.col, this.file);
        }
        if (stack.includes(mac)) {
          const chain = [...stack.map((m) => m.name), mac.name].join(' -> ');
          throw new Diagnostic(`macro expansion cycle detected: ${chain}`, useTok.line, useTok.col, this.file);
        }
        return this.expandNode(mac.body, mac.scope, [...stack, mac], useTok);
      }
      case 'neg':
        return { ...node, operand: this.expandNode(node.operand, scope, stack, useTok) };
      case 'bin':
        return {
          ...node,
          lhs: this.expandNode(node.lhs, scope, stack, useTok),
          rhs: this.expandNode(node.rhs, scope, stack, useTok),
        };
      default:
        throw new Error(`unknown AST node kind ${node.kind}`);
    }
  }
}

export function parse(source, file = '<input>') {
  const tokens = tokenize(source, file);
  return new Parser(tokens, file).parseProgram();
}
