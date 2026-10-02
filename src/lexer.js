import { DiagnosticError } from './errors.js';

// Token patterns for the rule DSL. Covers:
//   - device IDs / identifiers: [A-Za-z_][A-Za-z0-9_-]*   (e.g. sensor-1, pump_a)
//   - quantities with temperature/current units: 80C, 36.5C, 10A
//   - durations: 30s, 5m, 1h
//   - regex device groups: /^sensor-[0-9]+$/
const KEYWORDS = new Set([
  'field', 'group', 'let', 'rule', 'on', 'all', 'alert', 'when',
  'for', 'and', 'or', 'not',
]);

export const UNITS = new Set(['C', 'A']);
const UNIT_FACTOR = { s: 1000, m: 60_000, h: 3_600_000 };

export function lex(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const err = (msg) => { throw new DiagnosticError(msg, { phase: 'lex', line, col }); };
  const push = (type, value, extra) => tokens.push({ type, value, line, col, ...extra });

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }

    const startLine = line, startCol = col;

    // Regex literal: /.../  (supports \/ escape)
    if (ch === '/') {
      let j = i + 1, body = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n') err('unterminated regex literal');
        if (src[j] === '\\') {
          if (j + 1 >= src.length) err('unterminated regex literal');
          body += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '/') break;
        body += src[j];
        j++;
      }
      col += j + 1 - i;
      i = j + 1;
      if (body.length === 0) {
        throw new DiagnosticError('empty regex device group matches nothing',
          { phase: 'lex', line: startLine, col: startCol });
      }
      try { new RegExp(body); } catch (e) {
        throw new DiagnosticError(`invalid regex: ${e.message}`,
          { phase: 'lex', line: startLine, col: startCol });
      }
      tokens.push({ type: 'REGEX', value: body, line: startLine, col: startCol });
      continue;
    }

    // Number, quantity (80C / 10A) or duration (30s / 5m / 1h)
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const numText = src.slice(i, j);
      const num = Number(numText);
      const u = src[j];
      if (u === 'C' || u === 'A') {
        tokens.push({ type: 'QUANTITY', value: num, unit: u, line: startLine, col: startCol });
        col += j + 1 - i; i = j + 1; continue;
      }
      if (u === 's' || u === 'm' || u === 'h') {
        tokens.push({ type: 'DURATION', value: num * UNIT_FACTOR[u], line: startLine, col: startCol });
        col += j + 1 - i; i = j + 1; continue;
      }
      tokens.push({ type: 'NUMBER', value: num, line: startLine, col: startCol });
      col += j - i; i = j; continue;
    }

    // Identifier / keyword / device ID
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({
        type: KEYWORDS.has(word) ? 'KW' : 'IDENT',
        value: word, line: startLine, col: startCol,
      });
      col += j - i; i = j; continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      tokens.push({ type: 'OP', value: two, line: startLine, col: startCol });
      i += 2; col += 2; continue;
    }
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'OP', value: ch, line: startLine, col: startCol });
      i++; col++; continue;
    }
    if ('(){};:='.includes(ch)) {
      tokens.push({ type: 'PUNCT', value: ch, line: startLine, col: startCol });
      i++; col++; continue;
    }
    err(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: 'EOF', value: null, line, col });
  return tokens;
}
