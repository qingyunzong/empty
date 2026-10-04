'use strict';
const { canonical, crc32hex, ExitError } = require('./util');

const TYPES = new Set(['limits', 'new', 'amend', 'cancel', 'match', 'settle', 'fail']);

// Streaming frame extractor: pulls top-level JSON objects out of a byte stream
// regardless of line boundaries, so frames may be fragmented across lines,
// pretty-printed, or concatenated (JSONL). Anything else is a frame error.
function extractFrames(text) {
  const chunks = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth < 0) throw new ExitError(2, 'unbalanced braces in input stream');
      if (depth === 0) chunks.push(text.slice(start, i + 1));
      continue;
    }
    if (depth === 0 && !/\s/.test(c)) {
      throw new ExitError(2, `unexpected character ${JSON.stringify(c)} between frames`);
    }
  }
  if (inStr || depth !== 0) throw new ExitError(2, 'truncated frame at end of input');
  return chunks.map((src, i) => {
    try {
      return JSON.parse(src);
    } catch (e) {
      throw new ExitError(2, `frame ${i}: invalid JSON: ${e.message}`);
    }
  });
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && v.length > 0;

// crc covers the canonical form of every field except crc itself.
function sign(frame) {
  const { crc, ...rest } = frame;
  return { ...rest, crc: crc32hex(canonical(rest)) };
}

function validateFrame(frame, index) {
  const bad = (m) => { throw new ExitError(2, `frame ${index}: ${m}`); };
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) bad('not an object');
  if (!TYPES.has(frame.type)) bad(`unknown type ${JSON.stringify(frame.type)}`);
  if (!isNonNegInt(frame.seq)) bad('seq must be a non-negative integer');
  if (frame.ts !== undefined && !(typeof frame.ts === 'number' && Number.isFinite(frame.ts) && frame.ts >= 0)) {
    bad('ts must be a non-negative number');
  }
  if (typeof frame.crc !== 'string') bad('missing crc');
  const { crc, ...rest } = frame;
  if (crc32hex(canonical(rest)) !== crc.toLowerCase()) bad('crc mismatch');
  const f = { ...frame, ts: frame.ts === undefined ? 0 : frame.ts };
  switch (frame.type) {
    case 'new':
      if (!isId(f.clOrdId)) bad('new requires clOrdId');
      if (f.side !== 'buy' && f.side !== 'sell') bad('side must be buy|sell');
      if (!isPosInt(f.qty)) bad('qty must be a positive integer');
      if (!isPosInt(f.price)) bad('price must be a positive integer');
      break;
    case 'amend':
      if (!isId(f.clOrdId)) bad('amend requires clOrdId');
      if (!isId(f.origId)) bad('amend requires origId');
      if (f.qty === undefined && f.price === undefined) bad('amend requires qty or price');
      if (f.qty !== undefined && !isPosInt(f.qty)) bad('qty must be a positive integer');
      if (f.price !== undefined && !isPosInt(f.price)) bad('price must be a positive integer');
      break;
    case 'cancel':
      if (!isId(f.origId)) bad('cancel requires origId');
      break;
    case 'match':
      break;
    case 'settle':
      if (f.origId !== undefined && !isId(f.origId)) bad('origId must be a string');
      break;
    case 'fail':
      if (!isId(f.origId)) bad('fail requires origId');
      break;
    case 'limits':
      if (f.funds !== undefined && f.funds !== null && !isNonNegInt(f.funds)) bad('funds must be a non-negative integer or null');
      if (f.securities !== undefined && f.securities !== null && !isNonNegInt(f.securities)) bad('securities must be a non-negative integer or null');
      if (f.window !== undefined && !isPosInt(f.window)) bad('window must be a positive integer');
      break;
    default:
      bad('unreachable');
  }
  return f;
}

module.exports = { extractFrames, validateFrame, sign };
