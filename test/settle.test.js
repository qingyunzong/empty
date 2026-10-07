import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Q from '../src/rational.js';
import { loadLog, referenceHash } from '../src/eventlog.js';
import { settle } from '../src/settle.js';
import { verifyCertificate } from '../src/verify.js';
import { runCli } from '../src/cli.js';
import { mulberry32, randInt, pick, naiveNets } from './helpers.js';

const run = (args, extra) => {
  const r = runCli(args, extra);
  if (r.code !== 0 && !extra?.allowFailure) throw new Error(`cli exited ${r.code}: ${r.stderr}`);
  return r.stdout;
};
const runRaw = (args) => runCli(args);

const NORMAL = [
  { addInvoice: { id: 'A:1', ccy: 'CNY', num: 350 } },
  { addInvoice: { id: 'B:1', ccy: 'CNY', num: 350 } },
  { addInvoice: { id: 'C:1', ccy: 'USD', num: -100 } },
  { setRate: { pair: 'USD/CNY', num: 7 } },
].map(JSON.stringify).join('\n');

test('acceptance 1: three parties, two currencies, nets sum to zero', () => {
  const result = settle(loadLog(NORMAL), { base: 'CNY' });
  assert.equal(result.status, 'ok');
  assert.equal(result.balanced, true);
  assert.equal(result.totalExact, '0');
  const byParty = Object.fromEntries(result.nets.map((r) => [r.party, r]));
  assert.equal(byParty.A.exact, '350');
  assert.equal(byParty.B.exact, '350');
  assert.equal(byParty.C.exact, '-700'); // -100 USD * 7
  assert.equal(byParty.C.rounded, '-700.00');
  assert.equal(byParty.C.errorBound, '1/200');
  const sum = result.nets.reduce((acc, r) => Q.add(acc, Q.parseDecimal(r.exact)), Q.ZERO);
  assert.ok(Q.isZero(sum));
});

test('acceptance 2: conflict certificate verifies independently (lib + CLI)', () => {
  const text = [
    { setRate: { pair: 'USD/CNY', num: 7 } },
    { setRate: { pair: 'CNY/EUR', num: '1/7' } },
    { setRate: { pair: 'EUR/USD', num: '1/2' } },
    { addInvoice: { id: 'A:1', ccy: 'USD', num: 10 } },
  ].map(JSON.stringify).join('\n');
  const log = loadLog(text);
  const result = settle(log, { base: 'CNY' });
  assert.equal(result.status, 'infeasible');
  assert.deepEqual(result.certificate.events, ['evt:1', 'evt:2', 'evt:3']);
  assert.equal(result.certificate.minimality, 'exact-minimum');

  const check = verifyCertificate(log, result.certificate);
  assert.equal(check.valid, true);
  assert.deepEqual(check.checks, { eventsResolved: true, payloadsMatch: true, inconsistent: true, minimal: true });

  // tampered certificate must fail
  const tampered = structuredClone(result.certificate);
  tampered.cycle[0].rate = '8';
  assert.equal(verifyCertificate(log, tampered).valid, false);
  const shrunk = { ...result.certificate, events: ['evt:1', 'evt:2'] };
  assert.equal(verifyCertificate(log, shrunk).valid, false);

  // CLI round-trip
  const dir = mkdtempSync(join(tmpdir(), 'settle-'));
  const logFile = join(dir, 'events.jsonl');
  writeFileSync(logFile, text + '\n');
  const certs = new Map();
  const out = JSON.parse(
    run(['settle', logFile, '--base', 'CNY', '--cert-out', 'cert.json'], {
      certSink: (name, text) => certs.set(name, text),
    })
  );
  assert.equal(out.status, 'infeasible');
  const certFile = join(dir, 'cert.json');
  writeFileSync(certFile, certs.get('cert.json'));
  const verifyOut = JSON.parse(run(['verify', logFile, certFile]));
  assert.equal(verifyOut.valid, true);
});

