import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SettleError, E } from './errors.js';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function readJsonl(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    throw new SettleError(E.IO, `cannot read ${path}: ${err.message}`);
  }
  const digest = sha256(buf);
  const text = buf.toString('utf8');
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new SettleError(E.PARSE, `${path}:${i + 1}: invalid JSON`);
    }
  }
  return { rows, digest };
}

const REQUIRED_TRADE_FIELDS = ['trade_id', 'counterparty', 'currency', 'trade_date', 'amount'];

export function validateTrade(t, source) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    throw new SettleError(E.SCHEMA, `${source}: trade must be an object`);
  }
  for (const f of REQUIRED_TRADE_FIELDS) {
    if (!(f in t)) throw new SettleError(E.SCHEMA, `${source}: missing field ${f}`);
    if (t[f] === null || t[f] === undefined) {
      throw new SettleError(E.BAD_NULL, `${source}: NULL not allowed in ${f}`);
    }
  }
  if (typeof t.trade_id !== 'string') throw new SettleError(E.SCHEMA, `${source}: trade_id must be a string`);
  if (typeof t.counterparty !== 'string') throw new SettleError(E.SCHEMA, `${source}: counterparty must be a string`);
  if (typeof t.currency !== 'string') throw new SettleError(E.SCHEMA, `${source}: currency must be a string`);
  if (typeof t.trade_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.trade_date)) {
    throw new SettleError(E.SCHEMA, `${source}: trade_date must be YYYY-MM-DD`);
  }
  if (typeof t.amount !== 'number' || !Number.isFinite(t.amount)) {
    throw new SettleError(E.SCHEMA, `${source}: amount must be a finite number`);
  }
  if ('fee' in t && t.fee !== null && (typeof t.fee !== 'number' || !Number.isFinite(t.fee))) {
    throw new SettleError(E.SCHEMA, `${source}: fee must be a number or NULL`);
  }
  if (!('fee' in t)) t.fee = null;
}

export function validateAccount(a, source) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) {
    throw new SettleError(E.SCHEMA, `${source}: account must be an object`);
  }
  if (a.counterparty === null || a.counterparty === undefined) {
    throw new SettleError(E.BAD_NULL, `${source}: NULL not allowed in counterparty`);
  }
  if (typeof a.counterparty !== 'string') {
    throw new SettleError(E.SCHEMA, `${source}: counterparty must be a string`);
  }
}

export function validateEvent(ev, source) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new SettleError(E.SCHEMA, `${source}: event must be an object`);
  }
  if (ev.op === 'insert') {
    if (!('trade' in ev)) throw new SettleError(E.SCHEMA, `${source}: insert event needs trade`);
    validateTrade(ev.trade, source);
  } else if (ev.op === 'revoke') {
    if (ev.trade_id === null || ev.trade_id === undefined) {
      throw new SettleError(E.BAD_NULL, `${source}: NULL not allowed in trade_id`);
    }
    if (typeof ev.trade_id !== 'string') throw new SettleError(E.SCHEMA, `${source}: trade_id must be a string`);
  } else {
    throw new SettleError(E.BAD_EVENT, `${source}: unknown op ${JSON.stringify(ev.op)}`);
  }
}
