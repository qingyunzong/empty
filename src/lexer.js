import { TemplateError, ErrorCode } from './errors.js';

export const TokenKind = Object.freeze({
  TEXT: 'text',
  NUMBER: 'number',
  STRING: 'string',
  IDENT: 'ident',
  PUNCT: 'punct',
  OPEN_EXPR: 'open_expr',
  CLOSE_EXPR: 'close_expr',
  OPEN_STMT: 'open_stmt',
  CLOSE_STMT: 'close_stmt',
  EOF: 'eof',
});

const PUNCTS = new Set(['.', '|', '(', ')', ',', '+', '-', '*', '/', '%']);

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isIdentStart = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
const isIdentPart = (ch) => isIdentStart(ch) || isDigit(ch);

export function lex(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('{{', i) || source.startsWith('{%', i)) {
      const isExpr = source[i + 1] === '{';
      tokens.push({ kind: isExpr ? TokenKind.OPEN_EXPR : TokenKind.OPEN_STMT, pos: i });
      i = lexExpressionMode(source, i + 2, tokens, isExpr);
    } else {
      let j = i;
      while (j < source.length && !source.startsWith('{{', j) && !source.startsWith('{%', j)) j++;
      tokens.push({ kind: TokenKind.TEXT, value: source.slice(i, j), pos: i });
      i = j;
    }
  }
  tokens.push({ kind: TokenKind.EOF, pos: source.length });
  return tokens;
}

function lexExpressionMode(source, i, tokens, isExpr) {
  const closer = isExpr ? '}}' : '%}';
  while (i < source.length) {
    const ch = source[i];
    if (source.startsWith(closer, i)) {
      tokens.push({ kind: isExpr ? TokenKind.CLOSE_EXPR : TokenKind.CLOSE_STMT, pos: i });
      return i + 2;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      let j = i;
      while (j < source.length && isDigit(source[j])) j++;
      if (source[j] === '.' && isDigit(source[j + 1])) {
        j++;
        while (j < source.length && isDigit(source[j])) j++;
      }
      tokens.push({ kind: TokenKind.NUMBER, value: Number(source.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) {
          throw new TemplateError(ErrorCode.LEX_ERROR, `unterminated string at offset ${i}`);
        }
        if (source[j] === '\\') {
          const esc = source[j + 1];
          const mapped = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }[esc];
          if (mapped === undefined) {
            throw new TemplateError(ErrorCode.LEX_ERROR, `bad escape "\\${esc}" at offset ${j}`);
          }
          value += mapped;
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        value += source[j];
        j++;
      }
      tokens.push({ kind: TokenKind.STRING, value, pos: i });
      i = j + 1;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j])) j++;
      tokens.push({ kind: TokenKind.IDENT, value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (PUNCTS.has(ch)) {
      tokens.push({ kind: TokenKind.PUNCT, value: ch, pos: i });
      i++;
      continue;
    }
    throw new TemplateError(ErrorCode.LEX_ERROR, `unexpected character "${ch}" at offset ${i}`);
  }
  throw new TemplateError(
    ErrorCode.UNCLOSED_EXPR,
    `unclosed ${isExpr ? 'interpolation "{{"' : 'statement "{%"'}`,
  );
}
