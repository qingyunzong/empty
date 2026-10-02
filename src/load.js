'use strict';

const { toCents } = require('./reconcile');

// Build batch records from the three CSV row sets. Each row carries both
// record-level and batch-level fields; a batch's amount is the sum of its rows.
function buildBatches({ channel = [], clearing = [], bank = [] }) {
  const batches = new Map();
  const ingest = (rows, layer) => {
    for (const r of rows) {
      if (!r.batchId) continue;
      let b = batches.get(r.batchId);
      if (!b) {
        b = {
          batchId: r.batchId,
          layer,
          parentId: r.parentId || null,
          customerId: r.customerId || '',
          currency: r.currency || '',
          date: String(r.timestamp || '').slice(0, 10),
          amount: 0,
          status: 'active',
          bankConfirmed: false,
        };
        batches.set(r.batchId, b);
      }
      b.amount += toCents(r.amount);
      if (layer === 'bank' && /confirm/i.test(r.status || '')) b.bankConfirmed = true;
    }
  };
  ingest(channel, 'channel');
  ingest(clearing, 'clearing');
  ingest(bank, 'bank');
  return [...batches.values()];
}

// Merge CSV-derived batches into state (upsert by batchId, keep existing status).
function loadIntoState(state, csvSets) {
  const byId = new Map(state.batches.map((b) => [b.batchId, b]));
  let added = 0;
  let updated = 0;
  for (const b of buildBatches(csvSets)) {
    const existing = byId.get(b.batchId);
    if (existing) {
      const status = existing.status;
      Object.assign(existing, b, { status });
      updated++;
    } else {
      state.batches.push(b);
      byId.set(b.batchId, b);
      added++;
    }
  }
  return { added, updated, total: state.batches.length };
}

module.exports = { buildBatches, loadIntoState };
