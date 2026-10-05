'use strict';

const { RcError } = require('./errors');

// Token = 5 chars: <amount><period><region><channel><history>
// Component order defines the lexicographic order of the token alphabet.
const POSITIONS = [
  ['L', 'M', 'H', 'X'], // amount bucket: <100, <1000, <10000, >=10000
  ['N', 'M', 'A', 'E'], // period: night 0-5, morning 6-11, afternoon 12-17, evening 18-23
  ['D', 'F'],           // region: domestic, foreign
  ['P', 'E', 'A'],      // channel: pos, ecom, atm
  ['0', '1'],           // history flag: clean, flagged
];

const ALPHABET = [];
for (const a of POSITIONS[0])
  for (const p of POSITIONS[1])
    for (const r of POSITIONS[2])
      for (const c of POSITIONS[3])
        for (const h of POSITIONS[4])
          ALPHABET.push(a + p + r + c + h);

const TOKEN_INDEX = new Map(ALPHABET.map((t, i) => [t, i]));
const ALPHABET_SIZE = ALPHABET.length;

function amountBucket(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RcError('TOKEN_UNKNOWN', `unknown amount: ${amount}`);
  }
  if (amount < 100) return 'L';
  if (amount < 1000) return 'M';
  if (amount < 10000) return 'H';
  return 'X';
}

function periodBucket(hour) {
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RcError('TOKEN_UNKNOWN', `unknown hour: ${hour}`);
  }
  if (hour < 6) return 'N';
  if (hour < 12) return 'M';
  if (hour < 18) return 'A';
  return 'E';
}

const REGION_MAP = { domestic: 'D', foreign: 'F' };
const CHANNEL_MAP = { pos: 'P', ecom: 'E', atm: 'A' };

function tokenizeTx(tx) {
  const amount = amountBucket(tx.amount);
  const period = periodBucket(tx.hour);
  const region = REGION_MAP[tx.region];
  if (region === undefined) {
    throw new RcError('TOKEN_UNKNOWN', `unknown region: ${tx.region}`);
  }
  const channel = CHANNEL_MAP[tx.channel];
  if (channel === undefined) {
    throw new RcError('TOKEN_UNKNOWN', `unknown channel: ${tx.channel}`);
  }
  let history;
  if (tx.history === true || tx.history === 1 || tx.history === '1') history = '1';
  else if (tx.history === false || tx.history === 0 || tx.history === '0' || tx.history == null) history = '0';
  else throw new RcError('TOKEN_UNKNOWN', `unknown history: ${tx.history}`);
  return amount + period + region + channel + history;
}

module.exports = {
  POSITIONS,
  ALPHABET,
  ALPHABET_SIZE,
  TOKEN_INDEX,
  tokenizeTx,
  amountBucket,
  periodBucket,
};
