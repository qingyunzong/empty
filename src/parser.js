import { NetError, E } from './errors.js';

// Pratt parser. Binding powers (higher binds tighter):
//   or < and < comparison < additive < multiplicative < unary
const BIN_BP = {
  OR: 1, AND: 2,
  EQ: 3, NE: 3, LT: 4, LE: 4, GT: 4, GE: 4,
  PLUS: 5, MINUS: 5,
  STAR: 6,
};

export function parseProgram(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t, what) => {
    const tok = next();
    if (tok.t !== t) {
      throw new NetError(E.PARSE, `expected ${what || t} but found ${tok.t} at line ${tok.line}`);
    }
    return tok;
  };

  function parseExpr(minBp = 1) {
    let left = parsePrefix();
    for (;;) {
      const tok = peek();
      const bp = BIN_BP[tok.t];
      if (!bp || bp < minBp) return left;
      next();
      const right = parseExpr(bp + 1);
      left = { t: 'bin', op: tok.t, l: left, r: right, line: tok.line };
    }
  }

  function parsePrefix() {
    const tok = next();
    switch (tok.t) {
      case 'INT': {
        if (peek().t === 'CCY') {
          const c = next();
          return { t: 'money', amount: tok.v, ccy: c.v, line: tok.line };
        }
        return { t: 'int', v: tok.v, line: tok.line };
      }
      case 'PCT': return { t: 'bps', v: tok.v, line: tok.line };
      case 'DATE': {
        if (peek().t === 'DOT') {
          next();
          const id = expect('IDENT', 'constant name after date qualifier');
          return { t: 'crossref', date: tok.v, name: id.v, line: tok.line };
        }
        return { t: 'date', v: tok.v, line: tok.line };
      }
      case 'MEMBER': return { t: 'member', v: tok.v, line: tok.line };
      case 'OBID': return { t: 'obid', v: tok.v, line: tok.line };
      case 'CCY': return { t: 'ccy', v: tok.v, line: tok.line };
      case 'TRUE': return { t: 'bool', v: true, line: tok.line };
      case 'FALSE': return { t: 'bool', v: false, line: tok.line };
      case 'IDENT': {
        if (peek().t === 'LP') {
          throw new NetError(E.PARSE, `unknown function '${tok.v}' at line ${tok.line}`);
        }
        return { t: 'ident', name: tok.v, line: tok.line };
      }
      case 'MIN': case 'MAX': case 'ABS': {
        const fn = tok.t.toLowerCase();
        expect('LP', `'(' after ${fn}`);
        const args = [parseExpr()];
        while (peek().t === 'COMMA') { next(); args.push(parseExpr()); }
        expect('RP', `')' after ${fn} arguments`);
        const want = fn === 'abs' ? 1 : 2;
        if (args.length !== want) {
          throw new NetError(E.PARSE, `${fn} expects ${want} argument(s), got ${args.length} at line ${tok.line}`);
        }
        return { t: 'call', fn, args, line: tok.line };
      }
      case 'LP': {
        const e = parseExpr();
        expect('RP', "')'");
        return e;
      }
      case 'MINUS':
        return { t: 'un', op: 'neg', e: parsePrefix(), line: tok.line };
      case 'NOT':
        return { t: 'un', op: 'not', e: parseExpr(3), line: tok.line };
      default:
        throw new NetError(E.PARSE, `unexpected ${tok.t} at line ${tok.line}`);
    }
  }

  function parseStmt(block) {
    const tok = next();
    if (tok.t === 'CONST') {
      const name = expect('IDENT', 'constant name');
      if (block.consts.some((c) => c.name === name.v)) {
        throw new NetError(E.PARSE, `duplicate constant '${name.v}' at line ${name.line}`);
      }
      expect('ASSIGN', "'=' in const declaration");
      const expr = parseExpr();
      expect('SEMI', "';' after const declaration");
      block.consts.push({ name: name.v, expr });
    } else if (tok.t === 'FILTER') {
      const expr = parseExpr();
      expect('SEMI', "';' after filter");
      block.filters.push(expr);
    } else if (tok.t === 'SETTLE') {
      const name = expect('IDENT', 'settle value name');
      if (block.settles.some((s) => s.name === name.v)) {
        throw new NetError(E.PARSE, `duplicate settle name '${name.v}' at line ${name.line}`);
      }
      expect('ASSIGN', "'=' in settle declaration");
      const expr = parseExpr();
      expect('SEMI', "';' after settle declaration");
      block.settles.push({ name: name.v, expr });
    } else {
      throw new NetError(E.PARSE, `expected const/filter/settle but found ${tok.t} at line ${tok.line}`);
    }
  }

  const blocks = [];
  const seenDates = new Set();
  while (peek().t !== 'EOF') {
    const kw = expect('DATE', "'date' to open a trade-date scope");
    const d = expect('DATE', 'trade date (YYYY-MM-DD)');
    if (seenDates.has(d.v)) {
      throw new NetError(E.PARSE, `duplicate date block for ${d.v} at line ${d.line}`);
    }
    seenDates.add(d.v);
    expect('LB', "'{' after trade date");
    const block = { date: d.v, consts: [], filters: [], settles: [] };
    while (peek().t !== 'RB') parseStmt(block);
    next(); // consume RB
    blocks.push(block);
  }
  if (blocks.length === 0) {
    throw new NetError(E.PARSE, `rules file defines no date block (line ${kwLine(tokens)})`);
  }
  return { blocks };
}

function kwLine(tokens) {
  return tokens.length ? tokens[tokens.length - 1].line : 1;
}
