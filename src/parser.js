import { lex } from './lexer.js';
import { EscrowError } from './errors.js';

const LBP = { PLUS: 10, MINUS: 10, STAR: 20, SLASH: 20 };

class Parser {
  constructor(tokens) { this.toks = tokens; this.pos = 0; }
  peek() { return this.toks[this.pos]; }
  next() { return this.toks[this.pos++]; }
  expect(t, what) {
    const tok = this.next();
    if (!tok || tok.t !== t) {
      throw new EscrowError('E_PARSE', `expected ${what || t}, got ${tok ? tok.t : 'EOF'} at offset ${tok ? tok.pos : 'end'}`);
    }
    return tok;
  }
  expectKw(v) {
    const tok = this.expect('KW', `'${v}'`);
    if (tok.v !== v) throw new EscrowError('E_PARSE', `expected '${v}', got '${tok.v}'`);
    return tok;
  }
  // Pratt parser: precedence climbing over + - * / with unary minus and parens.
  parseExpr(bp = 0) {
    const tok = this.next();
    let left;
    if (!tok) throw new EscrowError('E_PARSE', 'unexpected end of expression');
    if (tok.t === 'NUMBER') left = { type: 'num', value: tok.v };
    else if (tok.t === 'MINUS') left = { type: 'neg', arg: this.parseExpr(30) };
    else if (tok.t === 'LPAREN') { left = this.parseExpr(0); this.expect('RPAREN'); }
    else throw new EscrowError('E_PARSE', `unexpected token ${tok.t} in expression at offset ${tok.pos}`);
    for (;;) {
      const op = this.peek();
      const lbp = op ? LBP[op.t] || 0 : 0;
      if (lbp <= bp) break;
      this.next();
      left = { type: 'bin', op: op.t, left, right: this.parseExpr(lbp) };
    }
    return left;
  }
}

function parseTradeLike(p, kind) {
  const id = p.expect('IDENT', 'trade id').v;
  const version = p.expect('VERSION', 'version (vN)').v;
  p.expectKw('on');
  const date = p.expect('DATE', 'trade date').v;
  const sideTok = p.expect('KW', "'buy' or 'sell'");
  if (sideTok.v !== 'buy' && sideTok.v !== 'sell') {
    throw new EscrowError('E_PARSE', `expected 'buy' or 'sell', got '${sideTok.v}'`);
  }
  let qtySign = 1;
  if (p.peek() && p.peek().t === 'MINUS') { p.next(); qtySign = -1; }
  const qty = qtySign * p.expect('NUMBER', 'quantity').v;
  const isin = p.expect('ISIN', 'ISIN').v;
  p.expect('AT', "'@'");
  const priceExpr = p.parseExpr();
  const kindTok = p.expect('KW', "'net' or 'gross'");
  if (kindTok.v !== 'net' && kindTok.v !== 'gross') {
    throw new EscrowError('E_PARSE', `expected 'net' or 'gross', got '${kindTok.v}'`);
  }
  let feeExpr = null;
  const next = p.peek();
  if (next && next.t === 'KW' && next.v === 'fee') {
    p.next();
    feeExpr = p.parseExpr();
  }
  p.expect('EOF', 'end of statement');
  return { kind, id, version, date, side: sideTok.v, qty, isin, priceExpr, priceKind: kindTok.v, feeExpr };
}

export function parse(src) {
  const p = new Parser(lex(src));
  const head = p.expect('KW', "'trade', 'amend' or 'revoke'");
  if (head.v === 'trade' || head.v === 'amend') return parseTradeLike(p, head.v);
  if (head.v === 'revoke') {
    const id = p.expect('IDENT', 'trade id').v;
    const version = p.expect('VERSION', 'version (vN)').v;
    p.expectKw('on');
    const date = p.expect('DATE', 'trade date').v;
    p.expect('EOF', 'end of statement');
    return { kind: 'revoke', id, version, date };
  }
  throw new EscrowError('E_PARSE', `unknown statement '${head.v}'`);
}
