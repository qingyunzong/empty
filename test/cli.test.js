import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { tmpdir, cleanup } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Note: child stdout/stderr are captured via files (pipes are unreliable in
// some sandboxed environments); exit codes come from the process itself.
async function cli(args) {
  const outFile = path.join(os.tmpdir(), `cli-out-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const errFile = `${outFile}.err`;
  const outFd = await fs.open(outFile, 'w');
  const errFd = await fs.open(errFile, 'w');
  const code = await new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      stdio: ['ignore', outFd.fd, errFd.fd],
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  await outFd.close();
  await errFd.close();
  const stdout = await fs.readFile(outFile, 'utf8');
  const stderr = await fs.readFile(errFile, 'utf8');
  await fs.rm(outFile, { force: true });
  await fs.rm(errFile, { force: true });
  return { code, stdout, stderr };
}

const append = (dir, seq, extra = []) =>
  cli(['append', '--dir', dir, '--device', 'dev-1', '--seq', String(seq), '--message', `m${seq}`, ...extra]);

test('CLI: append/replay/dedup, E_GAP exit 3, E_CRC exit 4', async () => {
  const dir = await tmpdir();
  try {
    let r = await append(dir, 1);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).status, 'appended');
    r = await append(dir, 2);
    assert.equal(r.code, 0);

    // duplicate send -> deduped, still exit 0
    r = await append(dir, 2);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).status, 'deduped');

    // clean replay
    r = await cli(['replay', '--dir', dir]);
    assert.equal(r.code, 0);
    let out = JSON.parse(r.stdout);
    assert.deepEqual(out.alerts.map((a) => a.seq), [1, 2]);
    assert.deepEqual(out.cursor, { 'dev-1': 2 });

    // packet loss: seq 4 arrives with 3 missing -> E_GAP, exit code 3
    r = await append(dir, 4);
    assert.equal(r.code, 0);
    r = await cli(['replay', '--dir', dir]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /E_GAP/);
    out = JSON.parse(r.stdout);
    assert.deepEqual(out.alerts.map((a) => a.seq), [1, 2]);
    assert.deepEqual(out.cursor, { 'dev-1': 2 });

    // cursor-based incremental replay from the CLI
    r = await cli(['replay', '--dir', dir, '--cursor', '{"dev-1":2}']);
    assert.equal(r.code, 3);
    out = JSON.parse(r.stdout);
    assert.deepEqual(out.alerts, []); // first record past cursor is seq 4, gap at 3

    // corrupt one byte inside the segment -> verify exits 4 with E_CRC
    const segFile = path.join(dir, 'segments', 'seg-000001.dat');
    const buf = await fs.readFile(segFile);
    buf[buf.length - 6] ^= 0xff;
    await fs.writeFile(segFile, buf);
    r = await cli(['verify', '--dir', dir]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /E_CRC/);
  } finally {
    await cleanup(dir);
  }
});

test('CLI: index reports device, min/max seq and file offsets', async () => {
  const dir = await tmpdir();
  try {
    await append(dir, 1);
    await append(dir, 2);
    const r = await cli(['index', '--dir', dir]);
    assert.equal(r.code, 0);
    const idx = JSON.parse(r.stdout);
    const dev = idx.devices['dev-1'];
    assert.equal(dev.minSeq, 1);
    assert.equal(dev.maxSeq, 2);
    assert.ok(dev.segments.length >= 1);
    assert.ok(Number.isInteger(dev.segments[0].offset));
    // index.json is persisted alongside the manifest
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(onDisk.devices['dev-1'].maxSeq, 2);
  } finally {
    await cleanup(dir);
  }
});
