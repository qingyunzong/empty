// 词法层：kW / kWh / 分钟 / 电价数字 / 时刻 / 注释
export class LangError extends Error {
  constructor(message, line, col, kind) {
    super(message);
    this.name = kind;
    this.line = line;
    this.col = col;
  }
}

export class LexError extends LangError {
  constructor(message, line, col) {
    super(message, line, col, 'LexError');
  }
}

const UNITS = new Set(['kW', 'kWh', 'min']);
const PUNCT = new Set(['{', '}', '(', ')', ':', ',', '-', '+', '*', '/', '=']);

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = () => {
    if (src[i] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (/[0-9]/.test(ch)) {
      let text = '';
      while (i < src.length && /[0-9.]/.test(src[i])) {
        text += src[i];
        advance();
      }
      if (src[i] === ':' && /[0-9]/.test(src[i + 1] || '')) {
        text += src[i];
        advance();
        while (i < src.length && /[0-9]/.test(src[i])) {
          text += src[i];
          advance();
        }
        const m = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (!m) throw new LexError(`无效时刻 "${text}"`, startLine, startCol);
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        if (hh > 24 || mm > 59 || (hh === 24 && mm !== 0)) {
          throw new LexError(`无效时刻 "${text}"`, startLine, startCol);
        }
        tokens.push({ type: 'time', value: text, line: startLine, col: startCol });
        continue;
      }
      if (!/^\d+(\.\d+)?$/.test(text)) throw new LexError(`无效数字 "${text}"`, startLine, startCol);
      tokens.push({ type: 'num', value: parseFloat(text), line: startLine, col: startCol });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        text += src[i];
        advance();
      }
      tokens.push({ type: UNITS.has(text) ? 'unit' : 'ident', value: text, line: startLine, col: startCol });
      continue;
    }
    if (ch === '"') {
      advance();
      let text = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') throw new LexError('字符串未闭合', line, col);
        text += src[i];
        advance();
      }
      if (i >= src.length) throw new LexError('字符串未闭合', startLine, startCol);
      advance();
      tokens.push({ type: 'str', value: text, line: startLine, col: startCol });
      continue;
    }
    if (PUNCT.has(ch)) {
      advance();
      tokens.push({ type: 'punct', value: ch, line: startLine, col: startCol });
      continue;
    }
    throw new LexError(`无法识别的字符 "${ch}"`, startLine, startCol);
  }
  tokens.push({ type: 'eof', value: '<eof>', line, col });
  return tokens;
}
