'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { joinStreams, merkleRoot, windowOf, WINDOW_MS } = require('../lib/join');
const { main } = require('../cli');

const trade = (orderId, symbol, qty, price, ts) => ({ orderId, symbol, qty, price, ts });
const cancel = (orderId, symbol, qty, price, ts) => ({ orderId, symbol, qty, price, ts });

function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function shuffled(rows, seed) {
  const out = rows.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stripProof(rows) {
  return rows.map(({ proof, ...rest }) => rest);
}

test('windowOf buckets by 10s', () => {
  assert.equal(windowOf(0), 0);
  assert.equal(windowOf(9999), 0);
  assert.equal(windowOf(10000), 1);
  assert.equal(WINDOW_MS, 10000);
});

test('A: out-of-order on both sides equals sorted reference', () => {
  const trades = [
    trade('o1', 'AAA', 10, 100, 1000),
    trade('o2', 'AAA', 5, 200, 3000),
    trade('o3', 'BBB', 7, 50, 12000),
    trade('o4', 'BBB', 3, 60, 25000),
  ];
  const cancels = [
    cancel('o1', 'AAA', 4, 0, 2000),
    cancel('o2', 'AAA', 5, 0, 11500),
    cancel('o3', 'BBB', 2, 0, 13000),
  ];
  const reference = joinStreams(toJsonl(trades), toJsonl(cancels));
  for (const seed of [1, 7, 42, 999]) {
    const got = joinStreams(toJsonl(shuffled(trades, seed)), toJsonl(shuffled(cancels, seed + 1)));
    assert.deepEqual(stripProof(got.fills), stripProof(reference.fills));
    assert.deepEqual(stripProof(got.orphanCancels), stripProof(reference.orphanCancels));
    assert.deepEqual(stripProof(got.lateJoins), stripProof(reference.lateJoins));
    assert.deepEqual(got.symbols, reference.symbols);
  }
  // window 0 is closed (both watermarks past it), so o1's cancel is a late-join
  // and does not reduce the settled amounts.
  assert.deepEqual(reference.symbols, {
    AAA: { qty: 10, amountCents: 1000 },
    BBB: { qty: 8, amountCents: 430 },
  });
  assert.equal(reference.lateJoins.length, 1);
  assert.deepEqual(
    [reference.lateJoins[0].orderId, reference.lateJoins[0].qty, reference.lateJoins[0].win],
    ['o1', 4, 0],
  );
});

test('B: partial cancel spans two windows, remainder settles in trade window', () => {
  const trades = [trade('o1', 'AAA', 10, 100, 1000)];
  const cancels = [
    cancel('o1', 'AAA', 3, 0, 2000),
    cancel('o1', 'AAA', 4, 0, 11000),
  ];
  const r = joinStreams(toJsonl(trades), toJsonl(cancels));
  assert.deepEqual(
    r.fills.map((f) => [f.qty, f.win]),
    [
      [3, 0],
      [3, 0],
      [4, 1],
    ],
  );
  assert.deepEqual(r.symbols, { AAA: { qty: 3, amountCents: 300 } });
  assert.equal(r.orphanCancels.length, 0);
});

test('cancel can reach a trade in a later window', () => {
  const trades = [trade('o1', 'AAA', 10, 100, 11000)];
  const cancels = [cancel('o1', 'AAA', 4, 0, 5000)];
  const r = joinStreams(toJsonl(trades), toJsonl(cancels));
  assert.deepEqual(
    r.fills.map((f) => [f.qty, f.win]),
    [
      [4, 1],
      [6, 1],
    ],
  );
  assert.deepEqual(r.symbols, { AAA: { qty: 6, amountCents: 600 } });
});

test('cancel earlier than trade in same logical window still matches', () => {
  const trades = [trade('o1', 'AAA', 10, 100, 8000)];
  const cancels = [cancel('o1', 'AAA', 4, 0, 1000)];
  const r = joinStreams(toJsonl(trades), toJsonl(cancels));
  const matched = r.fills.filter((f) => f.qty === 4);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].win, 0);
  assert.equal(r.lateJoins.length, 0);
});

