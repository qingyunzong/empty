import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

// Naive reference: replay the WAL keeping only complete commit blocks.
function referenceReplay(walPath) {
  const text = fs.readFileSync(walPath, 'utf8');
  const lines = text.split('\n');
  const batches = new Map(); // uid -> {pallet, lot, quarantine}
  let txid = 0;
  let pending = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const e = JSON.parse(lines[i].slice(lines[i].indexOf(' ') + 1));
    if (e.t === 'begin') {
      pending = [];
    } else if (e.t === 'put' || e.t === 'xfer') {
      pending.push(e);
    } else if (e.t === 'commit') {
      for (const r of pending) {
        if (r.t === 'put') batches.set(r.uid, { pallet: r.pallet, lot: r.lot, quarantine: !!r.quarantine });
        else batches.set(r.uid, { pallet: r.to, lot: r.lot, quarantine: !!r.quarantine });
      }
      txid = e.tx;
      pending = null;
    }
  }
  const pallets = {};
  const index = [];
  for (const [uid, b] of batches) {
    (pallets[b.pallet] ??= []).push({ lot: b.lot, quarantine: b.quarantine, uid });
    index.push({ pallet: b.pallet, lot: b.lot, uid });
  }
  for (const list of Object.values(pallets)) list.sort((a, b) => (a.lot < b.lot ? -1 : 1));
  index.sort((a, b) => (a.pallet + a.lot < b.pallet + b.lot ? -1 : 1));
  return { txid, pallets, index };
}

function* opSpace(lots) {
  for (const lot of lots) {
    for (const [from, to] of [['P1', 'P2'], ['P2', 'P1']]) {
      for (const quarantine of [false, true]) {
        yield { lot, from, to, quarantine };
      }
    }
  }
}

function* prefixes(ops, depth) {
  yield [];
  if (depth === 0) return;
  for (const op of ops) {
    for (const rest of prefixes(ops, depth - 1)) {
      yield [op, ...rest];
    }
  }
}

function runHistory(seedLots, ops, finalOp, crashPoint) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'px-enum-'));
  try {
    let store = Store.init(dir);
    for (const lot of seedLots) store.put('P1', lot);
    for (const op of ops) {
      try {
        store.transfer(op.from, op.to, [op.lot], { quarantine: op.quarantine });
      } catch (e) {
        assert.notEqual(e.code, 'E_CRASH', 'unexpected crash during prefix');
      }
    }
    let crashed = false;
    try {
      store.transfer(finalOp.from, finalOp.to, [finalOp.lot], {
        quarantine: finalOp.quarantine,
        crashPoint,
      });
    } catch (e) {
      if (e.code === 'E_CRASH') crashed = true;
      // business errors (E_NOT_FOUND / E_DUP) write nothing to the WAL
    }
    const expected = referenceReplay(path.join(dir, 'wal.log'));
    store = Store.open(dir); // recovery: rollback tentative block or apply committed one
    const actual = store.dump();
    assert.deepStrictEqual(
      actual,
      expected,
      `mismatch for ${JSON.stringify({ seedLots, ops, finalOp, crashPoint, crashed })}`,
    );
    return crashed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function enumerate(seedLots, prefixDepth) {
  const ops = [...opSpace(seedLots)];
  let histories = 0;
  let crashes = 0;
  for (const prefix of prefixes(ops, prefixDepth)) {
    for (const finalOp of ops) {
      for (const crashPoint of ['after_records', 'after_commit']) {
        histories += 1;
        if (runHistory(seedLots, prefix, finalOp, crashPoint)) crashes += 1;
      }
    }
  }
  return { histories, crashes };
}

test('acceptance 3: exhaustive transfer/crash histories, 2 lots x 2 pallets, prefix depth 2', () => {
  const { histories, crashes } = enumerate(['L1', 'L2'], 2);
  assert.equal(histories, (1 + 8 + 64) * 8 * 2);
  assert.ok(crashes > 0);
});

test('acceptance 3: exhaustive transfer/crash histories, 3 lots x 2 pallets, prefix depth 1', () => {
  const { histories, crashes } = enumerate(['L1', 'L2', 'L3'], 1);
  assert.equal(histories, (1 + 12) * 12 * 2);
  assert.ok(crashes > 0);
});
