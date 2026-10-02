'use strict';

const { buildRules, computeFee, FeeError } = require('./core');
const { readLines, readPosition, writePosition, loadLedger, appendLedger } = require('./store');

function loadRules(rulesPath) {
  const events = readLines(rulesPath).map((line) => JSON.parse(line));
  return buildRules(events);
}

function loadTxs(txPath) {
  return readLines(txPath).map((line) => JSON.parse(line));
}

// Incremental sync: process only tx lines appended after the committed
// position. Ledger entries are deduped by txId, so reprocessing after a
// crash (position not yet written) never duplicates a backfilled tx.
// Backfilled txs landing in already-settled intervals simply append new
// ledger entries -> incremental correction, no full recompute.
function sync({ rulesPath, txPath, stateDir, crashBeforeCheckpoint = false }) {
  const rules = loadRules(rulesPath);
  const position = readPosition(stateDir);
  const ledger = loadLedger(stateDir);
  const lines = readLines(txPath);
  if (position.txOffset > lines.length) {
    throw new FeeError(2, `tx file shrank: position ${position.txOffset} > ${lines.length} lines`);
  }
  const newEntries = [];
  let skipped = 0;
  for (const line of lines.slice(position.txOffset)) {
    const tx = JSON.parse(line);
    if (ledger.has(tx.txId)) {
      skipped++;
      continue;
    }
    const entry = computeFee(rules, tx);
    ledger.set(tx.txId, entry);
    newEntries.push(entry);
  }
  appendLedger(stateDir, newEntries);
  if (!crashBeforeCheckpoint) {
    writePosition(stateDir, { txOffset: lines.length });
  }
  return {
    processed: newEntries.length,
    skipped,
    txOffset: lines.length,
    checkpointWritten: !crashBeforeCheckpoint,
    ledgerSize: ledger.size,
  };
}

module.exports = { sync, loadRules, loadTxs };
