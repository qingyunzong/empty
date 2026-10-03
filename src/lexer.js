import { RiskError } from './errors.js';

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentChar = (c) => isIdentStart(c) || isDigit(c);

// Token types: num, str, cidr, ip, range, regex, ident, punct, eof
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const here = () => ({ line, col });
  const bump = () => {
    if (src[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };
  const push = (type, value, pos, extra) => tokens.push({ type, value, pos, ...extra });

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      bump();
      continue;
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') bump();
      continue;
    }
    const pos = here();
    if (c === '"') {
      bump();
      let out = '';
      let closed = false;
      while (i < src.length) {
        if (src[i] === '"') {
          closed = true;
          bump();
          break;
        }
        if (src[i] === '\\') {
          bump();
          const e = src[i];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === '"' || e === '\\') out += e;
          else throw new RiskError('E_LEX', `bad escape \\${e}`, pos);
          bump();
        } else {
          out += src[i];
          bump();
        }
      }
      if (!closed) throw new RiskError('E_LEX', 'unterminated string literal', pos);
      push('str', out, pos);
      continue;
    }
    if (c === '/') {
      // regex literal (no division operator exists in the DSL)
      bump();
      let out = '';
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i];
          bump();
          if (i < src.length) {
            out += src[i];
            bump();
          }
          continue;
        }
        if (src[i] === '/') {
          closed = true;
          bump();
          break;
        }
        if (src[i] === '\n') break;
        out += src[i];
        bump();
      }
      if (!closed) throw new RiskError('E_LEX', 'unterminated regex literal', pos);
      try {
        new RegExp(out);
      } catch {
        throw new RiskError('E_LEX', `invalid regex /${out}/`, pos);
      }
      push('regex', out, pos);
      continue;
    }
    if (isDigit(c)) {
      const rest = src.slice(i);
      const ipm = rest.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?/);
      if (ipm) {
        const end = i + ipm[0].length;
        const next = src[end];
        if (next === undefined || !(isDigit(next) || next === '.' || next === '/')) {
          for (let k = 0; k < ipm[0].length; k++) bump();
          if (ipm[2] !== undefined) push('cidr', `${ipm[1]}/${ipm[2]}`, pos);
          else push('ip', ipm[1], pos);
          continue;
        }
      }
      const nm = rest.match(/^\d+(?:\.\d+)?/);
      const text = nm[0];
      for (let k = 0; k < text.length; k++) bump();
      if (src[i] === '.' && src[i + 1] === '.' && isDigit(src[i + 2] ?? '')) {
        bump();
        bump();
        const nm2 = src.slice(i).match(/^\d+(?:\.\d+)?/);
        const hi = nm2[0];
        for (let k = 0; k < hi.length; k++) bump();
        push('range', null, pos, { lo: text, hi });
        continue;
      }
      push('num', text, pos);
      continue;
    }
    if (isIdentStart(c)) {
      let s = '';
      while (i < src.length && isIdentChar(src[i])) {
        s += src[i];
        bump();
      }
      push('ident', s, pos);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      bump();
      bump();
      push('punct', two, pos);
      continue;
    }
    if ('{}():;=><!,.'.includes(c)) {
      bump();
      push('punct', c, pos);
      continue;
    }
    throw new RiskError('E_LEX', `unexpected character ${JSON.stringify(c)}`, pos);
  }
  push('eof', null, here());
  return tokens;
}
