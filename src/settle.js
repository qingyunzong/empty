import { readJsonl, validateAccount } from './io.js';
import { NettingEngine } from './engine.js';
import { buildCertificate } from './cert.js';

export function settle(inputDir) {
  const accounts = readJsonl(`${inputDir}/accounts.jsonl`);
  const trades = readJsonl(`${inputDir}/trades.jsonl`);
  const events = readJsonl(`${inputDir}/events.jsonl`);

  for (let i = 0; i < accounts.rows.length; i++) {
    validateAccount(accounts.rows[i], `accounts.jsonl:${i + 1}`);
  }

  const engine = new NettingEngine();
  engine.loadTrades(trades.rows);   // base load
  engine.applyEvents(events.rows);  // incremental updates only

  const rows = engine.rows();
  const cert = buildCertificate(rows, {
    accounts: accounts.digest,
    trades: trades.digest,
    events: events.digest,
  });
  return { out: { rows }, cert };
}
