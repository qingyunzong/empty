'use strict';

const { readHistory, appendLine } = require('./history');
const { judge } = require('./judge');

class SimulatedCrash extends Error {
  constructor(added) {
    super('simulated crash before all compensations were written');
    this.name = 'SimulatedCrash';
    this.added = added;
  }
}

/**
 * Repair a history by appending compensating ops for every erroneously
 * committed op (verdict code != 0). History is never rewritten.
 *
 * Exactly-once: each compensation has a deterministic opId
 * (`cmp:<opId>`, or `cmp:dup:<opId>` for code-12 duplicates). Already
 * present compensations are skipped, so a crash mid-repair followed by a
 * re-run writes each compensation exactly once.
 *
 * opts.crashAfterWrites: inject a SimulatedCrash after N successful writes
 * (used to test crash recovery).
 */
function repair(historyFile, config = {}, opts = {}) {
  const ops = readHistory(historyFile);
  const result = judge(ops, config, { maxTies: 0 });

  const erroneous = [];
  for (const [account, res] of Object.entries(result.accounts)) {
    for (const v of res.verdicts) {
      if (v.code !== 0 && v.type !== 'compensate') {
        erroneous.push({ account, ...v });
      }
    }
  }

  const existing = new Set(ops.map((o) => o.opId));
  const now = opts.now == null ? Date.now() : opts.now;
  const day = opts.day || new Date(now).toISOString().slice(0, 10);
  const crashAfter = opts.crashAfterWrites == null ? Infinity : opts.crashAfterWrites;

  const added = [];
  const skipped = [];
  let writes = 0;
  for (const e of erroneous) {
    const cmpId = (e.code === 12 ? 'cmp:dup:' : 'cmp:') + e.opId;
    if (existing.has(cmpId)) {
      skipped.push(cmpId);
      continue;
    }
    const cmp = {
      opId: cmpId,
      account: e.account,
      type: 'compensate',
      compensates: e.opId,
      code: e.code,
      reason: e.reason,
      day,
      ts: now + writes,
      causes: [e.opId],
    };
    appendLine(historyFile, cmp);
    writes += 1;
    existing.add(cmpId);
    added.push(cmp);
    if (writes >= crashAfter) throw new SimulatedCrash(added);
  }

  return {
    added,
    skipped,
    erroneous: erroneous.map((e) => ({ opId: e.opId, account: e.account, code: e.code, reason: e.reason })),
  };
}

module.exports = { repair, SimulatedCrash };
