// Crash-safe invoice journal.
//
// Invoice lines are appended as a batch framed by {begin}/{commit} records and
// fsynced. The fault point is mid-batch: if the process dies while writing
// invoice lines, the tail of the log holds an uncommitted fragment. On restart
// recover() discards every record after the last commit and compacts the file,
// so a batch is applied either fully or not at all and no account is billed
// twice.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export class InvoiceJournal {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'invoices.log');
    this.batchSeq = 0;
  }

  // Returns { kept, dropped } and compacts the log to committed batches only.
  recover() {
    if (!existsSync(this.file)) return { kept: 0, dropped: 0 };
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((line) => line.length > 0);
    const committed = [];
    let pending = null;
    let dropped = 0;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        dropped += 1; // torn write at the tail
        continue;
      }
      if (record.begin !== undefined) {
        if (pending) dropped += pending.length + 1;
        pending = { id: record.begin, lines: [line] };
      } else if (record.commit !== undefined) {
        if (pending && pending.id === record.commit) {
          pending.lines.push(line);
          committed.push(...pending.lines);
          this.batchSeq += 1;
        } else {
          dropped += 1;
        }
        pending = null;
      } else if (pending) {
        pending.lines.push(line);
      } else {
        dropped += 1; // invoice line outside any batch
      }
    }
    if (pending) dropped += pending.lines.length;
    if (dropped > 0) {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, committed.length > 0 ? `${committed.join('\n')}\n` : '');
      renameSync(tmp, this.file);
    }
    return { kept: committed.length, dropped };
  }

  writeBatch(invoices) {
    const id = `batch-${this.batchSeq + 1}`;
    const records = [
      JSON.stringify({ begin: id }),
      ...invoices.map((invoice) => JSON.stringify({ invoice })),
      JSON.stringify({ commit: id }),
    ];
    appendFileSync(this.file, `${records.join('\n')}\n`);
    const fd = openSync(this.file, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.batchSeq += 1;
    return id;
  }

  invoices() {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((line) => line.length > 0);
    const result = [];
    let pending = null;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        break;
      }
      if (record.begin !== undefined) {
        pending = [];
      } else if (record.commit !== undefined) {
        if (pending) result.push(...pending);
        pending = null;
      } else if (pending && record.invoice !== undefined) {
        pending.push(record.invoice);
      }
    }
    return result;
  }
}
