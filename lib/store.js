'use strict';

const fs = require('fs');
const path = require('path');

// Two-file transactional store (balance + freeze) with a write-ahead journal.
// A transaction writes the journal (with pre-images), then balance, then
// freeze, then removes the journal. If a crash happens between the balance and
// freeze commits, recover() restores both sides from the journal pre-images,
// so the pair is always consistent: either fully applied or fully rolled back.
class TxStore {
  constructor(dir, hooks = {}) {
    this.dir = dir;
    this.hooks = hooks;
    fs.mkdirSync(dir, { recursive: true });
    this.balanceFile = path.join(dir, 'balance.json');
    this.freezeFile = path.join(dir, 'freeze.json');
    this.journalFile = path.join(dir, 'journal.json');
  }

  static readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  static writeJsonAtomic(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  recover() {
    if (!fs.existsSync(this.journalFile)) return false;
    const journal = JSON.parse(fs.readFileSync(this.journalFile, 'utf8'));
    TxStore.writeJsonAtomic(this.balanceFile, journal.preBalance);
    TxStore.writeJsonAtomic(this.freezeFile, journal.preFreeze);
    fs.unlinkSync(this.journalFile);
    return true;
  }

  snapshot() {
    return {
      balance: TxStore.readJson(this.balanceFile, {}),
      freeze: TxStore.readJson(this.freezeFile, {}),
    };
  }

  // mutate(balance, freeze) edits both maps; committed as one transaction.
  tx(mutate) {
    const preBalance = TxStore.readJson(this.balanceFile, {});
    const preFreeze = TxStore.readJson(this.freezeFile, {});
    TxStore.writeJsonAtomic(this.journalFile, { preBalance, preFreeze });
    const balance = structuredClone(preBalance);
    const freeze = structuredClone(preFreeze);
    mutate(balance, freeze);
    if (this.hooks.beforeBalanceWrite) this.hooks.beforeBalanceWrite();
    TxStore.writeJsonAtomic(this.balanceFile, balance);
    if (this.hooks.afterBalanceWrite) this.hooks.afterBalanceWrite(); // crash point A
    TxStore.writeJsonAtomic(this.freezeFile, freeze);
    if (this.hooks.afterFreezeWrite) this.hooks.afterFreezeWrite(); // crash point B
    fs.unlinkSync(this.journalFile);
    return { balance, freeze };
  }
}

module.exports = { TxStore };
