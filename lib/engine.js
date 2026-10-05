'use strict';

const { Wal, Ledger } = require('./ledger');
const { compatible, buildDomains, solveMatching, explainConflict } = require('./match');
const { validateInstruction } = require('./validate');

class SettlementEngine {
  constructor({ accounts, instructions = [], permissions = {}, walPath = null, ledger = null }) {
    this.accountDefs = accounts;
    this.ledger = ledger ?? new Ledger(accounts, new Wal(walPath));
    this.instructions = [];
    this.permissions = new Map();
    this.pairs = [];
    this.pairCounter = 0;
    this.addPermissions(permissions);
    this.addInstructions(instructions);
  }

  addPermissions(perms) {
    const entries = Array.isArray(perms)
      ? perms.map((p) => [p.instruction, p.accounts])
      : Object.entries(perms ?? {});
    for (const [instId, accounts] of entries) this.permissions.set(instId, accounts);
  }

  addInstructions(list, permissions = {}) {
    for (const inst of list) validateInstruction(inst);
    this.instructions.push(...list);
    this.addPermissions(permissions);
  }

  _pairedIds() {
    return new Set(this.pairs.flatMap((p) => [p.buy, p.sell]));
  }

  // 传播删去不可能账户 + 回溯枚举配对；余额不足时给出最短指令环
  _match() {
    const availability = this.ledger.snapshot();
    const unpaired = this.instructions.filter((i) => !this._pairedIds().has(i.id));
    const domains = buildDomains(unpaired, availability, this.permissions);
    if (unpaired.some((i) => domains.get(i.id).length === 0)) {
      return { status: 'UNSAT', pairs: [], conflict: explainConflict(unpaired, domains, { pairs: [] }) };
    }
    const pairs = solveMatching(unpaired, domains, availability);
    const matchedIds = new Set(pairs.flatMap((p) => [p.buy, p.sell]));
    const unmatched = unpaired.filter((i) => !matchedIds.has(i.id));
    const blocked = unmatched.some((i) => unmatched.some((o) => o.id !== i.id && compatible(i, o)));
    if (blocked) {
      return { status: 'UNSAT', pairs, conflict: explainConflict(unpaired, domains, { pairs }) };
    }
    return { status: 'OK', pairs };
  }

  _applyMatch(m) {
    for (const p of m.pairs) {
      const id = `P${++this.pairCounter}`;
      this.ledger.freeze(id, [
        { account: p.buyAccount, cash: p.price * p.quantity },
        { account: p.sellAccount, security: p.security, quantity: p.quantity },
      ]);
      this.pairs.push({ id, ...p });
    }
    return this._report(m);
  }

  settle() {
    return this._applyMatch(this._match());
  }

  // 增量重配：保留既有配对，仅对未配对指令重新撮合
  rematch() {
    return this._applyMatch(this._match());
  }

  // 撤单：先解冻，再拆配对，最后移除指令
  cancel(ids) {
    for (const id of ids) {
      const pair = this.pairs.find((p) => p.buy === id || p.sell === id);
      if (pair) {
        this.ledger.unfreeze(pair.id);
        this.pairs = this.pairs.filter((p) => p !== pair);
      }
      this.instructions = this.instructions.filter((i) => i.id !== id);
    }
  }

  _report(m) {
    const frozen = {};
    const remaining = {};
    for (const acc of this.accountDefs) {
      const av = this.ledger.get(acc.id);
      remaining[acc.id] = { cash: av.cash, securities: { ...av.securities } };
      frozen[acc.id] = this.ledger.frozenOf(acc.id);
    }
    const pairedIds = this._pairedIds();
    const out = {
      status: m.status,
      pairs: this.pairs.map((p) => ({ ...p })),
      unmatched: this.instructions.filter((i) => !pairedIds.has(i.id)).map((i) => i.id),
      frozen,
      remaining,
    };
    if (m.conflict) out.conflict = m.conflict;
    return out;
  }
}

module.exports = { SettlementEngine };