test('C: orphan cancels listed separately, never negative fills', () => {
  const trades = [trade('o1', 'AAA', 5, 100, 1000)];
  const cancels = [
    cancel('ghost', 'AAA', 3, 0, 1500),
    cancel('o1', 'AAA', 9, 0, 2000),
  ];
  const r = joinStreams(toJsonl(trades), toJsonl(cancels));
  assert.equal(r.orphanCancels.length, 2);
  assert.deepEqual(
    r.orphanCancels.map((o) => [o.orderId, o.qty]),
    [
      ['ghost', 3],
      ['o1', 4],
    ],
  );
  assert.ok(r.fills.every((f) => f.qty > 0));
  assert.deepEqual(r.symbols, {});
});

test('D: enumerate all cancel subsets for <=8 orders against reference model', () => {
  const trades = [
    trade('o1', 'AAA', 6, 100, 1000),
    trade('o2', 'AAA', 4, 200, 2000),
    trade('o3', 'BBB', 5, 50, 3000),
    trade('o4', 'BBB', 8, 60, 4000),
    trade('o5', 'AAA', 2, 100, 5000),
    trade('o6', 'BBB', 3, 70, 6000),
    trade('o7', 'AAA', 9, 300, 7000),
    trade('o8', 'BBB', 1, 80, 8000),
  ];
  const cancelPool = [
    cancel('o1', 'AAA', 2, 0, 1500),
    cancel('o2', 'AAA', 4, 0, 4000),
    cancel('o3', 'BBB', 1, 0, 5000),
    cancel('o4', 'BBB', 3, 0, 5500),
    cancel('o5', 'AAA', 2, 0, 6500),
    cancel('o6', 'BBB', 5, 0, 7500),
    cancel('o7', 'AAA', 1, 0, 8500),
    cancel('o8', 'BBB', 1, 0, 9000),
  ];

  const referenceModel = (cancelIdxs) => {
    const perKey = new Map();
    for (const t of trades) perKey.set(t.orderId, { remaining: t.qty, price: t.price, symbol: t.symbol });
    for (const i of cancelIdxs) {
      const c = cancelPool[i];
      const st = perKey.get(c.orderId);
      st.remaining = Math.max(0, st.remaining - c.qty);
    }
    let qty = 0;
    let amount = 0;
    for (const st of perKey.values()) {
      qty += st.remaining;
      amount += st.remaining * st.price;
    }
    return { qty, amount };
  };

  for (let mask = 0; mask < (1 << cancelPool.length); mask += 1) {
    const idxs = [];
    for (let i = 0; i < cancelPool.length; i += 1) {
      if (mask & (1 << i)) idxs.push(i);
    }
    const chosen = idxs.map((i) => cancelPool[i]);
    const r = joinStreams(toJsonl(shuffled(trades, mask + 1)), toJsonl(shuffled(chosen, mask + 2)));
    const expected = referenceModel(idxs);
    const gotQty = Object.values(r.symbols).reduce((s, v) => s + v.qty, 0);
    const gotAmount = Object.values(r.symbols).reduce((s, v) => s + v.amountCents, 0);
    assert.equal(gotQty, expected.qty, `mask=${mask} qty`);
    assert.equal(gotAmount, expected.amount, `mask=${mask} amount`);
    assert.ok(r.fills.every((f) => f.qty > 0), `mask=${mask} positive fills`);
  }
});

test('duplicate cancel line takes effect only once', () => {
  const line = JSON.stringify(cancel('o1', 'AAA', 4, 0, 2000));
  const trades = toJsonl([trade('o1', 'AAA', 10, 100, 1000)]);
  const r = joinStreams(trades, `${line}\n${line}\n`);
  const matched = r.fills.filter((f) => f.qty === 4);
  assert.equal(matched.length, 1);
  assert.deepEqual(r.symbols, { AAA: { qty: 6, amountCents: 600 } });
});

test('late-join: cancel arriving after its window closed does not rewrite it', () => {
  const trades = [trade('o1', 'AAA', 10, 100, 1000), trade('o3', 'AAA', 1, 100, 25000)];
  const cancels = [
    cancel('o2', 'AAA', 1, 0, 21000),
    cancel('o1', 'AAA', 4, 0, 500),
  ];
  const r = joinStreams(toJsonl(trades), toJsonl(cancels));
  assert.deepEqual(
    r.fills.map((f) => [f.qty, f.win]),
    [
      [10, 0],
      [1, 2],
    ],
  );
  assert.equal(r.lateJoins.length, 1);
  assert.deepEqual([r.lateJoins[0].qty, r.lateJoins[0].win, r.lateJoins[0].cancelWin], [4, 0, 0]);
  assert.deepEqual(r.symbols, { AAA: { qty: 11, amountCents: 1100 } });
});

