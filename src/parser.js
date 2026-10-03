import { parseError } from './errors.js';

// AST node kinds:
//   contract { name, defaults, tiers, fee, rounding, residual }
//   defaults { entries: [{key, value}] }
//   tier { from: expr|null, to: expr|null, fee: expr, rounding: string|null }
//   literal { value: string, unit: 'bps'|'money'|'units' }
//   min { expr, bound } | max { expr, bound }

const PREFIX_PARSERS = {
  NUMBER(parser, token) {
    const next = parser.peek();
    if (next.type === 'BPS') {
      parser.advance();
      return { kind: 'literal', value: token.value, unit: 'bps', line: token.line };
    }
    if (next.type === 'CURRENCY') {
      parser.advance();
      return { kind: 'literal', value: token.value, unit: 'money', currency: next.value, line: token.line };
    }
    if (next.type === 'UNITS') {
      parser.advance();
      return { kind: 'literal', value: token.value, unit: 'units', line: token.line };
    }
    throw parseError(`bare number '${token.value}' at line ${token.line} requires a unit (bps, CURRENCY or units)`);
  },
  '{'(parser, token) {
    const tiers = [];
    while (!(parser.peek().type === 'PUNCT' && parser.peek().value === '}')) {
      tiers.push(parser.parseTier());
    }
    parser.expectPunct('}');
    return { kind: 'tierList', tiers, line: token.line };
  },
  IDENT(parser, token) {
    return { kind: 'ref', name: token.value, line: token.line };
  },
  '('(parser) {
    const expr = parser.parseExpression(0);
    parser.expectPunct(')');
    return expr;
  },
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  advance() { return this.tokens[this.pos++]; }

  expectPunct(value) {
    const t = this.advance();
    if (t.type !== 'PUNCT' || t.value !== value) {
      throw parseError(`expected '${value}' at line ${t.line}, got ${t.type} '${t.value}'`);
    }
    return t;
  }

  expectKeyword(value) {
    const t = this.advance();
    if (t.type !== 'KEYWORD' || t.value !== value) {
      throw parseError(`expected keyword '${value}' at line ${t.line}, got ${t.type} '${t.value}'`);
    }
    return t;
  }

  parseExpression(minBinding) {
    const token = this.advance();
    let prefix;
    if (token.type === 'PUNCT' && PREFIX_PARSERS[token.value]) prefix = PREFIX_PARSERS[token.value];
    else if (token.type === 'KEYWORD' && PREFIX_PARSERS[token.value]) prefix = PREFIX_PARSERS[token.value];
    else if (token.type === 'NUMBER') prefix = PREFIX_PARSERS.NUMBER;
    else if (token.type === 'IDENT') prefix = PREFIX_PARSERS.IDENT;
    if (!prefix) throw parseError(`unexpected ${token.type} '${token.value}' at line ${token.line} in expression`);
    let left = prefix(this, token);
    // infix: none currently; loop kept for Pratt extensibility
    for (;;) {
      const next = this.peek();
      const binding = this.infixBinding(next);
      if (binding <= minBinding) break;
      left = this.parseInfix(left, next, binding);
    }
    return left;
  }

  infixBinding(token) {
    if (token.type === 'KEYWORD' && (token.value === 'min' || token.value === 'max')) return 80;
    if (token.type === 'PUNCT' && token.value === '+') return 10;
    return 0;
  }

  parseInfix(left, token, binding) {
    this.advance();
    if (token.type === 'PUNCT' && token.value === '+') {
      const right = this.parseExpression(binding);
      return { kind: 'add', left, right, line: token.line };
    }
    const bound = this.parseExpression(binding);
    return { kind: token.value, expr: left, bound, line: token.line };
  }

  parseTier() {
    const start = this.expectKeyword('tier');
    let from = null, to = null, fee = null, rounding = null;
    this.expectKeyword('on');
    this.expectPunct('[');
    from = this.parseExpression(0);
    this.expectPunct(',');
    let toInclusive = false;
    if (!(this.peek().type === 'PUNCT' && (this.peek().value === ']' || this.peek().value === ')'))) {
      to = this.parseExpression(0);
    }
    const closer = this.advance();
    if (closer.type !== 'PUNCT' || (closer.value !== ']' && closer.value !== ')')) {
      throw parseError(`expected ']' or ')' to close tier interval at line ${closer.line}`);
    }
    toInclusive = closer.value === ']';
    this.expectKeyword('fee');
    this.expectPunct('=');
    fee = this.parseExpression(0);
    if (this.peek().type === 'KEYWORD' && this.peek().value === 'rounding') {
      this.advance();
      const mode = this.advance();
      if (mode.type !== 'KEYWORD' || !['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(mode.value)) {
        throw parseError(`expected rounding mode at line ${mode.line}`);
      }
      rounding = mode.value;
    }
    return { kind: 'tier', from, to, toInclusive, fee, rounding, line: start.line };
  }

  parseContract() {
    this.expectKeyword('contract');
    const nameTok = this.advance();
    if (nameTok.type !== 'STRING') throw parseError(`expected contract name string at line ${nameTok.line}`);
    this.expectPunct('{');
    const contract = { kind: 'contract', name: nameTok.value, defaults: [], tiers: [], fee: null, rounding: null, residual: null };
    while (!(this.peek().type === 'PUNCT' && this.peek().value === '}')) {
      const t = this.peek();
      if (t.type !== 'KEYWORD') throw parseError(`unexpected ${t.type} '${t.value}' at line ${t.line} in contract body`);
      if (t.value === 'defaults') {
        this.advance();
        this.expectPunct('{');
        while (!(this.peek().type === 'PUNCT' && this.peek().value === '}')) {
          const key = this.advance();
          if (key.type !== 'IDENT') throw parseError(`expected parameter name at line ${key.line}`);
          this.expectPunct('=');
          const value = this.parseExpression(0);
          contract.defaults.push({ key: key.value, value, line: key.line });
        }
        this.expectPunct('}');
      } else if (t.value === 'fee') {
        this.advance();
        this.expectPunct('=');
        contract.fee = this.parseExpression(0);
      } else if (t.value === 'rounding') {
        this.advance();
        const mode = this.advance();
        if (mode.type !== 'KEYWORD' || !['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(mode.value)) {
          throw parseError(`expected rounding mode at line ${mode.line}`);
        }
        contract.rounding = mode.value;
      } else if (t.value === 'residual') {
        this.advance();
        this.expectKeyword('to');
        const acct = this.advance();
        if (acct.type !== 'IDENT') throw parseError(`expected residual account identifier at line ${acct.line}`);
        contract.residual = acct.value;
      } else {
        throw parseError(`unexpected keyword '${t.value}' at line ${t.line} in contract body`);
      }
    }
    this.expectPunct('}');
    if (this.peek().type !== 'EOF') {
      const t = this.peek();
      throw parseError(`unexpected trailing ${t.type} '${t.value}' at line ${t.line}`);
    }
    if (!contract.fee) throw parseError('contract is missing a fee expression');
    if (!contract.residual) throw parseError('contract is missing a residual account (residual to <account>)');
    return contract;
  }
}

export function parse(tokens) {
  return new Parser(tokens).parseContract();
}
