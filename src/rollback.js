'use strict';

const { CODES, LedgerError } = require('./errors');
const { hashState } = require('./hash');

function subtreeIds(ledger, rootId) {
  const result = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    result.push(id);
    for (const b of ledger.batches.values()) {
      if (b.parentId === id) stack.push(b.id);
    }
  }
  return result;
}

function loadSavepoint(ledger, name) {
  const sp = ledger.savepoints.get(name);
  if (!sp) throw new LedgerError(CODES.SNAP, `unknown savepoint: ${name}`);
  if (sp.consumed) throw new LedgerError(CODES.SNAP, `savepoint already consumed: ${name}`);
  if (hashState(sp.snapshot) !== sp.hash) {
    throw new LedgerError(CODES.SNAP, `savepoint integrity failure: ${name}`);
  }
  const target = ledger.batches.get(sp.batchId);
  if (!target || target.status === 'rolled_back') {
    throw new LedgerError(CODES.DEPEND, `savepoint target batch unavailable: ${sp.batchId}`);
  }
  return sp;
}

// 生成回滚计划：只撤销目标批次 savepoint 之后的分录；后代批次整体撤销，
// 其中已出账（settled）分录必须先生成冲正（孤儿冲正），否则 E_ORPHAN。
function planRollback(ledger, name, { generateReversals = true } = {}) {
  const sp = loadSavepoint(ledger, name);
  const scope = new Set(subtreeIds(ledger, sp.batchId));
  const undo = [];
  const orphanReversals = [];
  for (const e of ledger.entries) {
    if (e.kind !== 'post' || !scope.has(e.batchId)) continue;
    if (e.status !== 'posted' && e.status !== 'settled') continue;
    const survivesInSnapshot = e.batchId === sp.batchId && e.seq <= sp.atSeq;
    if (survivesInSnapshot) continue;
    const item = {
      seq: e.seq, batchId: e.batchId, account: e.account,
      amount: ledger.effectiveAmount(e), day: e.day, settled: e.status === 'settled',
    };
    if (e.status === 'settled') orphanReversals.push(item);
    else undo.push(item);
  }
  if (orphanReversals.length > 0 && !generateReversals) {
    throw new LedgerError(CODES.ORPHAN, 'settled entries require reversal before rollback', {
      blocking: orphanReversals.map((r) => r.seq),
    });
  }
  // 快照之后的更正若作用于快照内存活分录，必须保留，不得复活被覆盖的旧值。
  const preservedCorrections = ledger.entries
    .filter((e) => e.kind === 'correction' && e.status !== 'rolled_back'
      && e.seq > sp.atSeq && e.supersedes <= sp.atSeq
      && ledger.entries[e.supersedes - 1].batchId === sp.batchId)
    .map((e) => ({ seq: e.seq, supersedes: e.supersedes, account: e.account, amount: e.amount }));
  const affected = [...undo, ...orphanReversals];
  const seqs = affected.map((x) => x.seq);
  const days = affected.map((x) => x.day);
  const impact = {
    targetBatch: sp.batchId,
    clearedBatches: [...scope].filter((id) => id !== sp.batchId).sort(),
    fromSeq: seqs.length ? Math.min(...seqs) : sp.atSeq + 1,
    toSeq: seqs.length ? Math.max(...seqs) : sp.atSeq,
    fromDay: days.length ? Math.min(...days) : sp.day,
    toDay: days.length ? Math.max(...days) : sp.day,
  };
  return {
    savepoint: name,
    atSeq: sp.atSeq,
    day: sp.day,
    undo,
    orphanReversals,
    preservedCorrections,
    impact,
    preHash: ledger.stateHash(),
  };
}

function verifySnapshotRestore(ledger, sp) {
  const snapEntries = sp.snapshot.entries.filter((e) => e.batchId === sp.batchId);
  for (const s of snapEntries) {
    const current = ledger.entries[s.seq - 1];
    if (current.status !== 'posted' && current.status !== 'settled') {
      throw new LedgerError(CODES.SNAP, `snapshot entry ${s.seq} not restorable (${current.status})`);
    }
    let head = current;
    let lastCorrection = null;
    while (head.correctedBy !== null) {
      lastCorrection = head.correctedBy;
      head = ledger.entries[head.correctedBy - 1];
    }
    const effective = ledger.effectiveAmount(current);
    if (lastCorrection !== null && lastCorrection > sp.atSeq) {
      // 快照后的更正被保留：禁止复活被覆盖的旧交易值。
      if (effective !== head.amount) {
        throw new LedgerError(CODES.SNAP, `corrected entry ${s.seq} resurrected old value`);
      }
    } else if (effective !== s.amount) {
      throw new LedgerError(CODES.SNAP, `snapshot mismatch at entry ${s.seq}`);
    }
  }
}

function executeRollback(ledger, plan) {
  const sp = loadSavepoint(ledger, plan.savepoint);
  const preHash = ledger.stateHash();
  if (preHash !== plan.preHash) {
    throw new LedgerError(CODES.SNAP, `stale plan for savepoint: ${plan.savepoint}`);
  }
  // 1) 先冲正：已出账分录生成孤儿冲正分录（挂在无父级的孤儿批次，绝不悬空）。
  let orphanBatchId = null;
  if (plan.orphanReversals.length) {
    orphanBatchId = `__orphan__:${plan.savepoint}`;
    ledger.openBatch(orphanBatchId, null);
    for (const r of plan.orphanReversals) {
      const orig = ledger.entries[r.seq - 1];
      const entry = {
        seq: ++ledger.seq, batchId: orphanBatchId, kind: 'reversal', account: r.account,
        amount: -ledger.effectiveAmount(orig), day: r.day,
        status: 'posted', correctedBy: null, supersedes: null, reverses: r.seq,
      };
      ledger.entries.push(entry);
      orig.status = 'reversed';
      r.reversalSeq = entry.seq;
      r.reversalAmount = entry.amount;
    }
    ledger.batches.get(orphanBatchId).status = 'settled';
  }
  // 2) 再撤销：未结算分录直接作废；作用于被撤销分录的更正一并作废。
  for (const u of plan.undo) {
    ledger.entries[u.seq - 1].status = 'rolled_back';
  }
  for (const e of ledger.entries) {
    if (e.kind !== 'correction' || e.status === 'rolled_back') continue;
    const target = ledger.entries[e.supersedes - 1];
    if (target.status === 'rolled_back' || target.status === 'reversed') e.status = 'rolled_back';
  }
  // 3) 后代批次整体标记回滚。
  for (const id of plan.impact.clearedBatches) {
    ledger.batches.get(id).status = 'rolled_back';
  }
  // 4) 禁止悬空恢复：任何在账分录不得挂在已回滚批次上。
  for (const e of ledger.entries) {
    if (e.status !== 'posted' && e.status !== 'settled') continue;
    const batch = ledger.batches.get(e.batchId);
    if (!batch || batch.status === 'rolled_back') {
      throw new LedgerError(CODES.ORPHAN, `dangling entry ${e.seq} on rolled-back batch ${e.batchId}`);
    }
  }
  // 5) 快照恢复校验：目标批次存活分录与快照一致（保留后续更正）。
  verifySnapshotRestore(ledger, sp);
  sp.consumed = true;
  const postHash = ledger.stateHash();
  return { preHash, postHash, orphanBatchId };
}

module.exports = { planRollback, executeRollback, subtreeIds };
