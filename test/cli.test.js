import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main, EXIT_OK, EXIT_ERROR, EXIT_CORRUPT } from '../src/cli.js';
import { recordBytes } from '../src/log.js';
import { tmpdir, cleanup } from './helpers.js';

const PAGE = 512;

// Run the CLI in-process (the sandbox forbids nested spawns) with captured io.
async function run(args, { stdin } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: () => stdin ?? '',
  });
  return {
    code,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    json: () => JSON.parse(out.join('\n')),
    errJson: () => JSON.parse(err.join('\n')),
  };
}

function writeJsonl(dir, records) {
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('append reads JSONL and prints stats, root, violations', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    const input = writeJsonl(dir, [
      { tenant: 'a', seq: 0, data: 'rent' },
      { tenant: 'a', seq: 1, data: 'power' },
      { tenant: 'b', seq: 0, data: 'rent' },
    ]);
    const res = await run(['append', '--log', logDir, '--input', input]);
    assert.equal(res.code, EXIT_OK, res.stderr);
    const out = res.json();
    assert.equal(out.stats.appended, 3);
    assert.equal(out.stats.tenants.a.count, 2);
    assert.equal(out.stats.tenants.b.count, 1);
    assert.match(out.root, /^[0-9a-f]{64}$/);
    assert.deepEqual(out.violations, []);

    const v = await run(['verify', '--log', logDir]);
    assert.equal(v.code, EXIT_OK);
    const vout = v.json();
    assert.equal(vout.ok, true);
    assert.equal(vout.root, out.root);
  } finally {
    cleanup(dir);
  }
});

test('append reports QUOTA and SEQ_GAP violations and continues', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    const config = path.join(dir, 'config.json');
    const record = { tenant: 'a', seq: 0, data: 'x'.repeat(40) };
    const quota = recordBytes(record) * 2; // room for exactly two records
    fs.writeFileSync(config, JSON.stringify({
      pageSize: PAGE,
      quotas: { a: { diskBytes: quota } },
    }));
    const input = writeJsonl(dir, [
      { ...record, seq: 0 },
      { ...record, seq: 1 },
      { ...record, seq: 2 }, // exceeds the disk quota
      { tenant: 'b', seq: 5, data: 'gap' }, // seq must start at 0
      { tenant: 'b', seq: 0, data: 'ok' },
    ]);
    const res = await run(['append', '--log', logDir, '--input', input, '--config', config]);
    assert.equal(res.code, EXIT_OK, res.stderr);
    const out = res.json();
    assert.equal(out.stats.appended, 3);
    const codes = out.violations.map((v) => v.code).sort();
    assert.deepEqual(codes, ['QUOTA', 'SEQ_GAP']);
    const quotaViolation = out.violations.find((v) => v.code === 'QUOTA');
    assert.equal(quotaViolation.tenant, 'a');
    assert.equal(quotaViolation.seq, 2);
    const gap = out.violations.find((v) => v.code === 'SEQ_GAP');
    assert.equal(gap.tenant, 'b');
    assert.equal(gap.seq, 5);
  } finally {
    cleanup(dir);
  }
});

test('append on a READONLY log fails with the READONLY code', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'READONLY'), '');
    const input = writeJsonl(dir, [{ tenant: 'a', seq: 0, data: 'x' }]);
    const res = await run(['append', '--log', logDir, '--input', input]);
    assert.equal(res.code, EXIT_ERROR);
    assert.equal(res.errJson().error.code, 'READONLY');
  } finally {
    cleanup(dir);
  }
});

test('recover then verify: torn tail is quarantined, chain verifies', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    const input = writeJsonl(dir, Array.from({ length: 20 }, (_, i) => ({
      tenant: 'a', seq: i, data: 'x'.repeat(40),
    })));
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ pageSize: PAGE }));
    const res = await run(['append', '--log', logDir, '--input', input, '--config', config]);
    assert.equal(res.code, EXIT_OK, res.stderr);
    const root = res.json().root;

    // simulate a torn tail: garbage appended after the last committed page
    const size = fs.statSync(path.join(logDir, 'data.log')).size;
    fs.appendFileSync(path.join(logDir, 'data.log'), Buffer.alloc(137, 0xab));

    // append refuses until recovery (deterministic recovery point)
    const res2 = await run(['append', '--log', logDir, '--input', input, '--config', config]);
    assert.equal(res2.code, EXIT_CORRUPT);
    assert.equal(res2.errJson().error.code, 'CORRUPT');

    const rec = await run(['recover', '--log', logDir, '--config', config]);
    assert.equal(rec.code, EXIT_OK, rec.stderr);
    const rout = rec.json();
    assert.equal(rout.stats.truncatedBytes, 137);
    assert.equal(rout.stats.quarantined, 1);
    assert.equal(rout.root, root);
    assert.equal(rout.quarantine[0].offset, size);
    assert.equal(rout.quarantine[0].length, 137);
    assert.ok(fs.existsSync(path.join(logDir, 'quarantine', `orphan-${size}.bin`)));

    const v = await run(['verify', '--log', logDir, '--config', config]);
    assert.equal(v.code, EXIT_OK);
    assert.equal(v.json().root, root);
  } finally {
    cleanup(dir);
  }
});

test('verify exits non-zero with CORRUPT on a tampered page', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    const input = writeJsonl(dir, Array.from({ length: 20 }, (_, i) => ({
      tenant: 'a', seq: i, data: 'x'.repeat(40),
    })));
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ pageSize: PAGE }));
    await run(['append', '--log', logDir, '--input', input, '--config', config]);

    // flip a byte in the first page payload
    const file = path.join(logDir, 'data.log');
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 100);
    fs.closeSync(fd);

    const v = await run(['verify', '--log', logDir, '--config', config]);
    assert.equal(v.code, EXIT_CORRUPT);
    const out = v.json();
    assert.equal(out.ok, false);
    assert.equal(out.violations[0].code, 'CORRUPT');
  } finally {
    cleanup(dir);
  }
});

test('append reads records from stdin when --input is omitted', async () => {
  const dir = tmpdir();
  try {
    const logDir = path.join(dir, 'log');
    const res = await run(['append', '--log', logDir], {
      stdin: '{"tenant":"a","seq":0,"data":"stdin"}\n',
    });
    assert.equal(res.code, EXIT_OK, res.stderr);
    assert.equal(res.json().stats.appended, 1);
  } finally {
    cleanup(dir);
  }
});
