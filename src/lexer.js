export class DslSyntaxError extends Error {
  constructor(message, pos) {
    super(pos === undefined ? message : `${message} (at offset ${pos})`);
    this.name = 'DslSyntaxError';
    this.pos = pos;
  }
}

export class DslTypeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DslTypeError';
  }
}

const KEYWORDS = new Set(['let', 'and', 'or', 'not', 'by', 'true', 'false']);

const TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/;
const NUMBER_RE = /^\d+(?:\.\d+)?(?:[kKmMgG])?/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;

const UNIT_SCALE = { k: 1e3, m: 1e6, g: 1e9 };

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '#') { // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const rest = src.slice(i);

    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === '"' || esc === '\\') out += esc;
          else throw new DslSyntaxError(`bad escape \\${esc}`, j);
          j += 2;
        } else if (c === '"') {
          closed = true;
          j++;
          break;
        } else {
          out += c;
          j++;
        }
      }
      if (!closed) throw new DslSyntaxError('unterminated string literal', i);
      tokens.push({ type: 'STRING', value: out, pos: i });
      i = j;
      continue;
    }

    if (/\d/.test(ch)) {
      const tm = rest.match(TIME_RE);
      if (tm && tm[0].includes('-')) {
        const text = tm[0];
        const ms = Date.parse(text.replace(' ', 'T') + (text.length === 10 ? 'T00:00:00Z' : /Z|[+-]\d{2}:?\d{2}$/.test(text) ? '' : 'Z'));
        if (Number.isNaN(ms)) throw new DslSyntaxError(`invalid time literal ${text}`, i);
        tokens.push({ type: 'TIME', value: ms, text, pos: i });
        i += text.length;
        continue;
      }
      const nm = rest.match(NUMBER_RE);
      const text = nm[0];
      const last = text[text.length - 1];
      let value;
      if (/[a-zA-Z]/.test(last) && UNIT_SCALE[last.toLowerCase()] !== undefined) {
        value = parseFloat(text.slice(0, -1)) * UNIT_SCALE[last.toLowerCase()];
      } else {
        value = parseFloat(text);
      }
      tokens.push({ type: 'NUMBER', value, text, pos: i });
      i += text.length;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '=~', '!~'].includes(two)) {
      tokens.push({ type: 'OP', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>') {
      tokens.push({ type: 'OP', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '=') {
      tokens.push({ type: 'PUNCT', value: '=', pos: i });
      i++;
      continue;
    }
    if ('(),;|'.includes(ch)) {
      tokens.push({ type: 'PUNCT', value: ch, pos: i });
      i++;
      continue;
    }

    const im = rest.match(IDENT_RE);
    if (im) {
      const word = im[0];
      tokens.push({
        type: KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT',
        value: word,
        pos: i,
      });
      i += word.length;
      continue;
    }

    throw new DslSyntaxError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'EOF', value: null, pos: n });
  return tokens;
}
