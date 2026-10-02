export class LedgerError extends Error {
  constructor(code, message, line = null) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.line = line;
  }
}

const CCY_RE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const INT_RE = /^-?\d+$/;

function asId(value, field, line) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  throw new LedgerError('E_PARSE', `field "${field}" must be a non-empty string or integer`, line);
}

function asCcy(value, field, line) {
  if (typeof value === 'string' && CCY_RE.test(value)) return value;
  throw new LedgerError('E_PARSE', `field "${field}" must be a currency code like "USD"`, line);
}

function asInt(value, field, line) {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && INT_RE.test(value)) return BigInt(value);
  throw new LedgerError('E_PARSE', `field "${field}" must be an integer (number or string)`, line);
}

export function parseEvent(obj, line = null) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new LedgerError('E_PARSE', 'event must be a JSON object', line);
  }
  const eid = obj.eid === undefined ? `e${line ?? '?'}` : asId(obj.eid, 'eid', line);
  switch (obj.type) {
    case 'addInvoice': {
      const id = asId(obj.id, 'id', line);
      const ccy = asCcy(obj.ccy, 'ccy', line);
      const num = asInt(obj.num, 'num', line);
      const den = asInt(obj.den, 'den', line);
      if (den === 0n) throw new LedgerError('E_PARSE', 'field "den" must not be zero', line);
      return { type: 'addInvoice', eid, id, ccy, num, den, line };
    }
    case 'setRate': {
      if (typeof obj.pair !== 'string') {
        throw new LedgerError('E_PARSE', 'field "pair" must be a string like "USD/CNY"', line);
      }
      const parts = obj.pair.split('/');
      if (parts.length !== 2 || !CCY_RE.test(parts[0]) || !CCY_RE.test(parts[1])) {
        throw new LedgerError('E_PARSE', `invalid currency pair: ${obj.pair}`, line);
      }
      if (parts[0] === parts[1]) {
        throw new LedgerError('E_PARSE', `currency pair sides must differ: ${obj.pair}`, line);
      }
      const num = asInt(obj.num, 'num', line);
      const den = asInt(obj.den, 'den', line);
      if (num <= 0n || den <= 0n) {
        throw new LedgerError('E_PARSE', 'exchange rate num/den must be positive', line);
      }
      return { type: 'setRate', eid, pair: obj.pair, from: parts[0], to: parts[1], num, den, line };
    }
    case 'correct': {
      const refId = asId(obj.refId, 'refId', line);
      const newNum = asInt(obj.newNum, 'newNum', line);
      const newDen = asInt(obj.newDen, 'newDen', line);
      if (newDen === 0n) throw new LedgerError('E_PARSE', 'field "newDen" must not be zero', line);
      return { type: 'correct', eid, refId, newNum, newDen, line };
    }
    case 'undo': {
      const eventId = asId(obj.eventId, 'eventId', line);
      return { type: 'undo', eid, eventId, line };
    }
    default:
      throw new LedgerError('E_PARSE', `unknown event type: ${JSON.stringify(obj.type)}`, line);
  }
}

export function parseLine(text, lineNo) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new LedgerError('E_PARSE', `invalid JSON: ${e.message}`, lineNo);
  }
  return parseEvent(obj, lineNo);
}