test('acceptance 3 (nets): random logs vs naive brute-force nets', () => {
  const rng = mulberry32(991);
  const ccys = ['USD', 'CNY', 'EUR'];
  for (let trial = 0; trial < 200; trial++) {
    const lines = [];
    // consistent random rates: pick random base values, derive pair rates
    const values = { CNY: Q.ONE, USD: Q.R(BigInt(randInt(rng, 5, 8))), EUR: Q.R(BigInt(randInt(rng, 6, 9))) };
    const pairs = [
      ['USD', 'CNY'],
      ['EUR', 'CNY'],
      ['EUR', 'USD'],
    ];
    for (const [a, b] of pairs) {
      if (rng() < 0.8) {
        const q = Q.div(values[a], values[b]);
        lines.push(JSON.stringify({ setRate: { pair: `${a}/${b}`, num: Q.toString(q) } }));
      }
    }
    const n = randInt(rng, 1, 8);
    for (let i = 0; i < n; i++) {
      lines.push(
        JSON.stringify({
          addInvoice: {
            id: `P${randInt(rng, 0, 3)}:${i}`,
            ccy: i === 0 ? 'CNY' : pick(rng, ccys),
            num: randInt(rng, -500, 500),
            den: randInt(rng, 1, 20),
          },
        })
      );
    }
    const log = loadLog(lines.join('\n'));
    const result = settle(log, { base: 'CNY' });
    if (result.status === 'pending') continue; // disconnected component: nothing to compare
    assert.equal(result.status, 'ok');
    const naive = naiveNets(log.effective, 'CNY');
    for (const row of result.nets) {
      assert.equal(row.exact, Q.toString(naive.get(row.party)), `trial ${trial} party ${row.party}`);
      // rounded figure within the advertised bound of the exact value
      const err = Q.abs(Q.sub(Q.parseDecimal(row.rounded), Q.parseDecimal(row.exact)));
      assert.ok(Q.cmp(err, Q.parseDecimal(row.errorBound)) <= 0);
      assert.equal(row.roundingError, Q.toString(err));
    }
    assert.equal(result.nets.length, naive.size);
  }
});

test('E_PENDING is reported, never as unsatisfiable', () => {
  const log = loadLog([
    JSON.stringify({ addInvoice: { id: 'A:1', ccy: 'JPY', num: 100 } }),
    JSON.stringify({ setRate: { pair: 'USD/CNY', num: 7 } }),
  ].join('\n'));
  const result = settle(log, { base: 'CNY' });
  assert.equal(result.status, 'pending');
  assert.equal(result.error.code, 'E_PENDING');
  assert.deepEqual(result.error.pendingCurrencies, ['JPY']);
});

test('CLI exit codes: E_PARSE=2, E_PENDING=3, E_REF=4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"addInvoice":{"id":"A","ccy":"CNY","num":1,"den":0}}\n');
  let r = runRaw(['settle', bad]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /E_PARSE/);

  const unknownRef = join(dir, 'ref.jsonl');
  writeFileSync(unknownRef, '{"undo":{"eventId":"evt:9"}}\n');
  r = runRaw(['settle', unknownRef]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /E_REF/);

  const pending = join(dir, 'pending.jsonl');
  writeFileSync(pending, '{"addInvoice":{"id":"A:1","ccy":"JPY","num":1}}\n{"setRate":{"pair":"USD/CNY","num":7}}\n');
  r = runRaw(['settle', pending, '--base', 'CNY']);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /E_PENDING/);
});

test('acceptance 4 (CLI): hash trail shows undo restoring history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-'));
  const f = join(dir, 'undo.jsonl');
  writeFileSync(
    f,
    [
      { addInvoice: { id: 'A:1', ccy: 'CNY', num: 100 } },
      { addInvoice: { id: 'B:1', ccy: 'CNY', num: -100 } },
      { addInvoice: { id: 'C:1', ccy: 'CNY', num: 5 } },
      { undo: { eventId: 'evt:3' } },
    ].map(JSON.stringify).join('\n')
  );
  const out = run(['hash', f]);
  const hashes = out.trim().split('\n').map((l) => l.split(' ')[1]);
  assert.equal(hashes[3], hashes[1]); // after undo of evt:3 == before evt:3
  assert.equal(hashes[4], hashes[1]); // head line
});

test('settle output hash matches from-scratch reference', () => {
  const log = loadLog(NORMAL);
  const result = settle(log, { base: 'CNY' });
  assert.equal(result.historyHash, referenceHash(log.effective));
});
