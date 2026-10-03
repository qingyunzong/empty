import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  return { inDir, outDir };
}

async function runCli(args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    const code = await main(args);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

test('trace certify writes certs.jsonl, void.jsonl, late.log', async () => {
  const { inDir, outDir } = setup();
  writeFileSync(
    join(inDir, '00-calib.jsonl'),
    JSON.stringify({
      id: 'c1', type: 'calib', eventTs: 100, tool: 'T1',
      ok: true, validFrom: 0, validTo: 5000, op: 'QA',
    }) + '\n',
  );
  writeFileSync(
    join(inDir, '01-events.jsonl'),
    [
      { id: 't1', type: 'torque', eventTs: 1000, bolt: 'B1', tool: 'T1', peak: 12.5, angle: 45, op: 'OP1' },
      { id: 't2', type: 'torque', eventTs: 5000, bolt: 'B2', tool: 'T1', peak: 11, angle: 30, op: 'OP1' },
      { id: 's1', type: 'scan', eventTs: 1200, bolt: 'B1', lot: 'L1', op: 'OP1' }, // late
      { type: 'retract', eventTs: 6000, kind: 'calib', id: 'c1' },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const { code, stdout } = await runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);
  assert.match(stdout, /cert version/);

  const certs = readJsonl(join(outDir, 'certs.jsonl'));
  const b1 = certs.filter((c) => c.bolt === 'B1');
  assert.deepEqual(b1.map((c) => c.status), ['HOLD', 'OK', 'VOID']);
  assert.deepEqual(b1.map((c) => c.version), [1, 2, 3]);

  const voids = readJsonl(join(outDir, 'void.jsonl'));
  assert.equal(voids.length, 1); // only B1 was OK before the calib retraction
  assert.ok(voids.every((v) => v.reason === 'NO_CALIB'));

  const b2 = certs.filter((c) => c.bolt === 'B2');
  assert.deepEqual(b2.map((c) => c.status), ['HOLD', 'HOLD']); // never OK -> no VOID

  const late = readFileSync(join(outDir, 'late.log'), 'utf8');
  assert.match(late, /LATE type=scan id=s1 eventTs=1200 watermark=5000/);

  assert.equal(readJsonl(join(outDir, 'errors.jsonl')).length, 0);
});

test('cli reports DUP_EVENT in errors.jsonl and still exits 0', async () => {
  const { inDir, outDir } = setup();
  writeFileSync(
    join(inDir, 'events.jsonl'),
    [
      { id: 't1', type: 'torque', eventTs: 1000, bolt: 'B1', tool: 'T1', peak: 1, angle: 10, op: 'OP1' },
      { id: 't1', type: 'torque', eventTs: 1000, bolt: 'B1', tool: 'T1', peak: 1, angle: 99, op: 'OP1' },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const { code, stderr } = await runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);
  assert.match(stderr, /errors\.jsonl/);
  const errors = readJsonl(join(outDir, 'errors.jsonl'));
  assert.equal(errors.filter((e) => e.code === 'DUP_EVENT').length, 1);
});

test('cli rejects unknown arguments with exit code 2', async () => {
  const { inDir, outDir } = setup();
  const { code, stderr } = await runCli(['certify', '--in', inDir, '--out', outDir, '--bogus']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument/);
});

test('output dirs are created and files exist even when empty', async () => {
  const { inDir, outDir } = setup();
  await runCli(['certify', '--in', inDir, '--out', outDir]);
  for (const name of ['certs.jsonl', 'void.jsonl', 'late.log', 'errors.jsonl']) {
    assert.ok(existsSync(join(outDir, name)), name);
  }
});
