'use strict';

const { canonicalEvent } = require('./events');
const { FlowError } = require('./errors');

const SPECIAL = new Set(['(', ')', '|', '*', '+', '?']);

function parseRegex(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new FlowError('PARSE_ERROR', 'flow regex is empty');
  }
  let pos = 0;

  function skipWs() {
    while (pos < source.length && /\s/.test(source[pos])) pos += 1;
  }

  function peek() {
    skipWs();
    return pos < source.length ? source[pos] : null;
  }

  function parseAlt() {
    const options = [parseConcat()];
    while (peek() === '|') {
      pos += 1;
      options.push(parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  function parseConcat() {
    const parts = [];
    for (;;) {
      const ch = peek();
      if (ch === null || ch === ')' || ch === '|') break;
      parts.push(parsePostfix());
    }
    if (parts.length === 0) return { type: 'eps' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  function parsePostfix() {
    let node = parseAtom();
    for (;;) {
      const ch = peek();
      if (ch === '*') { pos += 1; node = { type: 'star', node }; }
      else if (ch === '+') { pos += 1; node = { type: 'plus', node }; }
      else if (ch === '?') { pos += 1; node = { type: 'opt', node }; }
      else break;
    }
    return node;
  }

  function parseAtom() {
    const ch = peek();
    if (ch === null) throw new FlowError('PARSE_ERROR', 'unexpected end of regex');
    if (ch === '(') {
      pos += 1;
      const inner = parseAlt();
      if (peek() !== ')') throw new FlowError('PARSE_ERROR', `missing ')' at offset ${pos}`);
      pos += 1;
      return inner;
    }
    if (ch === ')' || ch === '|' || ch === '*' || ch === '+' || ch === '?') {
      throw new FlowError('PARSE_ERROR', `unexpected '${ch}' at offset ${pos}`);
    }
    const start = pos;
    while (pos < source.length && !SPECIAL.has(source[pos]) && !/\s/.test(source[pos])) pos += 1;
    const word = source.slice(start, pos);
    if (word === 'eps' || word === 'ε') return { type: 'eps' };
    if (word === 'empty' || word === '∅') return { type: 'empty' };
    const event = canonicalEvent(word);
    if (event === null) {
      throw new FlowError('PARSE_ERROR', `unknown event '${word}' in flow regex`);
    }
    return { type: 'lit', event };
  }

  const ast = parseAlt();
  if (peek() !== null) throw new FlowError('PARSE_ERROR', `unexpected '${peek()}' at offset ${pos}`);

  const eventsUsed = new Set();
  (function walk(node) {
    if (node.type === 'lit') eventsUsed.add(node.event);
    for (const key of ['node', 'parts', 'options']) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child) walk(child);
    }
  })(ast);

  return { ast, eventsUsed };
}

module.exports = { parseRegex };
