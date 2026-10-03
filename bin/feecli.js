#!/usr/bin/env node
// feecli: read JSONL fee events, update end-of-day fees incrementally, and
// print per-account fee diffs, hit tiers and a deterministic certificate.
//
// Usage:
//   node bin/feecli.js [events.jsonl] [--state DIR] [--persist DIR] [--explain]
//
// Events (one JSON object per line):
//   {"type":"package","id":"std","version":1,"tiers":[{"upTo":100000,"rate":0.001},{"upTo":null,"rate":0.0008}],"minFee":5,"rebates":[{"minTurnover":500000,"percent":10}]}
//   {"type":"deactivate","packageId":"std"}
//   {"type":"trade","id":"t1","account":"A","amount":120000}
//   {"type":"amend","id":"t1","amount":150000}        // cancel old + add new
//   {"type":"cancel","id":"t1"}
//   {"type":"reversal","id":"r1","ref":"t1","amount":-120000}
//
// Output: one {"type":"fee-diff",...} line per affected account, then a
// {"type":"certificate",...} line. Any input/validation error goes to stderr
// and exits with code 6.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FeeEngine } from '../src/engine.js';
import { formatCents } from '../src/fees.js';
import { InvoiceJournal } from '../src/journal.js';

const USAGE = `usage: node bin/feecli.js [events.jsonl] [--state DIR] [--persist DIR] [--explain]
       (reads stdin when no file is given; errors exit with code 6)`;

function parseArgs(argv) {
  const args = { file: null, state: null, persist: null, explain: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') args.state = argv[++i];
    else if (arg === '--persist') args.persist = argv[++i];
    else if (arg === '--explain') args.explain = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (args.file === null) {
      args.file = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.state === '') throw new Error('--state needs a directory');
  if (args.persist === '') throw new Error('--persist needs a directory');
  return args;
}

async function readInput(file) {
  if (file) return readFileSync(file, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function loadState(dir) {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveState(dir, snapshot) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
  renameSync(tmp, file); // atomic: never a half-written state
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let engine;
  if (args.state) {
    const snapshot = loadState(args.state);
    engine = snapshot ? FeeEngine.restore(snapshot) : new FeeEngine();
  } else {
    engine = new FeeEngine();
  }

  let journal = null;
  if (args.persist) {
    journal = new InvoiceJournal(args.persist);
    const { dropped } = journal.recover();
    if (dropped > 0) {
      console.error(`recovered: discarded ${dropped} uncommitted invoice record(s)`);
    }
  }

  const before = engine.accountFees();
  const reasons = new Map(); // account -> [reason]
  const note = (change) => {
    if (!reasons.has(change.account)) reasons.set(change.account, []);
    reasons.get(change.account).push(change.reason);
  };

  const input = await readInput(args.file);
  const lines = input.split('\n');
  let events = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${i + 1}: invalid JSON (${err.message})`);
    }
    try {
      engine.applyEvent(event).forEach(note);
    } catch (err) {
      throw new Error(`line ${i + 1}: ${err.message}`);
    }
    events += 1;
  }

  const after = engine.accountFees();
  const certificate = engine.certificate();

  const names = [...new Set([...Object.keys(before), ...Object.keys(after), ...reasons.keys()])]
    .filter((name) => (before[name] ?? 0) !== (after[name] ?? 0)
      || reasons.has(name)
      || (after[name] ?? 0) !== 0)
    .sort();

  const invoices = [];
  for (const name of names) {
    const view = engine.accountView(name);
    const previousFeeCents = before[name] ?? 0;
    const feeCents = after[name] ?? 0;
    const out = {
      type: 'fee-diff',
      account: name,
      previousFee: formatCents(previousFeeCents),
      fee: formatCents(feeCents),
      delta: formatCents(feeCents - previousFeeCents),
      turnover: formatCents(view ? view.turnoverCents : 0),
      hitTier: view ? view.hitTier : null,
      package: view ? view.package : null,
      tied: view ? view.tied : [],
    };
    if (args.explain) out.changes = reasons.get(name) ?? [];
    console.log(JSON.stringify(out));
    if (feeCents !== previousFeeCents) {
      invoices.push({
        account: name,
        previousFee: out.previousFee,
        fee: out.fee,
        delta: out.delta,
        hitTier: out.hitTier,
        package: out.package,
        certificate: certificate.digest,
      });
    }
  }

  let batch = null;
  if (journal && invoices.length > 0) {
    batch = journal.writeBatch(invoices);
  }

  if (args.state) saveState(args.state, engine.snapshot());

  console.log(JSON.stringify({
    type: 'certificate',
    algorithm: certificate.algorithm,
    digest: certificate.digest,
    events,
    accounts: certificate.accounts,
    trades: certificate.trades,
    ...(batch ? { invoiceBatch: batch } : {}),
  }));
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(6);
});
