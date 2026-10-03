'use strict';

class ParseError extends Error {
  constructor(message, line) {
    super(line != null ? `line ${line}: ${message}` : message);
    this.name = 'ParseError';
    this.line = line;
  }
}

const OP_WORDS = new Set(['commit', 'mask', 'rollback']);

function lex(source) {
  const lines = String(source).split(/\r?\n/);
  const tokens = [];
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) return;
    if (text.startsWith('note:')) {
      tokens.push({ kind: 'note', text: text.slice('note:'.length).trim(), line: lineNo });
      return;
    }
    tokens.push(parseEvent(text, lineNo));
  });
  return tokens;
}

function parseEvent(text, lineNo) {
  const words = text.split(/\s+/);
  if (words.length < 4) {
    throw new ParseError(`malformed event line: "${text}"`, lineNo);
  }
  const [node, clockRaw, op, key, ...rest] = words;
  if (!/^\d+$/.test(clockRaw)) {
    throw new ParseError(
      `missing or invalid logical clock for node "${node}" (got "${clockRaw}")`,
      lineNo,
    );
  }
  if (!OP_WORDS.has(op)) {
    throw new ParseError(`unknown op "${op}" (expected commit | mask | rollback)`, lineNo);
  }
  const clock = Number(clockRaw);
  if (!Number.isSafeInteger(clock)) {
    throw new ParseError(`logical clock "${clockRaw}" is out of range`, lineNo);
  }
  if (!key) throw new ParseError('missing observation key', lineNo);

  const afterIdx = rest.indexOf('after');
  const valuePart = afterIdx === -1 ? rest : rest.slice(0, afterIdx);
  const afterPart = afterIdx === -1 ? [] : rest.slice(afterIdx + 1);

  let value = null;
  if (op === 'commit') {
    if (valuePart[0] !== '=' || valuePart.length < 2) {
      throw new ParseError('commit requires "= <value>"', lineNo);
    }
    value = valuePart.slice(1).join(' ');
  } else if (valuePart.length > 0) {
    throw new ParseError(`unexpected tokens for ${op}: "${valuePart.join(' ')}"`, lineNo);
  }

  const after = afterPart.map((tok) => {
    const m = /^([^\s@,]+)@(\d+),?$/.exec(tok);
    if (!m) throw new ParseError(`invalid causal dependency "${tok}"`, lineNo);
    return { node: m[1], clock: Number(m[2]) };
  });

  return { kind: 'event', node, clock, op, key, value, after, line: lineNo };
}

module.exports = { lex, ParseError };