test('proof is merkle root of both sides input line numbers', () => {
  const trades = toJsonl([trade('o1', 'AAA', 10, 100, 1000), trade('o2', 'AAA', 1, 100, 2000)]);
  const cancels = toJsonl([cancel('o1', 'AAA', 4, 0, 2000)]);
  const r = joinStreams(trades, cancels);
  const matched = r.fills.find((f) => f.qty === 4);
  assert.equal(matched.proof, merkleRoot(['trades:1', 'cancels:1']));
  const unmatched = r.fills.find((f) => f.orderId === 'o2');
  assert.equal(unmatched.proof, merkleRoot(['trades:2']));
  assert.match(matched.proof, /^[0-9a-f]{64}$/);
});

test('row errors: qty<=0 and non-integer-cent price rejected, run continues', () => {
  const trades = [
    trade('o1', 'AAA', 10, 100, 1000),
    trade('bad1', 'AAA', 0, 100, 1000),
    trade('bad2', 'AAA', 5, 10.5, 1000),
    trade('bad3', 'AAA', -2, 100, 1000),
  ];
  const r = joinStreams(toJsonl(trades), '');
  assert.equal(r.errors.length, 3);
  assert.deepEqual(
    r.errors.map((e) => e.reason),
    ['qty-not-positive', 'price-not-integer-cents', 'qty-not-positive'],
  );
  assert.deepEqual(r.symbols, { AAA: { qty: 10, amountCents: 1000 } });
});

test('missing fields reported as row errors', () => {
  const r = joinStreams('{"symbol":"AAA","qty":1,"price":1,"ts":1}\n', '{"orderId":"x"}\n');
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].reason, 'missing-field:orderId');
  assert.equal(r.errors[1].reason, 'missing-field:symbol');
});

function writeTmp(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

function runCli(argv) {
  const stderr = [];
  const origError = console.error;
  console.error = (msg) => stderr.push(String(msg));
  try {
    return { status: main(argv), stderr: stderr.join('\n') };
  } finally {
    console.error = origError;
  }
}

test('CLI join writes fills.jsonl and exits 0 on clean input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
  const t = writeTmp(dir, 't.jsonl', toJsonl([trade('o1', 'AAA', 10, 100, 1000)]));
  const c = writeTmp(dir, 'c.jsonl', toJsonl([cancel('o1', 'AAA', 4, 0, 2000)]));
  const out = path.join(dir, 'o.jsonl');
  const res = runCli(['join', '--trades', t, '--cancels', c, '--out', out]);
  assert.equal(res.status, 0, res.stderr);
  const fills = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    fills.map((f) => [f.orderId, f.qty, f.win]),
    [
      ['o1', 4, 0],
      ['o1', 6, 0],
    ],
  );
  assert.ok(fills.every((f) => typeof f.proof === 'string' && f.proof.length === 64));
});

test('CLI exits 2 on row errors but still writes output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
  const t = writeTmp(dir, 't.jsonl', '{"orderId":"o1","symbol":"AAA","qty":0,"price":100,"ts":1000}\n');
  const c = writeTmp(dir, 'c.jsonl', '{"orderId":"o2"}\n');
  const out = path.join(dir, 'o.jsonl');
  const res = runCli(['join', '--trades', t, '--cancels', c, '--out', out]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /row-error/);
  assert.equal(fs.readFileSync(out, 'utf8'), '');
});

test('CLI business orphans do not fail the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
  const t = writeTmp(dir, 't.jsonl', toJsonl([trade('o1', 'AAA', 1, 100, 1000)]));
  const c = writeTmp(dir, 'c.jsonl', toJsonl([cancel('ghost', 'AAA', 5, 0, 2000)]));
  const out = path.join(dir, 'o.jsonl');
  const orphans = path.join(dir, 'orphans.jsonl');
  const res = runCli(['join', '--trades', t, '--cancels', c, '--out', out, '--orphans', orphans]);
  assert.equal(res.status, 0, res.stderr);
  const rows = fs.readFileSync(orphans, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, 'ghost');
});

test('CLI usage error exits 64', () => {
  const res = runCli([]);
  assert.equal(res.status, 64);
});
