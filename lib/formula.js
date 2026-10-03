'use strict';

class FormulaError extends Error {}
class LexError extends FormulaError {
  constructor(message) { super(`lex error: ${message}`); this.name = 'LexError'; }
}
class ParseError extends FormulaError {
  constructor(message) { super(`parse error: ${message}`); this.name = 'ParseError'; }
}
class FormulaTypeError extends FormulaError {
  constructor(message) { super(`type error: ${message}`); this.name = 'FormulaTypeError'; }
}

const TWO_CHAR_OPS = ['||', '&&', '==', '!=', '<=', '>='];
const ONE_CHAR_OPS = ['+', '-', '*', '/', '(', ')', ',', '<', '>'];

function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '[') {
      if (source[i + 1] === '[') {
        const end = source.indexOf(']]', i + 2);
        if (end === -1) throw new LexError(`unclosed evidence fragment at offset ${i}`);
        const id = source.slice(i + 2, end);
        if (id.trim() === '') throw new LexError(`empty evidence fragment at offset ${i}`);
        tokens.push({ type: 'evidence', value: id });
        i = end + 2;
      } else {
        const end = source.indexOf(']', i + 1);
        if (end === -1) throw new LexError(`unclosed unit fragment at offset ${i}`);
        const unit = source.slice(i + 1, end);
        if (unit.includes('[')) throw new LexError(`invalid unit fragment at offset ${i}`);
        if (unit.trim() === '') throw new LexError(`empty unit fragment at offset ${i}`);
        tokens.push({ type: 'unit', value: unit });
        i = end + 1;
      }
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const match = /^[0-9]+(?:\.[0-9]+)?|^\.\d+/.exec(source.slice(i));
      tokens.push({ type: 'number', value: match[0] });
      i += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new LexError(`unexpected character '${ch}' at offset ${i}`);
  }
  return tokens;
}

const BINDING_POWER = {
  '||': 10,
  '&&': 20,
  '==': 30, '!=': 30, '<': 30, '>': 30, '<=': 30, '>=': 30,
  '+': 40, '-': 40,
  '*': 50, '/': 50,
};
const UNARY_BP = 60;

function parse(source) {
  const tokens = lex(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(minBp) {
    let left = parsePrefix();
    for (;;) {
      const tok = peek();
      if (!tok) return left;
      if (tok.type === 'unit' || tok.type === 'evidence') {
        next();
        left = { type: 'annotate', kind: tok.type, value: tok.value, expr: left };
        continue;
      }
      if (tok.type === 'op' && Object.prototype.hasOwnProperty.call(BINDING_POWER, tok.value)) {
        const bp = BINDING_POWER[tok.value];
        if (bp < minBp) return left;
        next();
        const right = parseExpr(bp + 1);
        left = { type: 'binary', op: tok.value, left, right };
        continue;
      }
      return left;
    }
  }

  function parsePrefix() {
    const tok = next();
    if (!tok) throw new ParseError('unexpected end of expression');
    if (tok.type === 'number') return { type: 'num', value: tok.value };
    if (tok.type === 'ident') {
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next();
        const args = [];
        if (!(peek() && peek().type === 'op' && peek().value === ')')) {
          for (;;) {
            args.push(parseExpr(0));
            const sep = next();
            if (!sep || sep.type !== 'op' || (sep.value !== ',' && sep.value !== ')')) {
              throw new ParseError('expected \',\' or \')\' in call arguments');
            }
            if (sep.value === ')') break;
          }
        } else {
          next();
        }
        return { type: 'call', name: tok.value, args };
      }
      return { type: 'var', name: tok.value };
    }
    if (tok.type === 'op' && tok.value === '-') {
      return { type: 'neg', expr: parseExpr(UNARY_BP) };
    }
    if (tok.type === 'op' && tok.value === '(') {
      const inner = parseExpr(0);
      const close = next();
      if (!close || close.type !== 'op' || close.value !== ')') {
        throw new ParseError('expected \')\'');
      }
      return inner;
    }
    if (tok.type === 'unit' || tok.type === 'evidence') {
      throw new FormulaTypeError(`${tok.type} fragment [${tok.type === 'unit' ? '' : '['}${tok.value}${tok.type === 'unit' ? '' : ']'}] has no target expression`);
    }
    throw new ParseError(`unexpected token '${tok.value}'`);
  }

  const ast = parseExpr(0);
  if (pos < tokens.length) {
    throw new ParseError(`unexpected token '${tokens[pos].value}' after expression`);
  }
  typecheck(ast);
  return ast;
}

function typecheck(node) {
  switch (node.type) {
    case 'num':
    case 'var':
      return;
    case 'annotate':
      if (node.expr.type === 'annotate') {
        throw new FormulaTypeError('nested unit/evidence annotations are not allowed');
      }
      typecheck(node.expr);
      return;
    case 'neg':
      if (node.expr.type === 'annotate' && node.expr.kind === 'evidence') {
        throw new FormulaTypeError('unary minus cannot be applied to an evidence fragment');
      }
      typecheck(node.expr);
      return;
    case 'binary':
      for (const side of [node.left, node.right]) {
        if (side.type === 'annotate' && side.kind === 'evidence') {
          throw new FormulaTypeError('evidence fragment cannot be used as an operand');
        }
      }
      typecheck(node.left);
      typecheck(node.right);
      return;
    case 'call':
      node.args.forEach(typecheck);
      return;
    default:
      throw new FormulaTypeError(`unknown node type '${node.type}'`);
  }
}

function canonical(node) {
  switch (node.type) {
    case 'num': return ['num', node.value];
    case 'var': return ['var', node.name];
    case 'neg': return ['neg', canonical(node.expr)];
    case 'binary': return ['bin', node.op, canonical(node.left), canonical(node.right)];
    case 'call': return ['call', node.name, node.args.map(canonical)];
    case 'annotate': return [node.kind, node.value, canonical(node.expr)];
    default: throw new FormulaTypeError(`cannot canonicalize node type '${node.type}'`);
  }
}

function canonicalString(ast) {
  return JSON.stringify(canonical(ast));
}

module.exports = {
  lex,
  parse,
  typecheck,
  canonical,
  canonicalString,
  FormulaError,
  LexError,
  ParseError,
  FormulaTypeError,
};
