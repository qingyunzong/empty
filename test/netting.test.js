'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  encodeFrame, decodeFrame, encodePacket, buildFile, parseFile, reassemble,
  FRAME_TYPES, ValidationError,
} = require('../wire');
const { Engine, UnknownCycleError, NegativeObligationError } = require('../engine');

const O = FRAME_TYPES.OBLIGATION, A = FRAME_TYPES.ACK, N = FRAME_TYPES.NAK, C = FRAME_TYPES.CANCEL;
const BIG = 10n ** 12n;

function obl(cycle, from, to, ccy, amount, seq) {
  return { type: O, cycle, from, to, ccy, amount: BigInt(amount), seq, reason: 0 };
}
function mkEngine(ids, balance = BIG) {
  return new Engine(ids.map((id) => ({ id, ccy: 'USD', balance })));
}
function netOf(engine, cycle, ccy) {
  const r = engine.cycleResults.find((x) => x.cycle === cycle && x.ccy === ccy);
  return r ? r.net : null;
}

test('1. three-bank circular obligations net to zero', () => {
  const e = mkEngine(['AAA', 'BBB', 'CCC'], 0n);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 1000, 1));
  e.submit(obl(1, 'BBB', 'CCC', 'USD', 1000, 1));
  e.submit(obl(1, 'CCC', 'AAA', 'USD', 1000, 1));
  e.closeAll();
  const net = netOf(e, 1, 'USD');
  assert.equal(net.get('AAA'), 0n);
  assert.equal(net.get('BBB'), 0n);
  assert.equal(net.get('CCC'), 0n);
  assert.equal(e.cycleResults[0].status, 'SETTLED');
  // zero net => nothing frozen, balances untouched
  for (const b of ['AAA', 'BBB', 'CCC']) {
    assert.equal(e.getAvail(b, 'USD'), 0n);
    assert.equal(e.getFrozen(b, 'USD'), 0n);
  }
  assert.ok(!e.output.some((l) => l.includes('FREEZE')));
});

test('2a. duplicate ack does not double-confirm', () => {
  const e = mkEngine(['AAA', 'BBB']);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 500, 1));
  e.submit({ type: A, cycle: 1, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 0n, seq: 1, reason: 0 });
  e.submit({ type: A, cycle: 1, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 0n, seq: 1, reason: 0 });
  const ob = e.open.get('AAA|1');
  assert.equal(ob.acks.size, 1);
  assert.ok(e.output.some((l) => l.includes('ACK duplicate ignored')));
  e.closeAll();
  assert.equal(e.cycleResults[0].status, 'SETTLED');
});

test('2b. out-of-order nak removes obligation, requires reason', () => {
  // frames arrive out of order at the link layer; engine sees them reordered
  const frames = [
    encodeFrame(obl(1, 'AAA', 'BBB', 'USD', 500, 1)),
    encodeFrame(obl(1, 'CCC', 'AAA', 'USD', 700, 1)),
    encodeFrame({ type: N, cycle: 1, from: 'AAA', to: 'CCC', ccy: 'USD', amount: 0n, seq: 1, reason: 5 }),
  ];
  const packets = frames.map((f, i) => encodePacket({
    linkSeq: i + 1, fragId: i + 1, fragIndex: 0, fragCount: 1, payload: f,
  }));
  const shuffled = [packets[2], packets[0], packets[1]]; // nak first on the wire
  const file = buildFile({ banks: [], packets: shuffled });
  const log = [];
  const ordered = reassemble(parseFile(file).packets, log).map(decodeFrame);
  assert.deepEqual(ordered.map((f) => f.type), [O, O, N]); // reordered by linkSeq
  const e = mkEngine(['AAA', 'BBB', 'CCC']);
  for (const f of ordered) e.submit(f);
  e.closeAll();
  assert.ok(e.output.some((l) => l.includes('NAK AAA rejects CCC seq=1 reason=VALIDATION')));
  const net = netOf(e, 1, 'USD');
  assert.equal(net.get('AAA'), -500n); // only AAA->BBB survives
  assert.equal(net.get('BBB'), 500n);
  assert.equal(net.get('CCC'), undefined); // naked obligation gone
});

test('2c. nak without reason is a validation error (exit 2)', () => {
  const e = mkEngine(['AAA', 'BBB']);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 500, 1));
  assert.throws(
    () => e.submit({ type: N, cycle: 1, from: 'BBB', to: 'AAA', ccy: 'USD', amount: 0n, seq: 1, reason: 0 }),
    (err) => err instanceof ValidationError && err.exitCode === 2);
});

