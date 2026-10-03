export class LexError extends Error {
  constructor(msg, line, col) {
    super(`lex error at ${line}:${col}: ${msg}`);
    this.name = 'LexError';
  }
}

const PUNCT = new Set(['{', '}', '(', ')', ',', ';', ':', '=']);

export function tokenize(src) {
  const toks = [];
  let i = 0, line = 1, col = 1;
  const push = (t, v, extra) => toks.push(Object.assign({ t, v, line, col }, extra));
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; col = 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '@') {
      let j = i + 1;
      while (j < src.length && /[0-9Tt:-]/.test(src[j])) j++;
      if (j === i + 1) throw new LexError('expected instant after @', line, col);
      push('instant', src.slice(i + 1, j));
      col += j - i; i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      const num = src.slice(i, j);
      const u = src[j];
      if (u === 'm' || u === 'h' || u === 'd') {
        push('dur', Number(num), { unit: u });
        j++; col += j - i; i = j; continue;
      }
      if (/[A-Za-z_]/.test(u || '')) throw new LexError(`invalid number suffix '${u}'`, line, col);
      push('int', Number(num));
      col += j - i; i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      push('ident', src.slice(i, j));
      col += j - i; i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '..' || two === '<=' || two === '>=' || two === '==' || two === '!=') {
      push('op', two); i += 2; col += 2; continue;
    }
    if ('+-*/<>'.includes(c)) { push('op', c); i++; col++; continue; }
    if (PUNCT.has(c)) { push('punct', c); i++; col++; continue; }
    throw new LexError(`unexpected character '${c}'`, line, col);
  }
  push('eof', '');
  return toks;
}
