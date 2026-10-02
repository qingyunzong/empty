import { tokenize } from './lexer.js';
import { TemplateError } from './errors.js';

// Binding powers for the Pratt expression parser.
// Filters ('|') bind loosest, then +/-, then */%, then unary '-',
// then postfix field access '.'.
const BIN_BP = { '+': [3, 4], '-': [3, 4], '*': [5, 6], '/': [5, 6], '%': [5, 6] };
const FILTER_BP = [1, 2];
const UNARY_BP = 7;

export function parseTemplate(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type, value) => {
    const t = next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new TemplateError(
        `expected ${value ?? type}, got ${t.type}${t.value !== undefined ? ` '${t.value}'` : ''}`,
        'parse',
      );
    }
    return t;
  };

  function parseExpr(minBp = 0) {
    const t = next();
    let lhs;
    if (t.type === 'NUMBER') lhs = { type: 'num', value: t.value };
    else if (t.type === 'STRING') lhs = { type: 'str', value: t.value };
    else if (t.type === 'IDENT') lhs = { type: 'var', name: t.value };
    else if (t.type === 'PUNCT' && t.value === '(') {
      lhs = parseExpr(0);
      expect('PUNCT', ')');
    } else if (t.type === 'PUNCT' && t.value === '-') {
      lhs = { type: 'neg', expr: parseExpr(UNARY_BP) };
    } else {
      throw new TemplateError(`expected expression, got ${t.type}`, 'parse');
    }

    for (;;) {
      const p = peek();
      if (p.type !== 'PUNCT') break;
      if (p.value === '.') {
        next();
        lhs = { type: 'field', object: lhs, name: expect('IDENT').value };
        continue;
      }
      if (p.value === '|') {
        if (FILTER_BP[0] < minBp) break;
        next();
        const name = expect('IDENT').value;
        const args = [];
        if (peek().type === 'PUNCT' && peek().value === '(') {
          next();
          if (!(peek().type === 'PUNCT' && peek().value === ')')) {
            for (;;) {
              args.push(parseExpr(0));
              if (peek().type === 'PUNCT' && peek().value === ',') {
                next();
                continue;
              }
              break;
            }
          }
          expect('PUNCT', ')');
        }
        lhs = { type: 'filter', name, args, expr: lhs };
        continue;
      }
      const bp = BIN_BP[p.value];
      if (bp) {
        if (bp[0] < minBp) break;
        next();
        lhs = { type: 'bin', op: p.value, left: lhs, right: parseExpr(bp[1]) };
        continue;
      }
      break;
    }
    return lhs;
  }

  // Parses nodes until EOF or a matching {% end %}.
  function parseBody() {
    const nodes = [];
    for (;;) {
      const t = peek();
      if (t.type === 'EOF') return { nodes, closed: false };
      if (t.type === 'TEXT') {
        next();
        nodes.push({ type: 'text', value: t.value });
        continue;
      }
      if (t.type === 'INTERP_OPEN') {
        next();
        const expr = parseExpr();
        expect('INTERP_CLOSE');
        nodes.push({ type: 'interp', expr });
        continue;
      }
      if (t.type === 'BLOCK_OPEN') {
        next();
        const kw = expect('IDENT').value;
        if (kw === 'end') {
          expect('BLOCK_CLOSE');
          return { nodes, closed: true };
        }
        if (kw === 'scope') {
          const name = expect('IDENT').value;
          let init = null;
          if (peek().type === 'PUNCT' && peek().value === '=') {
            next();
            init = parseExpr();
          }
          expect('BLOCK_CLOSE');
          const inner = parseBody();
          if (!inner.closed) {
            throw new TemplateError(`unclosed block: scope '${name}'`, 'parse');
          }
          nodes.push({ type: 'scope', name, init, body: inner.nodes });
          continue;
        }
        throw new TemplateError(`unknown block tag '${kw}'`, 'parse');
      }
      throw new TemplateError(`unexpected token ${t.type}`, 'parse');
    }
  }

  const { nodes, closed } = parseBody();
  if (closed) throw new TemplateError("unexpected '{% end %}' with no open block", 'parse');
  return nodes;
}
