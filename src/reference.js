'use strict';

// 参考模型：对追加日志逐笔重放，独立推导最终余额，用于对照回滚执行结果。
// 口径与 Ledger.balances 一致：rolled_back 分录抹除；reversed 原分录仍在账，
// reversal 分录以负额对冲；correction 修改原分录金额（rolled_back 的更正如未发生）。
function replayBalances(log) {
  const bySeq = new Map(); // seq -> { account, amount, booked }
  const balances = new Map();
  const add = (account, amount) => balances.set(account, (balances.get(account) || 0) + amount);
  for (const e of log) {
    if (e.kind === 'correction') {
      if (e.status === 'rolled_back') continue;
      const orig = bySeq.get(e.supersedes);
      if (orig && orig.booked) {
        add(orig.account, -orig.amount);
        orig.amount = e.amount;
        add(orig.account, e.amount);
      }
      continue;
    }
    if (e.kind === 'reversal') {
      add(e.account, e.amount);
      continue;
    }
    const booked = e.status !== 'rolled_back';
    const record = { account: e.account, amount: e.amount, booked };
    bySeq.set(e.seq, record);
    if (booked) add(e.account, e.amount);
  }
  const out = {};
  for (const [k, v] of [...balances.entries()].sort()) if (v !== 0) out[k] = v;
  return out;
}

// 快照推导：从 savepoint 快照 + 回滚计划元数据独立推导回滚后的期望余额。
// 不读取回滚执行后的任何分录状态，只使用快照、计划与快照后作用域外的新分录。
function deriveExpectedBalances(ledger, savepoint, plan) {
  const cleared = new Set(plan.impact.clearedBatches);
  const scope = new Set([...cleared, savepoint.batchId]);
  const balances = new Map();
  const add = (account, amount) => balances.set(account, (balances.get(account) || 0) + amount);
  // 快照中属于目标批次的分录存活；后代批次整体清除（未结算作废 / 已结算冲正后净零）。
  for (const s of savepoint.snapshot.entries) {
    if (s.batchId !== savepoint.batchId) continue;
    add(s.account, s.amount);
  }
  // 快照后对被保留分录的更正：按差额调整，不得复活旧值。
  // 同一分录的链式更正只取链头（最大 seq），避免重复累计。
  const headBySupersedes = new Map();
  for (const c of plan.preservedCorrections) {
    const prev = headBySupersedes.get(c.supersedes);
    if (!prev || c.seq > prev.seq) headBySupersedes.set(c.supersedes, c);
  }
  for (const c of headBySupersedes.values()) {
    const snapEntry = savepoint.snapshot.entries.find((s) => s.seq === c.supersedes);
    if (snapEntry) add(c.account, c.amount - snapEntry.amount);
  }
  // 快照之后、回滚作用域之外的正常分录继续生效。
  for (const e of ledger.entries) {
    if (e.seq <= savepoint.atSeq || e.kind !== 'post') continue;
    if (scope.has(e.batchId)) continue;
    if (e.status !== 'posted' && e.status !== 'settled') continue;
    add(e.account, ledger.effectiveAmount(e));
  }
  const out = {};
  for (const [k, v] of [...balances.entries()].sort()) if (v !== 0) out[k] = v;
  return out;
}

module.exports = { replayBalances, deriveExpectedBalances };
