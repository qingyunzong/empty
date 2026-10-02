// Lexer for the planning DSL.
// Tokens: ident, kw, int, duration (30m/2h/1d), time (08:00), instant (@2026-10-05T08:00),
// operators and punctuation. '#' starts a line comment.

export class LexError extends Error {
  constructor(msg, line) {
    super(`line ${line}: ${msg}`);
    this.name = 'LexError';
  }
}

export const KEYWORDS = new Set([
  'line', 'calendar', 'shift', 'maintenance', 'for', 'let', 'template',
  'job', 'constraint', 'duration', 'priority', 'lines',
  'add-job', 'move-job', 'savepoint', 'rollback', 'commit',
]);

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const push = (t, v, pos) => tokens.push({ t, v, line, pos });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=' ||
        two === '<=' || two === '>=') {
      push('op', two, i); i += 2; continue;
    }
    if ('{}(),=<>+-!'.includes(c)) { push('punct', c, i); i++; continue; }
    if (c === '@') {
      const m = /^@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(src.slice(i));
      if (!m) throw new LexError('malformed instant literal (want @YYYY-MM-DDTHH:MM)', line);
      push('instant', m[0], i); i += m[0].length; continue;
    }
    if (c >= '0' && c <= '9') {
      const mt = /^\d{2}:\d{2}/.exec(src.slice(i));
      if (mt) { push('time', mt[0], i); i += mt[0].length; continue; }
      const mn = /^\d+/.exec(src.slice(i));
      const num = mn[0];
      const unit = src[i + num.length];
      if (unit === 'h' || unit === 'm' || unit === 'd') {
        push('duration', num + unit, i); i += num.length + 1; continue;
      }
      push('int', num, i); i += num.length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const rest = src.slice(i);
      const km = /^(add-job|move-job)\b/.exec(rest);
      if (km) { push('kw', km[1], i); i += km[1].length; continue; }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      const w = m[0];
      push(KEYWORDS.has(w) ? 'kw' : 'ident', w, i);
      i += w.length; continue;
    }
    throw new LexError(`unexpected character '${c}'`, line);
  }
  tokens.push({ t: 'eof', v: '', line, pos: src.length });
  return tokens;
}

const EPOCH_MIN = Date.UTC(2026, 0, 1) / 60000; // instants are minutes since 2026-01-01T00:00Z

export function durationValue(text) {
  const n = parseInt(text.slice(0, -1), 10);
  const unit = text[text.length - 1];
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  return n * 1440; // 'd'
}

export function instantValue(text) {
  const m = /^@(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  const abs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  return abs - EPOCH_MIN;
}

export function timeValue(text) {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

export function instantString(minutes) {
  return new Date((EPOCH_MIN + minutes) * 60000).toISOString();
}
