import { TemplateError } from './errors.js';

// Two-mode lexer: 'text' mode emits raw TEXT until '{{' or '{%';
// 'expr' mode tokenizes expressions until the matching '}}' / '%}'.
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let mode = 'text';
  const push = (type, value) => tokens.push({ type, value });

  while (i < source.length) {
    if (mode === 'text') {
      const nextInterp = source.indexOf('{{', i);
      const nextBlock = source.indexOf('{%', i);
      let next = -1;
      let kind = null;
      if (nextInterp !== -1 && (nextBlock === -1 || nextInterp < nextBlock)) {
        next = nextInterp;
        kind = 'interp';
      } else if (nextBlock !== -1) {
        next = nextBlock;
        kind = 'block';
      }
      if (next === -1) {
        push('TEXT', source.slice(i));
        i = source.length;
        break;
      }
      if (next > i) push('TEXT', source.slice(i, next));
      push(kind === 'interp' ? 'INTERP_OPEN' : 'BLOCK_OPEN');
      i = next + 2;
      mode = 'expr';
      continue;
    }

    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (source.startsWith('}}', i)) {
      push('INTERP_CLOSE');
      i += 2;
      mode = 'text';
      continue;
    }
    if (source.startsWith('%}', i)) {
      push('BLOCK_CLOSE');
      i += 2;
      mode = 'text';
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(source.slice(i));
      push('NUMBER', Number(m[0]));
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new TemplateError('unterminated string literal', 'lex');
      push('STRING', out);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      push('IDENT', m[0]);
      i += m[0].length;
      continue;
    }
    if ('+-*/%(),.=|'.includes(ch)) {
      push('PUNCT', ch);
      i++;
      continue;
    }
    throw new TemplateError(`unexpected character ${JSON.stringify(ch)}`, 'lex');
  }

  if (mode === 'expr') {
    throw new TemplateError('unclosed interpolation or block tag', 'lex');
  }
  push('EOF');
  return tokens;
}
