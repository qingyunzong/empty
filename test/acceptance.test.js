'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { Reassembler } = require('../lib/link');
const { decodeFrame, encodeFrame } = require('../lib/frame');
const { fragmentFrame } = require('../lib/link');
const { Engine } = require('../lib/engine');
const { computeNetting } = require('../lib/netting');
const { A, B, C, D, obl, ack, nak, cancel, tick, streamOf } = require('./helpers');

function runStream(stream, opts) {
  const link = new Reassembler();
  const frames = link.feed(stream).map(decodeFrame);
  const engine = new Engine(opts);
  for (const f of frames) engine.ingest(f);
  return { engine, link };
}

test('acceptance 1: three-bank circular obligations net to zero', () => {
  // full pipeline: fragmentation + retransmission + out-of-order delivery
  const stream = streamOf([
    obl(0, A, B, 'USD', 100, 1),
    obl(0, B, C, 'USD', 100, 1),
    obl(0, C, A, 'USD', 100, 1),
    tick(60000),
  ]);
  const { engine } = runStream(stream);
  assert.equal(engine.closed.length, 1);
  const usd = engine.closed[0].ccys.find((r) => r.ccy === 'USD');
  assert.equal(usd.status, 'settled');
  for (const b of [A, B, C]) assert.equal(usd.net.get(b) ?? 0n, 0n);
  assert.equal(usd.freezes.length, 0, 'no freeze needed when every net is zero');
  assert.equal(usd.credits.length, 0);
});

test('acceptance 2: duplicate ack and out-of-order nak', () => {
  const engine = new Engine({ cycleMs: 60000 });
  engine.ingest(obl(0, A, B, 'USD', 100, 1));
  engine.ingest(ack(0, B, A, 1));
  engine.ingest(ack(0, B, A, 1)); // retransmitted duplicate
  engine.ingest(nak(0, B, A, 2, 3)); // nak arrives BEFORE the obligation (out of order)
  engine.ingest(obl(0, A, B, 'USD', 999, 2));
  engine.ingest(tick(60000));

  const kinds = engine.events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'ack').length, 1, 'exactly one confirmation');
  assert.ok(kinds.includes('duplicate-frame'), 'retransmitted ack deduped');
  assert.ok(kinds.includes('nak-pending'), 'out-of-order nak was held');
  const st = engine.cycleState(0);
  assert.equal(st.obligations.get('0:1').acked, true);
  assert.equal(st.obligations.get('0:2').nacked, true);
  assert.equal(st.obligations.get('0:2').reason, 3);
  const usd = engine.closed[0].ccys.find((r) => r.ccy === 'USD');
  assert.equal(usd.matrix.get('0->1'), 100n, 'nacked obligation excluded from netting');
});

test('acceptance 3: insufficient liquidity unwinds the whole currency only', () => {
  const engine = new Engine({
    cycleMs: 60000,
    positions: { A: { USD: 50, EUR: 100 }, B: { USD: 1000, EUR: 0 }, C: { USD: 1000 } },
  });
  engine.ingest(obl(0, A, B, 'USD', 100, 1)); // A cannot cover its USD net
  engine.ingest(obl(0, A, C, 'EUR', 20, 2)); // EUR is fine
  engine.ingest(tick(60000));

  const res = engine.closed[0];
  const usd = res.ccys.find((r) => r.ccy === 'USD');
  const eur = res.ccys.find((r) => r.ccy === 'EUR');
  assert.equal(usd.status, 'unwound');
  assert.match(usd.certificate.reason, /A insufficient liquidity: needs 100 USD, has 50/);
  assert.deepEqual(usd.compensations, [{ bank: 'B', amount: 100n }]);
  assert.equal(usd.credits.length, 0, 'no partial settlement');
  assert.equal(usd.releases.every((r) => r.reason === 'unwind'), true);
  assert.equal(eur.status, 'settled', 'other currency unaffected');
  const snap = engine.positionsSnapshot();
  assert.equal(snap.A.USD, '50', 'USD freeze fully restored');
  assert.equal(snap.B.USD, '1000', 'B not credited for unwound ccy');
  assert.equal(snap.A.EUR, '80');
  assert.equal(snap.C.EUR, '20');
});

test('acceptance 4: late cancel at the close boundary goes to the next cycle', () => {
  const engine = new Engine({ cycleMs: 60000 });
  engine.ingest(obl(0, A, B, 'USD', 100, 1));
  engine.ingest(tick(60000)); // closes cycle 0, settles the obligation
  engine.ingest(cancel(0, A, 1)); // late cancel for closed cycle 0
  engine.ingest(tick(60000)); // closes cycle 1

  const kinds = engine.events.map((e) => e.kind);
  assert.ok(kinds.includes('late-redirect'), 'cancel redirected to next cycle');
  assert.ok(kinds.includes('cancel-pending'), 'no matching obligation in next cycle');
  assert.ok(kinds.includes('cancel-expired'), 'pending cancel expires at close');
  const usd0 = engine.closed[0].ccys.find((r) => r.ccy === 'USD');
  assert.equal(usd0.status, 'settled');
  assert.deepEqual(usd0.credits, [{ bank: 'B', amount: 100n }], 'cycle 0 settlement untouched');
  assert.equal(engine.closed[1].ccys.length, 0, 'nothing to settle in cycle 1');
});