test('3. insufficient liquidity unwinds the whole ccy, no partial settlement', () => {
  const e = new Engine([
    { id: 'AAA', ccy: 'USD', balance: 5000n },
    { id: 'AAA', ccy: 'EUR', balance: 1000n },
    { id: 'BBB', ccy: 'USD', balance: 4000n },
    { id: 'CCC', ccy: 'USD', balance: 0n },
    { id: 'CCC', ccy: 'EUR', balance: 0n },
  ]);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 4000, 1));
  e.submit(obl(1, 'BBB', 'CCC', 'USD', 9000, 1));
  e.submit(obl(1, 'AAA', 'CCC', 'EUR', 200, 2));
  e.closeAll();
  const usd = e.cycleResults.find((r) => r.ccy === 'USD');
  const eur = e.cycleResults.find((r) => r.ccy === 'EUR');
  assert.equal(usd.status, 'UNWOUND');
  assert.equal(eur.status, 'SETTLED'); // other ccy unaffected
  // all USD freezes restored, nobody paid/received USD
  assert.equal(e.getAvail('AAA', 'USD'), 5000n);
  assert.equal(e.getAvail('BBB', 'USD'), 4000n);
  assert.equal(e.getAvail('CCC', 'USD'), 0n);
  assert.equal(e.getFrozen('AAA', 'USD'), 0n);
  // EUR settled normally
  assert.equal(e.getAvail('AAA', 'EUR'), 800n);
  assert.equal(e.getAvail('CCC', 'EUR'), 200n);
  // unwind certificate + compensation entries
  assert.ok(e.output.some((l) => l.includes('UNWIND-CERTIFICATE ccy=USD')));
  assert.ok(e.output.some((l) => l.includes('RELEASE-RESTORE AAA 4000 USD')));
  assert.ok(e.output.some((l) => l.includes('status=NO_PARTIAL_SETTLEMENT')));
  assert.equal(e.compensations.length, 3);
  const claims = e.compensations.filter((c) => c.kind === 'COMPENSATION_CLAIM');
  assert.deepEqual(claims.map((c) => [c.bank, c.amount]), [['CCC', 9000n]]);
});

test('4. late cancel at close boundary is routed to next cycle and rejected', () => {
  const e = mkEngine(['AAA', 'BBB']);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 800, 1));
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 300, 2));
  // in-time cancel works
  e.submit({ type: C, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 0n, seq: 2, reason: 0 });
  assert.ok(!e.open.has('AAA|2'));
  // cycle-2 frame closes cycle 1 (virtual clock advance)
  e.submit(obl(2, 'BBB', 'AAA', 'USD', 100, 1));
  assert.equal(e.clock.cycle, 2);
  assert.equal(e.cycleResults.length, 1);
  assert.equal(e.cycleResults[0].status, 'SETTLED');
  // late cancel for the settled cycle-1 obligation: routed into cycle 2, rejected
  e.submit({ type: C, cycle: 1, from: 'AAA', to: 'BBB', ccy: 'USD', amount: 0n, seq: 1, reason: 0 });
  assert.ok(e.output.some((l) => l.includes('CANCEL rejected AAA seq=1') && l.includes('late(from-closed-cycle=1)')));
  e.closeAll();
  // cycle-1 settlement stands
  assert.equal(e.getAvail('AAA', 'USD'), BIG - 800n + 100n);
  assert.equal(e.getAvail('BBB', 'USD'), BIG + 800n - 100n);
});

test('5. exhaustive <=4 banks x 3 obligations matches independent brute force', () => {
  // independent brute-force netting: net[b] = sum(in) - sum(out)
  function brute(obs) {
    const net = new Map();
    for (const o of obs) {
      net.set(o.from, (net.get(o.from) || 0n) - o.amount);
      net.set(o.to, (net.get(o.to) || 0n) + o.amount);
    }
    return net;
  }
  const ALL = ['AAA', 'BBB', 'CCC', 'DDD'];
  const AMOUNTS = [100n, 300n];
  let cases = 0;
  for (let nBanks = 2; nBanks <= 4; nBanks++) {
    const banks = ALL.slice(0, nBanks);
    const pairs = [];
    for (const f of banks) for (const t of banks) if (f !== t) pairs.push([f, t]);
    for (const [f1, t1] of pairs) for (const [f2, t2] of pairs) for (const [f3, t3] of pairs) {
      for (const a1 of AMOUNTS) for (const a2 of AMOUNTS) for (const a3 of AMOUNTS) {
        const obs = [
          { from: f1, to: t1, amount: a1 },
          { from: f2, to: t2, amount: a2 },
          { from: f3, to: t3, amount: a3 },
        ];
        const e = mkEngine(banks);
        const seqBy = new Map();
        obs.forEach((o, i) => {
          const seq = (seqBy.get(o.from) || 0) + 1;
          seqBy.set(o.from, seq);
          e.submit(obl(1, o.from, o.to, 'USD', o.amount, seq));
        });
        e.closeAll();
        const got = netOf(e, 1, 'USD');
        const want = brute(obs);
        for (const b of banks) {
          assert.equal(got.get(b) || 0n, want.get(b) || 0n,
            `banks=${banks} obs=${JSON.stringify(obs, (k, v) => typeof v === 'bigint' ? Number(v) : v)} bank=${b}`);
        }
        // with unlimited liquidity everything settles and conservation holds
        assert.equal(e.cycleResults[0].status, 'SETTLED');
        let sum = 0n;
        for (const b of banks) sum += got.get(b) || 0n;
        assert.equal(sum, 0n);
        cases++;
      }
    }
  }
  assert.equal(cases, 8 * (2 ** 3 + 6 ** 3 + 12 ** 3)); // pairs=n*(n-1), triples, 2^3 amount combos
});

