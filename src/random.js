'use strict';

const { Ledger } = require('./ledger');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成随机小账期：savepoint 立在第 1 日末（日边界），随后跨日随机活动，
// 保证存在未结算后代与已出账后代两条路径。
function buildRandomLedger(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (n) => 1 + Math.floor(rnd() * n);
  const ledger = new Ledger();
  const accounts = ['cash', 'rev', 'fee', 'tax'];
  ledger.openBatch('root');
  const amount = () => int(500) * (rnd() < 0.5 ? 1 : -1);

  for (let i = 0, n = 1 + int(3); i < n; i += 1) {
    ledger.post('root', { account: pick(accounts), amount: amount(), day: 1 });
  }
  if (rnd() < 0.5) {
    const candidates = ledger.entries.filter((e) => e.kind === 'post');
    ledger.correct(pick(candidates).seq, amount());
  }
  const savepoint = ledger.createSavepoint('sp', { batchId: 'root' });

  const openBatches = ['root'];
  let day = 2;
  const rounds = 4 + int(6);
  for (let i = 0; i < rounds; i += 1) {
    const roll = rnd();
    if (roll < 0.3 && openBatches.length < 6) {
      const id = `b${i}`;
      ledger.openBatch(id, pick(openBatches));
      openBatches.push(id);
    } else if (roll < 0.55) {
      const targets = ledger.entries.filter(
        (e) => e.kind === 'post' && (e.status === 'posted' || e.status === 'settled'),
      );
      if (targets.length) ledger.correct(pick(targets).seq, amount());
    } else if (roll < 0.7 && openBatches.length > 1) {
      const id = pick(openBatches.filter((b) => b !== 'root'));
      ledger.settleBatch(id);
      openBatches.splice(openBatches.indexOf(id), 1);
    } else {
      ledger.post(pick(openBatches), { account: pick(accounts), amount: amount(), day });
    }
    if (rnd() < 0.4) day += 1;
  }
  return { ledger, savepoint };
}

module.exports = { buildRandomLedger, mulberry32 };
