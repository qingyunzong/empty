'use strict';

const { RiskError, CODES } = require('./errors');
const { ALPHABET, TOKEN_INDEX, DIM_ORDER, DIM_VALUES } = require('./tokenize');

// Rule grammar (each rule <= 60 chars by scale assumption):
//   alt     := concat ('|' concat)*
//   concat  := rep*
//   rep     := atom ('*'|'+'|'?')*
//   atom    := '(' alt ')' | pattern | '@'name
//   pattern := '[' field field field field field ']'   (order: a t r c h)
//   field   := '*' | <dim-letter><digit>
// A pattern denotes the set of alphabet tokens matching all literal fields.

function parseError(msg) {
  return new RiskError(CODES.RULE_PARSE, msg);
}

function parse(src) {
  src = src.replace(/\s+/g, '');
  let pos = 0;
  const peek = () => src[pos];

  function parseAlt() {
    const options = [parseConcat()];
    while (peek() === '|') {
      pos++;
      options.push(parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  function parseConcat() {
    const parts = [];
    while (pos < src.length && peek() !== ')' && peek() !== '|') parts.push(parseRep());
    if (parts.length === 0) return { type: 'eps' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  function parseRep() {
    let atom = parseAtom();
    while (peek() === '*' || peek() === '+' || peek() === '?') {
      const op = src[pos++];
      atom = { type: op === '*' ? 'star' : op === '+' ? 'plus' : 'opt', expr: atom };
    }
    return atom;
  }

  function parseAtom() {
    const c = peek();
    if (c === '(') {
      pos++;
      const e = parseAlt();
      if (peek() !== ')') throw parseError(`expected ')' at ${pos} in ${JSON.stringify(src)}`);
      pos++;
      return e;
    }
    if (c === '[') return parsePattern();
    if (c === '@') {
      pos++;
      let name = '';
      while (pos < src.length && /[A-Za-z0-9_]/.test(src[pos])) name += src[pos++];
      if (!name) throw parseError(`empty reference in ${JSON.stringify(src)}`);
      return { type: 'ref', name };
    }
    throw parseError(`unexpected character ${JSON.stringify(c)} at ${pos} in ${JSON.stringify(src)}`);
  }

  function parsePattern() {
    pos++; // consume '['
    const fields = {};
    for (const dim of DIM_ORDER) {
      if (peek() === '*') {
        pos++;
        fields[dim] = null;
      } else {
        if (peek() !== dim) {
          throw parseError(`expected field '${dim}' or '*' at ${pos} in ${JSON.stringify(src)}`);
        }
        pos++;
        if (peek() === '*') {
          pos++;
          fields[dim] = null;
          continue;
        }
        const digit = src[pos++];
        const code = dim + digit;
        if (!DIM_VALUES[dim].includes(code)) {
          throw parseError(`unknown code ${JSON.stringify(code)} in ${JSON.stringify(src)}`);
        }
        fields[dim] = code;
      }
    }
    if (peek() !== ']') throw parseError(`expected ']' at ${pos} in ${JSON.stringify(src)}`);
    pos++;
    const symbols = [];
    for (let i = 0; i < ALPHABET.length; i++) {
      const tok = ALPHABET[i];
      let ok = true;
      for (const dim of DIM_ORDER) {
        const want = fields[dim];
        if (want !== null && tok.slice(DIM_ORDER.indexOf(dim) * 2, DIM_ORDER.indexOf(dim) * 2 + 2) !== want) {
          ok = false;
          break;
        }
      }
      if (ok) symbols.push(i);
    }
    return { type: 'token', symbols };
  }

  const ast = parseAlt();
  if (pos !== src.length) throw parseError(`trailing input at ${pos} in ${JSON.stringify(src)}`);
  return ast;
}

// Expand @name references against named definitions; cycles are unsupported.
function expand(ast, defs, stack = []) {
  switch (ast.type) {
    case 'ref': {
      if (!Object.prototype.hasOwnProperty.call(defs, ast.name)) {
        throw parseError(`undefined rule reference @${ast.name}`);
      }
      if (stack.includes(ast.name)) {
        throw new RiskError(
          CODES.RULE_CYCLE_UNSUPPORTED,
          `cyclic rule reference: ${[...stack, ast.name].join(' -> ')}`
        );
      }
      return expand(defs[ast.name], defs, [...stack, ast.name]);
    }
    case 'concat':
      return { type: 'concat', parts: ast.parts.map((p) => expand(p, defs, stack)) };
    case 'alt':
      return { type: 'alt', options: ast.options.map((o) => expand(o, defs, stack)) };
    case 'star':
    case 'plus':
    case 'opt':
      return { type: ast.type, expr: expand(ast.expr, defs, stack) };
    default:
      return ast;
  }
}

// Parse a rules file: lines of "name = regex"; blank lines and # comments ignored.
function parseRuleFile(text) {
  const defs = {};
  const order = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) throw parseError(`expected "name = regex", got ${JSON.stringify(line)}`);
    const name = line.slice(0, eq).trim();
    const body = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw parseError(`bad rule name ${JSON.stringify(name)}`);
    if (!body) throw parseError(`empty rule body for ${name}`);
    defs[name] = parse(body);
    order.push(name);
  }
  if (order.length === 0) throw parseError('no rules defined');
  // Resolve references (also surfaces RULE_CYCLE_UNSUPPORTED).
  const expanded = {};
  for (const name of order) expanded[name] = expand(defs[name], defs, [name]);
  return { rules: expanded, order };
}

module.exports = { parse, parseRuleFile, expand };
