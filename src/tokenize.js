'use strict';

const { RiskError, CODES } = require('./errors');

// Five dimensions of a transaction token, in canonical tuple order:
// amount tier, time slot, region, channel, history flag.
const DIM_ORDER = ['a', 't', 'r', 'c', 'h'];

const DIM_VALUES = {
  a: ['a0', 'a1', 'a2', 'a3'],
  t: ['t0', 't1', 't2', 't3'],
  r: ['r0', 'r1', 'r2'],
  c: ['c0', 'c1', 'c2'],
  h: ['h0', 'h1'],
};

// Full alphabet: every concrete 5-tuple, sorted lexicographically.
// Because every field is fixed-width, string order equals tuple order.
const ALPHABET = [];
for (const a of DIM_VALUES.a)
  for (const t of DIM_VALUES.t)
    for (const r of DIM_VALUES.r)
      for (const c of DIM_VALUES.c)
        for (const h of DIM_VALUES.h) ALPHABET.push(a + t + r + c + h);

const TOKEN_INDEX = new Map(ALPHABET.map((tok, i) => [tok, i]));

function amountTier(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  if (amount < 100) return 'a0';
  if (amount < 1000) return 'a1';
  if (amount < 10000) return 'a2';
  return 'a3';
}

function timeSlot(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour < 6) return 't0';
  if (hour < 12) return 't1';
  if (hour < 18) return 't2';
  return 't3';
}

const REGION_MAP = { domestic: 'r0', crossborder: 'r1', sanctioned: 'r2' };
const CHANNEL_MAP = { pos: 'c0', online: 'c1', atm: 'c2' };
const HISTORY_MAP = { clean: 'h0', flagged: 'h1' };

// Transaction -> canonical token string, e.g. "a2t3r1c1h1".
function tokenizeTx(tx) {
  const a = amountTier(tx.amount);
  const t = timeSlot(tx.hour);
  const r = REGION_MAP[tx.region];
  const c = CHANNEL_MAP[tx.channel];
  const h = HISTORY_MAP[tx.history];
  if (a === null || t === null || r === undefined || c === undefined || h === undefined) {
    throw new RiskError(
      CODES.TOKEN_UNKNOWN,
      `cannot tokenize transaction ${JSON.stringify(tx.id)}: unknown dimension value`
    );
  }
  return a + t + r + c + h;
}

module.exports = { DIM_ORDER, DIM_VALUES, ALPHABET, TOKEN_INDEX, tokenizeTx };
