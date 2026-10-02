import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { tmpdirPath, runCli } from '../testlib/helpers.js';
import { appendToLog, readJsonl, writeJsonl } from '../lib/store.js';
import { verify } from '../lib/verify.js';
import { canonical } from '../lib/canon.js';

// Acceptance 3: missing summary lists gaps only; it never judges failure.
test('dropped middle record yields unknown status with a listed gap, exit 0', () => {
  const dir = tmpdirPath();
  const log = join(dir, 's.jsonl');
  appendToLog(log, { site: 'S', epoch: 1, type: 'step', payload: { n: 1 } });
  appendToLog(log, { site: 'S', epoch: 1, type: 'step', payload: { n: 2 } });
  appendToLog(log, { site: 'S', epoch: 1, type: 'step', payload: { n: 3 } });

  const records = readJsonl(log);
  const holed = join(dir, 'holed.jsonl');
  writeJsonl(holed, [records[0], records[2]]); // seq 2 dropped

  const cert = verify(readJsonl(holed));
  assert.equal(cert.status, 'unknown');
  assert.ok(cert.missing.some((m) => m.kind === 'gap' && m.site === 'S' && m.seq === 2));
  assert.ok(cert.missing.some((m) => m.kind === 'prev' && m.hash === records[1].hash));
  assert.ok(!('compliant' in cert) && cert.status !== 'fail', 'no compliance judgement');

  const res = runCli(['verify', holed]);
  assert.equal(res.status, 0, `missing data must not fail verification: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'unknown');
});

test('broken hash chain exits 15; tampered payload detected', () => {
  const dir = tmpdirPath();
  const log = join(dir, 't.jsonl');
  appendToLog(log, { site: 'T', epoch: 1, type: 'step', payload: { n: 1 } });
  appendToLog(log, { site: 'T', epoch: 1, type: 'step', payload: { n: 2 } });
  const records = readJsonl(log);
  const tampered = { ...records[0], payload: { n: 999 } }; // hash no longer matches
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, canonical(tampered) + '\n' + canonical(records[1]) + '\n');
  const res = runCli(['verify', bad]);
  assert.equal(res.status, 15, res.stderr);
  assert.match(res.stderr, /broken chain/);
});
