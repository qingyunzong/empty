#!/usr/bin/env node
import fs from 'node:fs';
import { Store, StoreError } from './src/store.js';
import { cancelSlip } from './src/settlement.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--at') args.at = Number.parseInt(argv[++i], 10);
    else args._.push(a);
  }
  return args;
}

function fail(code) {
  process.stdout.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test hooks to make concurrent CLI scenarios deterministic:
//  SETTLE_TX_BEGAN_FILE  - written with the snapshot version right after begin
//  SETTLE_TX_GATE_FILE   - transaction work pauses until this file exists
//  SETTLE_TX_DELAY_MS    - fixed sleep between begin and the transaction body
async function awaitTestHooks(tx) {
  const beganFile = process.env.SETTLE_TX_BEGAN_FILE;
  if (beganFile) fs.writeFileSync(beganFile, String(tx.snapshot));
  const delay = Number(process.env.SETTLE_TX_DELAY_MS ?? 0);
  if (delay > 0) await sleep(delay);
  const gateFile = process.env.SETTLE_TX_GATE_FILE;
  if (gateFile) {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(gateFile)) {
      if (Date.now() > deadline) throw new StoreError('E_TIMEOUT', 'gate file never appeared');
      await sleep(25);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) fail('E_USAGE');
  const store = Store.open(args.dir);
  const cmd = args._[0];

  if (cmd === 'tx') {
    let spec;
    try {
      spec = JSON.parse(args._[1] ?? '{}');
    } catch {
      fail('E_USAGE');
    }
    const tx = store.begin();
    await awaitTestHooks(tx);
    try {
      for (const key of spec.gets ?? []) tx.get(key);
      for (const [k, v] of Object.entries(spec.puts ?? {})) tx.put(k, v);
      const cancels =
        spec.cancel === undefined ? [] : Array.isArray(spec.cancel) ? spec.cancel : [spec.cancel];
      for (const id of cancels) cancelSlip(tx, id);
      const version = tx.commit();
      process.stdout.write(`${JSON.stringify({ version })}\n`);
    } catch (e) {
      if (e instanceof StoreError) fail(e.code);
      throw e;
    }
    return;
  }

  if (cmd === 'get') {
    const key = args._[1];
    const at = Number.isInteger(args.at) ? args.at : store.head();
    if (key === undefined) {
      process.stdout.write(`${JSON.stringify(store.stateAt(at))}\n`);
      return;
    }
    const value = store.readAt(key, at);
    if (value === undefined) fail('E_NOT_FOUND');
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }

  fail('E_USAGE');
}

main().catch((e) => fail(e.code ?? 'E_INTERNAL'));
