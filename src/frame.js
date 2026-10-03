import { crc32 } from './crc32.js';
import { canonical } from './canon.js';

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
    this.code = 'FRAME_ERROR';
  }
}

const OPS = new Set(['new', 'amend', 'cancel', 'match', 'settle', 'fail']);

// Exact field whitelist per op. Unknown fields are a frame error so the
// crc always covers the entire meaningful payload.
const FIELDS = {
  new:    { required: ['op', 'clOrdId', 'side', 'qty', 'price', 'seq', 'crc'], optional: ['acct', 'ts'] },
  amend:  { required: ['op', 'clOrdId', 'origId', 'seq', 'crc'],               optional: ['qty', 'price', 'ts'] },
  cancel: { required: ['op', 'clOrdId', 'origId', 'seq', 'crc'],               optional: ['ts'] },
  match:  { required: ['op', 'clOrdId', 'seq', 'crc'],                         optional: ['ts'] },
  settle: { required: ['op', 'clOrdId', 'origId', 'seq', 'crc'],               optional: ['ts'] },
  fail:   { required: ['op', 'clOrdId', 'origId', 'seq', 'crc'],               optional: ['ts'] },
};

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

export function validateFrame(obj, lineNo = 0) {
  const bad = (m) => new FrameError(`line ${lineNo}: ${m}`);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw bad('frame must be a JSON object');
  const { op } = obj;
  if (!OPS.has(op)) throw bad(`unknown op: ${JSON.stringify(op)}`);
  const spec = FIELDS[op];
  const allowed = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw bad(`unexpected field: ${k}`);
  for (const k of spec.required) if (!(k in obj)) throw bad(`missing field: ${k}`);
  if (!isId(obj.clOrdId)) throw bad('clOrdId must be a non-empty string');
  if ('origId' in obj && !isId(obj.origId)) throw bad('origId must be a non-empty string');
  if (op === 'new') {
    if (obj.side !== 'buy' && obj.side !== 'sell') throw bad('side must be "buy" or "sell"');
    if ('acct' in obj && !isId(obj.acct)) throw bad('acct must be a non-empty string');
  }
  if ('qty' in obj && (!Number.isInteger(obj.qty) || obj.qty <= 0)) throw bad('qty must be a positive integer');
  if ('price' in obj && (!Number.isInteger(obj.price) || obj.price <= 0)) throw bad('price must be a positive integer (minor units)');
  if (op === 'amend' && !('qty' in obj) && !('price' in obj)) throw bad('amend requires qty and/or price');
  if (!Number.isInteger(obj.seq) || obj.seq < 0) throw bad('seq must be a non-negative integer');
  if ('ts' in obj && (!Number.isInteger(obj.ts) || obj.ts < 0)) throw bad('ts must be a non-negative integer');
  if (typeof obj.crc !== 'string' || !/^[0-9a-f]{8}$/.test(obj.crc)) throw bad('crc must be 8 lowercase hex chars');
  const { crc, ...payload } = obj;
  if (crc32(canonical(payload)) !== crc) throw bad(`crc mismatch for clOrdId ${obj.clOrdId}`);
  return obj;
}

function parseFrame(text, lineNo) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new FrameError(`line ${lineNo}: invalid JSON`);
  }
  return validateFrame(obj, lineNo);
}

// Streaming decoder: accepts arbitrary chunks (frames may be split across
// chunk boundaries), yields one validated frame per non-empty line.
export class FrameDecoder {
  constructor() {
    this.buf = '';
    this.lineNo = 0;
  }

  push(chunk) {
    this.buf += chunk;
    const frames = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.lineNo++;
      const t = line.replace(/\r$/, '').trim();
      if (!t) continue;
      frames.push(parseFrame(t, this.lineNo));
    }
    return frames;
  }

  end() {
    const t = this.buf.trim();
    this.buf = '';
    if (!t) return [];
    this.lineNo++;
    return [parseFrame(t, this.lineNo)];
  }
}