// Independent brute-force netting: pairwise O(n^2) accumulation,
// written separately from lib/netting.js on purpose.
function bruteForceNet(obls, banks, ccy) {
  const net = new Map(banks.map((b) => [b, 0n]));
  for (const b of banks) {
    for (const c of banks) {
      if (b === c) continue;
      let inn = 0n;
      let out = 0n;
      for (const o of obls) {
        if (o.ccy !== ccy) continue;
        if (o.from === c && o.to === b) inn += o.amount;
        if (o.from === b && o.to === c) out += o.amount;
      }
      net.set(b, net.get(b) + inn - out);
    }
  }
  return net;
}

test('acceptance 5: <=4 banks x 3 obligations, exhaustive enumeration vs brute force', () => {
  const banks = [A, B, C, D];
  const ccys = ['USD', 'EUR'];
  const amounts = [10n, 20n];
  const choices = [];
  for (const from of banks) {
    for (const to of banks) {
      if (from === to) continue;
      for (const ccy of ccys) {
        for (const amount of amounts) choices.push({ from, to, ccy, amount });
      }
    }
  }
  assert.equal(choices.length, 48);
  let combos = 0;
  for (const o1 of choices) {
    for (const o2 of choices) {
      for (const o3 of choices) {
        combos++;
        const obls = [o1, o2, o3];
        const engine = new Engine({ cycleMs: 60000 });
        obls.forEach((o, i) => engine.ingest(obl(0, o.from, o.to, o.ccy, o.amount, i + 1)));
        engine.ingest(tick(60000));
        assert.equal(engine.closed.length, 1);
        for (const ccy of ccys) {
          const expected = bruteForceNet(obls, banks, ccy);
          const res = engine.closed[0].ccys.find((r) => r.ccy === ccy);
          for (const b of banks) {
            const got = res ? (res.net.get(b) ?? 0n) : 0n;
            assert.equal(got, expected.get(b), `combo #${combos} ccy=${ccy} bank=${b}`);
          }
          // conservation: nets sum to zero
          let sum = 0n;
          for (const b of banks) sum += expected.get(b);
          assert.equal(sum, 0n);
        }
        // cross-check gross matrix against a direct sum
        const { matrix } = computeNetting(obls.filter((o) => o.ccy === 'USD'));
        for (const o of obls.filter((x) => x.ccy === 'USD')) {
          const direct = obls
            .filter((x) => x.ccy === 'USD' && x.from === o.from && x.to === o.to)
            .reduce((s, x) => s + x.amount, 0n);
          assert.equal(matrix.get(`${o.from}->${o.to}`), direct);
        }
      }
    }
  }
  assert.equal(combos, 48 ** 3);
});

function writeTmp(name, buf) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), name);
  fs.writeFileSync(p, buf);
  return p;
}

function runCli(args, env = {}) {
  // The sandboxed node shim loses child output on pipes, so capture via files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cli-'));
  const outF = path.join(dir, 'out');
  const errF = path.join(dir, 'err');
  const outFd = fs.openSync(outF, 'w');
  const errFd = fs.openSync(errF, 'w');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return { status: r.status, stdout: fs.readFileSync(outF, 'utf8'), stderr: fs.readFileSync(errF, 'utf8') };
}

test('cli: exit 0 on a valid stream', () => {
  const stream = streamOf([obl(0, A, B, 'USD', 100, 1), tick(60000)], { duplicates: false, shuffle: false });
  const r = runCli([writeTmp('ok.bin', stream)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fx-netting report/);
  assert.match(r.stdout, /\[result USD cycle 0\] settled/);
});

test('cli: checksum error exits 2', () => {
  const buf = encodeFrame(obl(0, A, B, 'USD', 100, 1));
  buf[15] ^= 0xff; // corrupt payload, crc no longer matches
  const stream = Buffer.concat(fragmentFrame(buf, 1, 29));
  const r = runCli([writeTmp('badcrc.bin', stream)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /crc mismatch/);
});

test('cli: nak without reason exits 2', () => {
  const stream = streamOf([obl(0, A, B, 'USD', 100, 1), nak(0, B, A, 1, 0)], { duplicates: false, shuffle: false });
  const r = runCli([writeTmp('nak.bin', stream)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no reason code/);
});

test('cli: unknown cycle exits 3', () => {
  const stream = streamOf([obl(7, A, B, 'USD', 100, 1)], { duplicates: false, shuffle: false });
  const r = runCli([writeTmp('cycle.bin', stream)]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unknown cycle 7/);
});

test('cli: negative obligation exits 4', () => {
  const stream = streamOf([obl(0, A, B, 'USD', -5n, 1)], { duplicates: false, shuffle: false });
  const r = runCli([writeTmp('neg.bin', stream)]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /negative obligation/);
});
