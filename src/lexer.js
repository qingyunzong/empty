import { E } from './errors.js';

const KEYWORDS = new Set([
  'version', 'valid_from', 'rule', 'level', 'when',
  'and', 'or', 'not', 'in', 'override', 'deny', 'review', 'allow', 'match',
]);

const PUNCT = {
  '{': 'LBRACE', '}': 'RBRACE',
  '(': 'LPAREN', ')': 'RPAREN',
  '[': 'LBRACKET', ']': 'RBRACKET',
  ',': 'COMMA',
};

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const rest = () => src.slice(i);
  let m;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if ((m = rest().match(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?(?![\w])/))) {
      tokens.push({ type: 'TS', value: m[0], line }); i += m[0].length; continue;
    }
    if ((m = rest().match(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}(?![\w/])/))) {
      tokens.push({ type: 'CIDR', value: m[0], line }); i += m[0].length; continue;
    }
    if ((m = rest().match(/^\d+(\.\d+)?[A-Z]{3}(?![\w])/))) {
      tokens.push({ type: 'MONEY', value: m[0], line }); i += m[0].length; continue;
    }
    if ((m = rest().match(/^\d+\.\d+(?![\w])/))) {
      tokens.push({ type: 'FLOAT', value: m[0], line }); i += m[0].length; continue;
    }
    if ((m = rest().match(/^\d+(?![\w]|\.\d)/))) {
      tokens.push({ type: 'NUMBER', value: m[0], line }); i += m[0].length; continue;
    }
    if (rest().startsWith('..')) { tokens.push({ type: 'DOTDOT', line }); i += 2; continue; }
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      tokens.push({ type: 'OP', value: two, line }); i += 2; continue;
    }
    if (ch === '>' || ch === '<') { tokens.push({ type: 'OP', value: ch, line }); i++; continue; }
    if (ch === '=' || ch === '!')
      throw E('E_PARSE', `unexpected '${ch}' at line ${line} (did you mean '${ch}='?)`);
    if (ch === '/') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '/' && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j] + src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      if (j >= src.length || src[j] !== '/')
        throw E('E_PARSE', `unterminated regex at line ${line}`);
      tokens.push({ type: 'REGEX', value: out, line }); i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { if (src[j] === '\n') line++; out += src[j]; j++; }
      }
      if (j >= src.length) throw E('E_PARSE', `unterminated string at line ${line}`);
      tokens.push({ type: 'STRING', value: out, line }); i = j + 1; continue;
    }
    if (PUNCT[ch]) { tokens.push({ type: PUNCT[ch], line }); i++; continue; }
    if ((m = rest().match(/^[A-Za-z_][A-Za-z0-9_-]*/))) {
      const word = m[0];
      tokens.push(KEYWORDS.has(word)
        ? { type: 'KW', value: word, line }
        : { type: 'IDENT', value: word, line });
      i += word.length; continue;
    }
    throw E('E_PARSE', `unexpected character '${ch}' at line ${line}`);
  }
  tokens.push({ type: 'EOF', line });
  return tokens;
}
