'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Append-only write-ahead log. Freeze groups go through PREPARE -> COMMIT;
// after a crash only COMMITed records are replayed, so prepared-but-
// uncommitted freezes never take effect.
class Wal {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, 'a');
  }

  get isOpen() {
    return this.fd !== null;
  }

  append(record) {
    if (this.fd === null) throw new Error('wal is not open');
    const line = JSON.stringify(record) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // Fold the log into recovery state:
  //  - accounts: latest committed balances
  //  - committedFreezes: freeze groups whose txn reached COMMIT
  //  - preparedTxns: txns with PREPARE but no COMMIT/ABORT (never applied)
  static recover(filePath) {
    const accounts = new Map();
    const committedFreezes = [];
    const preparedTxns = new Map();
    if (!fs.existsSync(filePath)) {
      return { accounts, committedFreezes, preparedTxns };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // tolerate a torn tail write
      }
      switch (record.type) {
        case 'INIT':
          accounts.set(record.account, {
            account: record.account,
            balance: record.balance,
            priority: record.priority,
          });
          break;
        case 'PREPARE':
          preparedTxns.set(record.txnId, record);
          break;
        case 'COMMIT': {
          const prepared = preparedTxns.get(record.txnId);
          if (prepared) {
            committedFreezes.push(prepared);
            preparedTxns.delete(record.txnId);
          }
          break;
        }
        case 'ABORT':
          preparedTxns.delete(record.txnId);
          break;
        default:
          break;
      }
    }
    return { accounts, committedFreezes, preparedTxns };
  }
}

module.exports = { Wal };
