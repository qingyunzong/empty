'use strict';

const fs = require('fs');

// 预写日志：filePath 为 null 时退化为内存日志（便于测试）
class Wal {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.memory = [];
  }
  append(record) {
    if (this.filePath) {
      const fd = fs.openSync(this.filePath, 'a');
      try {
        fs.writeSync(fd, JSON.stringify(record) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      this.memory.push(record);
    }
  }
  readAll() {
    if (!this.filePath) return [...this.memory];
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }
}

// 冻结条目: {account, cash} 或 {account, security, quantity}
class Ledger {
  constructor(accounts, wal = new Wal(null)) {
    this.wal = wal;
    this.avail = new Map();
    for (const acc of accounts) {
      this.avail.set(acc.id, {
        cash: acc.cash ?? 0,
        securities: { ...(acc.securities ?? {}) },
      });
    }
    this.holds = new Map(); // pairId -> [冻结条目]
  }

  get(accId) {
    return this.avail.get(accId);
  }

  snapshot() {
    return new Map([...this.avail].map(([id, v]) => [id, {
      cash: v.cash,
      securities: { ...v.securities },
    }]));
  }

  frozenOf(accId) {
    const res = { cash: 0, securities: {} };
    for (const entries of this.holds.values()) {
      for (const e of entries) {
        if (e.account !== accId) continue;
        if (e.cash) res.cash += e.cash;
        if (e.security) res.securities[e.security] = (res.securities[e.security] ?? 0) + e.quantity;
      }
    }
    return res;
  }

  _apply(entries, sign) {
    for (const e of entries) {
      const av = this.avail.get(e.account);
      if (!av) throw new Error(`账户不存在: ${e.account}`);
      if (e.cash) {
        if (sign > 0 && av.cash < e.cash) throw new Error(`账户 ${e.account} 现金不足`);
        av.cash -= sign * e.cash;
      }
      if (e.security) {
        const cur = av.securities[e.security] ?? 0;
        if (sign > 0 && cur < e.quantity) throw new Error(`账户 ${e.account} 证券 ${e.security} 不足`);
        av.securities[e.security] = cur - sign * e.quantity;
      }
    }
  }

  // 先写配对日志，再实际冻结，最后写提交日志
  freeze(pairId, entries) {
    if (this.holds.has(pairId)) return; // 不得重复冻结
    this.wal.append({ op: 'pair', id: pairId, freezes: entries });
    this._apply(entries, 1);
    this.holds.set(pairId, entries);
    this.wal.append({ op: 'pair_done', id: pairId });
  }

  // 先写解冻日志，再实际解冻，最后写完成日志
  unfreeze(pairId) {
    this.wal.append({ op: 'unfreeze', id: pairId });
    if (this.holds.has(pairId)) {
      this._apply(this.holds.get(pairId), -1);
      this.holds.delete(pairId);
    }
    this.wal.append({ op: 'unfreeze_done', id: pairId });
  }

  // 崩溃恢复：重放 WAL（幂等，不重复冻结），
  // 解冻意图未完成的自动完成解冻；配对日志未提交的自动回滚配对
  static recover(accounts, walPath) {
    const wal = new Wal(walPath);
    const ledger = new Ledger(accounts, wal);
    const committed = new Set();
    const unfreezeIntents = new Set();
    const unfreezeDone = new Set();
    for (const rec of wal.readAll()) {
      if (rec.op === 'pair') {
        if (!ledger.holds.has(rec.id)) { // 幂等：已冻结则跳过
          ledger._apply(rec.freezes, 1);
          ledger.holds.set(rec.id, rec.freezes);
        }
      } else if (rec.op === 'pair_done') {
        committed.add(rec.id);
      } else if (rec.op === 'unfreeze') {
        unfreezeIntents.add(rec.id);
        if (ledger.holds.has(rec.id)) {
          ledger._apply(ledger.holds.get(rec.id), -1);
          ledger.holds.delete(rec.id);
        }
      } else if (rec.op === 'unfreeze_done') {
        unfreezeDone.add(rec.id);
      }
    }
    // 完成未完成的解冻
    for (const id of unfreezeIntents) {
      if (!unfreezeDone.has(id)) wal.append({ op: 'unfreeze_done', id });
    }
    // 回滚未提交的配对（配对日志已写、提交/解冻日志未写）
    for (const [id, entries] of [...ledger.holds]) {
      if (!committed.has(id)) {
        ledger._apply(entries, -1);
        ledger.holds.delete(id);
        wal.append({ op: 'unfreeze', id, reason: 'rollback' });
        wal.append({ op: 'unfreeze_done', id });
      }
    }
    return ledger;
  }
}

module.exports = { Wal, Ledger };
