import { QuotaError } from './errors.js';

const KEYWORDS = new Set([
  'customer', 'note_whitelist', 'bucket', 'limit', 'scope', 'cap', 'let',
  'var', 'set', 'guard', 'when', 'unless', 'freeze', 'unfreeze', 'debit',
  'draw', 'validity', 'to', 'matches', 'true', 'false', 'and', 'or', 'not',
  'amount', 'note',
]);

// 客户号词法模式: C + 至少4位数字
const CUSTOMER_ID = /^C[0-9]{4,}$/;

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const fail = (msg) => {
    throw new QuotaError('E_LEX', `${msg} (line ${line}, col ${col})`);
  };
  const advance = (n) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  const push = (t, v, l, c) => tokens.push({ t, v, line: l, col: c });

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance(1);
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') advance(1);
      continue;
    }
    const l = line;
    const cc = col;

    if (/[0-9]/.test(c)) {
      const rest = src.slice(i);
      // 有效期日期字面量: YYYY-MM-DD
      const dm = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9-])/.exec(rest);
      if (dm) {
        push('date', dm[0], l, cc);
        advance(dm[0].length);
        continue;
      }
      const nm = /^[0-9]+/.exec(rest);
      push('num', Number(nm[0]), l, cc);
      advance(nm[0].length);
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length) fail('unterminated string');
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const nxt = src[j + 1];
          if (nxt === 'n') out += '\n';
          else if (nxt === 't') out += '\t';
          else if (nxt === '"') out += '"';
          else if (nxt === '\\') out += '\\';
          else fail(`bad escape \\${nxt}`);
          j += 2;
          continue;
        }
        out += ch;
        j++;
      }
      push('str', out, l, cc);
      advance(j + 1 - i);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const word = m[0];
      if (KEYWORDS.has(word)) push('kw', word, l, cc);
      else if (CUSTOMER_ID.test(word)) push('cid', word, l, cc);
      else push('ident', word, l, cc);
      advance(word.length);
      continue;
    }

    if (c === '/') {
      // 正则式字面量只在 note_whitelist / matches 之后出现, 否则 '/' 是除法
      const prev = tokens[tokens.length - 1];
      const regexCtx =
        prev && prev.t === 'kw' && (prev.v === 'note_whitelist' || prev.v === 'matches');
      if (regexCtx) {
        let j = i + 1;
        let source = '';
        for (;;) {
          if (j >= src.length || src[j] === '\n') fail('unterminated regex');
          if (src[j] === '\\') {
            source += src[j] + (src[j + 1] ?? '');
            j += 2;
            continue;
          }
          if (src[j] === '/') break;
          source += src[j];
          j++;
        }
        let k = j + 1;
        let flags = '';
        while (k < src.length && /[a-z]/.test(src[k])) {
          flags += src[k];
          k++;
        }
        push('regex', { source, flags }, l, cc);
        advance(k - i);
        continue;
      }
      push('op', '/', l, cc);
      advance(1);
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      push('op', two, l, cc);
      advance(2);
      continue;
    }
    if ('+-*<>='.includes(c)) {
      push('op', c, l, cc);
      advance(1);
      continue;
    }
    if ('{}();,'.includes(c)) {
      push('punct', c, l, cc);
      advance(1);
      continue;
    }
    fail(`unexpected character '${c}'`);
  }
  push('eof', null, line, col);
  return tokens;
}
