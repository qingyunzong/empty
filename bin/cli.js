#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { Ledger } = require('../src/ledger');
const { planRollback, executeRollback } = require('../src/rollback');
const { replayBalances, deriveExpectedBalances } = require('../src/reference');
const { buildRandomLedger } = require('../src/random');

const short = (h) => `${h.slice(0, 16)}…`;

function printPlan(plan) {
  console.log(`== 回滚计划 savepoint=${plan.savepoint} target=${plan.impact.targetBatch} ==`);
  console.log(`影响区间: seq [${plan.impact.fromSeq}..${plan.impact.toSeq}]`
    + ` day [${plan.impact.fromDay}..${plan.impact.toDay}]`
    + ` 清除批次: [${plan.impact.clearedBatches.join(', ')}]`);
  console.log('撤销清单(未结算):');
  for (const u of plan.undo) {
    console.log(`  - e${u.seq} batch=${u.batchId} ${u.account} ${u.amount} day=${u.day}`);
  }
  if (plan.undo.length === 0) console.log('  (空)');
  console.log('孤儿冲正清单(已出账须先冲正):');
  for (const r of plan.orphanReversals) {
    console.log(`  - e${r.seq} batch=${r.batchId} ${r.account} ${r.amount} day=${r.day}`
      + (r.reversalSeq ? ` -> 冲正 e${r.reversalSeq} (${r.reversalAmount})` : ' -> 待生成冲正'));
  }
  if (plan.orphanReversals.length === 0) console.log('  (空)');
  console.log('保留更正(禁止复活旧值):');
  for (const c of plan.preservedCorrections) {
    console.log(`  - e${c.seq} 覆盖 e${c.supersedes} ${c.account} -> ${c.amount}`);
  }
  if (plan.preservedCorrections.length === 0) console.log('  (空)');
  console.log(`执行前哈希: ${plan.preHash}`);
}

function buildDemo() {
  const ledger = new Ledger();
  ledger.openBatch('G');
  ledger.post('G', { account: 'cash', amount: 1000, day: 1 });
  ledger.post('G', { account: 'rev', amount: -1000, day: 1 });
  ledger.createSavepoint('sp-eod1', { batchId: 'G' }); // 第 1 日日终边界
  ledger.openBatch('P', 'G');
  ledger.openBatch('C', 'P');
  ledger.openBatch('S', 'G');
  ledger.post('P', { account: 'cash', amount: 200, day: 2 });
  ledger.post('C', { account: 'fee', amount: 50, day: 2 });
  ledger.post('S', { account: 'cash', amount: 300, day: 2 });
  ledger.post('S', { account: 'rev', amount: -300, day: 2 });
  ledger.settleBatch('S'); // 已出账后代：须先冲正
  ledger.correct(1, 1200); // 快照后更正：回滚不得复活旧值
  return ledger;
}

function cmdDemo() {
  const ledger = buildDemo();
  const plan = planRollback(ledger, 'sp-eod1');
  printPlan(plan);
  const result = executeRollback(ledger, plan);
  console.log('== 执行结果 ==');
  console.log(`孤儿冲正批次: ${result.orphanBatchId}`);
  console.log(`执行前哈希: ${result.preHash}`);
  console.log(`执行后哈希: ${result.postHash}`);
  if (plan.orphanReversals.length) {
    console.log('孤儿冲正清单(已生成):');
    for (const r of plan.orphanReversals) {
      console.log(`  - e${r.seq} batch=${r.batchId} ${r.account} ${r.amount} -> 冲正 e${r.reversalSeq} (${r.reversalAmount})`);
    }
  }
  console.log(`余额: ${JSON.stringify(ledger.balances())}`);
  const replay = replayBalances(ledger.entries);
  const derived = deriveExpectedBalances(ledger, ledger.savepoints.get('sp-eod1'), plan);
  console.log(`逐笔重放对照: ${JSON.stringify(replay)}`);
  console.log(`快照推导对照: ${JSON.stringify(derived)}`);
  const ok = JSON.stringify(ledger.balances()) === JSON.stringify(replay)
    && JSON.stringify(replay) === JSON.stringify(derived);
  console.log(`一致性: ${ok ? 'OK' : 'MISMATCH'}`);
  if (!ok) process.exitCode = 1;
}

function cmdCheck(values) {
  const seeds = Number(values.seeds || 50);
  let failed = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const { ledger, savepoint } = buildRandomLedger(seed);
    const plan = planRollback(ledger, 'sp');
    const result = executeRollback(ledger, plan);
    const actual = JSON.stringify(ledger.balances());
    const replay = JSON.stringify(replayBalances(ledger.entries));
    const derived = JSON.stringify(deriveExpectedBalances(ledger, savepoint, plan));
    const ok = actual === replay && replay === derived;
    if (!ok) failed += 1;
    console.log(`seed=${seed} undo=${plan.undo.length} reversals=${plan.orphanReversals.length}`
      + ` pre=${short(result.preHash)} post=${short(result.postHash)} ${ok ? 'OK' : 'MISMATCH'}`);
  }
  console.log(`对照完成: ${seeds - failed}/${seeds} 通过`);
  if (failed) process.exitCode = 1;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: 'string', default: '50' } },
  });
  const cmd = positionals[0];
  if (cmd === 'demo') cmdDemo();
  else if (cmd === 'check') cmdCheck(values);
  else {
    console.error('usage: node bin/cli.js <demo|check> [--seeds N]');
    process.exitCode = 2;
  }
}

main();
