import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compilePlan,
  loadLedger,
  serializeLedger,
  VM,
  Wal,
} from '../src/index.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeTxn(txnId, accountA, accountB, amount, status, day) {
  return [
    { id: `${txnId}:d`, txnId, account: accountA, dc: 'debit', amount, status, day },
    { id: `${txnId}:c`, txnId, account: accountB, dc: 'credit', amount, status, day },
  ];
}

export function makeLedgerJson(entries, currentDay = 2) {
  return { currentDay, entries, revocations: [] };
}

export function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-test-'));
}

export function writeJson(file, obj) {
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function runPlanOnFiles(planPath, ledgerPath, walPath, opts = {}) {
  const source = fs.readFileSync(planPath, 'utf8');
  const ledger = loadLedger(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')));
  const program = compilePlan(source);
  const wal = Wal.create(walPath, {
    type: 'header',
    revId: program.revId,
    plan: path.resolve(planPath),
    ledger: path.resolve(ledgerPath),
    out: path.resolve(ledgerPath.replace(/\.json$/i, '') + '.out.json'),
  });
  try {
    const vm = new VM(program, ledger, wal, opts);
    const counts = vm.run();
    wal.append({ type: 'done', counts });
    return { counts, ledger, program };
  } finally {
    wal.close();
  }
}

export function runPlanInMemory(source, ledgerJson, opts = {}) {
  const dir = makeWorkspace();
  const planPath = path.join(dir, 'plan.rvx');
  const ledgerPath = path.join(dir, 'ledger.json');
  const walPath = path.join(dir, 'wal.log');
  fs.writeFileSync(planPath, source);
  writeJson(ledgerPath, ledgerJson);
  const result = runPlanOnFiles(planPath, ledgerPath, walPath, opts);
  return { ...result, dir, planPath, ledgerPath, walPath };
}

// Independent brute-force oracle: computes posted balances directly from the
// state machine, without touching the VM, bytecode or entry-mutation logic.
// A targeted SETTLED / cross-day-LOCKED txn contributes zero afterwards
// (reversed or compensated), a targeted PENDING txn never posted anyway.
export function oracleBalances(ledgerJson, targetIds) {
  const targets = new Set(targetIds);
  const bal = new Map();
  for (const e of ledgerJson.entries) {
    if (e.status === 'PENDING' || e.status === 'CANCEL_REQUESTED') continue;
    if (targets.has(e.txnId) && (e.status === 'SETTLED' || e.status === 'LOCKED')) continue;
    const cents = centsOf(e.amount);
    const signed = e.dc === 'debit' ? cents : -cents;
    bal.set(e.account, (bal.get(e.account) ?? 0) + signed);
  }
  const out = {};
  for (const k of [...bal.keys()].sort()) out[k] = bal.get(k);
  return out;
}

function centsOf(amount) {
  const [whole, frac = ''] = String(amount).split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2)) * (String(amount).startsWith('-') ? -1 : 1);
}

export function genLedger(seed, txnCount) {
  const rng = mulberry32(seed);
  const entries = [];
  const ids = [];
  for (let i = 0; i < txnCount; i += 1) {
    const txnId = `txn:${1000 + i}`;
    ids.push(txnId);
    let a = Math.floor(rng() * 6);
    let b = Math.floor(rng() * 6);
    if (b === a) b = (b + 1) % 6;
    const amount = `${Math.floor(rng() * 100000) + 1}.${String(Math.floor(rng() * 100)).padStart(2, '0')}`;
    const r = rng();
    let status;
    let day;
    if (r < 0.6) { status = 'SETTLED'; day = Math.floor(rng() * 2); }
    else if (r < 0.8) { status = 'PENDING'; day = 2; }
    else { status = 'LOCKED'; day = 0; }
    entries.push(...makeTxn(txnId, `acct:a${a}`, `acct:a${b}`, amount, status, day));
  }
  return { ledgerJson: makeLedgerJson(entries, 2), ids };
}

export function serialize(ledger) {
  return JSON.stringify(serializeLedger(ledger));
}