test('wire: frame round-trip and crc tamper detection', () => {
  const f = obl(7, 'AAA', 'BBB', 'EUR', 123456789n, 42);
  const d = decodeFrame(encodeFrame(f));
  assert.deepEqual(d, { ...f, reason: 0 });
  const bad = encodeFrame(f);
  bad[10] ^= 0x01;
  assert.throws(() => decodeFrame(bad), ValidationError);
});

test('wire: fragmentation, retransmission dedup, out-of-order reassembly', () => {
  const f1 = encodeFrame(obl(1, 'AAA', 'BBB', 'USD', 100, 1));
  const f2 = encodeFrame(obl(1, 'BBB', 'AAA', 'USD', 200, 1));
  const packets = [
    encodePacket({ linkSeq: 1, fragId: 1, fragIndex: 0, fragCount: 3, payload: f1.subarray(0, 10) }),
    encodePacket({ linkSeq: 2, fragId: 1, fragIndex: 1, fragCount: 3, payload: f1.subarray(10, 20) }),
    encodePacket({ linkSeq: 3, fragId: 1, fragIndex: 2, fragCount: 3, payload: f1.subarray(20) }),
    encodePacket({ linkSeq: 4, fragId: 2, fragIndex: 0, fragCount: 1, payload: f2 }),
  ];
  const retrans = packets[2]; // retransmitted fragment
  const wireOrder = [packets[3], packets[1], retrans, packets[0], packets[2]];
  const file = buildFile({ banks: [], packets: wireOrder });
  const log = [];
  const frames = reassemble(parseFile(file).packets, log);
  assert.equal(frames.length, 2);
  assert.ok(frames[0].equals(f1));
  assert.ok(frames[1].equals(f2));
  assert.ok(log.some((l) => l.includes('retransmission deduped')));
});

test('wire: missing fragment is a validation error', () => {
  const f1 = encodeFrame(obl(1, 'AAA', 'BBB', 'USD', 100, 1));
  const packets = [
    encodePacket({ linkSeq: 1, fragId: 1, fragIndex: 0, fragCount: 2, payload: f1.subarray(0, 10) }),
  ];
  const file = buildFile({ banks: [], packets });
  assert.throws(() => reassemble(parseFile(file).packets, []), /missing fragments/);
});

test('engine: unknown cycle exit 3, negative obligation exit 4', () => {
  const e = mkEngine(['AAA', 'BBB']);
  assert.throws(() => e.submit(obl(0, 'AAA', 'BBB', 'USD', 1, 1)),
    (err) => err instanceof UnknownCycleError && err.exitCode === 3);
  assert.throws(() => e.submit(obl(3, 'AAA', 'BBB', 'USD', 1, 1)),
    (err) => err instanceof UnknownCycleError && err.exitCode === 3);
  assert.throws(() => e.submit(obl(1, 'AAA', 'BBB', 'USD', -1, 1)),
    (err) => err instanceof NegativeObligationError && err.exitCode === 4);
});

test('engine: duplicate obligation frame deduped per (from, seq)', () => {
  const e = mkEngine(['AAA', 'BBB']);
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 100, 1));
  e.submit(obl(1, 'AAA', 'BBB', 'USD', 100, 1));
  assert.ok(e.output.some((l) => l.includes('duplicate ignored')));
  e.closeAll();
  assert.equal(netOf(e, 1, 'USD').get('AAA'), -100n); // counted once
});

test('cli: exit codes end-to-end', () => {
  // note: grandchild stdio pipes are unreliable in some sandboxes, so the
  // child writes to temp files via shell redirection instead.
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (f, tag) => {
    const out = path.join(os.tmpdir(), `fxnq-${tag}-${process.pid}.out`);
    const r = spawnSync('sh', ['-c',
      `"${process.execPath}" "${cli}" "${path.join(__dirname, '..', 'samples', f)}" > "${out}" 2>&1; echo $?`],
      { encoding: 'utf8' });
    const status = Number(r.stdout.trim().split('\n').pop());
    const text = fs.readFileSync(out, 'utf8');
    fs.unlinkSync(out);
    return { status, text };
  };
  assert.equal(run('sample1_circle.bin', 's1').status, 0);
  assert.equal(run('sample5_negative.bin', 's5').status, 4);
  assert.equal(run('sample6_unknown_cycle.bin', 's6').status, 3);
  assert.equal(run('sample7_bad_crc.bin', 's7').status, 2);
  const ok = run('sample2_dup_ooo.bin', 's2');
  assert.equal(ok.status, 0);
  assert.ok(ok.text.includes('ACK duplicate ignored'));
  assert.ok(ok.text.includes('retransmission deduped'));
});
