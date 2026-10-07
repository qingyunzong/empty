'use strict';

class RowError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = 'RowError';
    this.file = file;
    this.line = line;
  }
}

function requireFields(obj, fields, file, line) {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new RowError(file, line, `missing field "${field}"`);
    }
  }
}

function toId(value, file, line) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new RowError(file, line, `invalid orderId ${JSON.stringify(value)}`);
  }
  const id = String(value);
  if (id === '') {
    throw new RowError(file, line, 'empty orderId');
  }
  return id;
}

function toSymbol(value, file, line) {
  if (typeof value !== 'string' || value === '') {
    throw new RowError(file, line, `invalid symbol ${JSON.stringify(value)}`);
  }
  return value;
}

function toQty(value, file, line) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RowError(file, line, `invalid qty ${JSON.stringify(value)}: must be a number > 0`);
  }
  return value;
}

function toPrice(value, file, line) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RowError(file, line, `invalid price ${JSON.stringify(value)}: must be integer cents`);
  }
  return value;
}

function toTs(value, file, line) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RowError(file, line, `invalid ts ${JSON.stringify(value)}: must be epoch ms >= 0`);
  }
  return value;
}

function parseTradeRow(obj, file, line) {
  requireFields(obj, ['orderId', 'symbol', 'qty', 'price', 'ts'], file, line);
  return {
    orderId: toId(obj.orderId, file, line),
    symbol: toSymbol(obj.symbol, file, line),
    qty: toQty(obj.qty, file, line),
    price: toPrice(obj.price, file, line),
    ts: toTs(obj.ts, file, line),
    line,
  };
}

function parseCancelRow(obj, file, line) {
  requireFields(obj, ['orderId', 'symbol', 'qty', 'ts'], file, line);
  return {
    orderId: toId(obj.orderId, file, line),
    symbol: toSymbol(obj.symbol, file, line),
    qty: toQty(obj.qty, file, line),
    ts: toTs(obj.ts, file, line),
    line,
  };
}

function parseJsonl(text, file, parseRow) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const line = idx + 1;
    if (raw.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new RowError(file, line, 'invalid JSON');
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new RowError(file, line, 'row must be a JSON object');
    }
    rows.push(parseRow(obj, file, line));
  }
  return rows;
}

module.exports = { RowError, parseJsonl, parseTradeRow, parseCancelRow };
