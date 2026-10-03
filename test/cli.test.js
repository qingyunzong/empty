import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ev } from './helpers.js';

// NOTE: this sandbox drops data on node->node pipe stdio, so the CLI under
// test is wired up through a FIFO (stdin) and a regular file (stdout).
async function startCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-merger-cli-'));
  const fifo = path.join(dir, 'in.fifo');
  const outFile = path.join(dir, 'out.jsonl');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo failed');
  const fdIn = fs.openSync(fifo, 'r+'); // O_RDWR: never blocks, child reads
  const fdOut = fs.openSync(outFile, 'w');
  const proc = spawn(process.execPath, ['cli.js'], { stdio: [fdIn, fdOut, 'inherit'] });

  let offset = 0;
  const readLine = async () => {
    for (let i = 0; i < 500; i += 1) {
      const stat = fs.statSync(outFile);
      if (stat.size > offset) {
        const fd = fs.openSync(outFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        const idx = buf.indexOf(0x0a);
        if (idx !== -1) {
          const line = buf.subarray(0, idx).toString('utf8');
          offset += idx + 1;
          return JSON.parse(line);
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out waiting for CLI response');
  };

  const send = (cmd) => {
    fs.writeSync(fdIn, JSON.stringify(cmd) + '\n');
    return readLine();
  };
  // The O_RDWR stdin fd means the child never sees EOF; stop it explicitly.
  const close = () => new Promise((resolve) => {
    proc.on('close', resolve);
    proc.kill();
  });
  return { send, close };
}

test('JSONL CLI end-to-end: merge, resolve, commit, projection, certificate', async () => {
  const cli = await startCli();
  let r = await cli.send({ op: 'init' });
  assert.equal(r.ok, true);

  r = await cli.send({ op: 'loadBranch', name: 'base', events: [ev('a', 1, { note: 'x' }), ev('b', 0)] });
  assert.equal(r.ok, true);
  await cli.send({ op: 'loadBranch', name: 'local', events: [ev('a', 1, { note: 'y' }), ev('b', 0)] });
  await cli.send({ op: 'loadBranch', name: 'remote', events: [ev('a', 1, { note: 'z' }), ev('b', 0), ev('c', 2, { dependsOn: ['a'] })] });

  r = await cli.send({ op: 'merge' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unresolved, ['field:a:note']);
  assert.deepEqual(r.order, ['b', 'a', 'c']);

  // Bad preconditions are rejected without state change.
  r = await cli.send({ op: 'resolve', conflictId: 'field:a:note', field: 'note', choice: 'local', expect: { local: 'NOPE', remote: 'z' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRECONDITION_FAILED');

  r = await cli.send({ op: 'resolve', conflictId: 'field:a:note', field: 'note', choice: 'local', expect: { local: 'y', remote: 'z' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unresolved, []);

  r = await cli.send({ op: 'mergeCommit' });
  assert.equal(r.ok, true);
  const snapId = r.snapshotId;

  r = await cli.send({ op: 'projection' });
  assert.deepEqual(r.events.map((e) => e.id), ['b', 'a', 'c']);
  assert.equal(r.events.find((e) => e.id === 'a').note, 'y');

  r = await cli.send({ op: 'checkCertificate', snapshotId: snapId });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);

  r = await cli.send({ op: 'history' });
  assert.deepEqual(r.history, [snapId]);
  assert.equal(r.index, snapId);

  await cli.close();
});

test('JSONL CLI reports invalid branches and unknown ops', async () => {
  const cli = await startCli();
  let r = await cli.send({ op: 'bogus' });
  assert.equal(r.ok, false);
  r = await cli.send({ op: 'loadBranch', name: 'local', events: [ev('a', 1, { dependsOn: ['ghost'] })] });
  assert.equal(r.ok, false);
  assert.match(r.error, /missing event ghost/);
  r = await cli.send({ op: 'loadBranch', name: 'local', events: [ev('a', 1, { dependsOn: ['b'] }), ev('b', 2, { dependsOn: ['a'] })] });
  assert.equal(r.ok, false);
  assert.match(r.error, /cycle/);
  await cli.close();
});
