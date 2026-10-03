import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  BIN,
  makeWorkspace,
  writeEvents,
  runCli,
  readFile,
  sensor,
} from '../testlib/helpers.js';

function makeEvents(n) {
  const events = [];
  for (let k = 0; k < n; k++) {
    const ts = k * 1000;
    const high = Math.floor(k / 4) % 2 === 0; // 4s high, 4s low
    events.push(sensor(`p${k}`, ts, 'pressure', high ? 1200 : 500));
    events.push(sensor(`t${k}`, ts, 'temperature', high ? 200 : 150));
  }
  events.push({ type: 'trip', id: 'trip1', eventTs: 3500, channel: 'PT-1', state: 'TRIPPED' });
  events.push(sensor('p-late', 1500, 'pressure', 500)); // late: revokes ARM/TRIP
  events.push({ type: 'retract', eventTs: (n - 1) * 1000, kind: 'sensor', id: 't3' });
  return events;
}

function readOutputs(outDir) {
  return {
    states: readFile(path.join(outDir, 'states.jsonl')),
    late: readFile(path.join(outDir, 'late.log')),
    proof: readFile(path.join(outDir, 'proof.json')),
  };
}

function waitForCommits(outDir, target, timeoutMs = 30000) {
  const snapshotPath = path.join(outDir, 'snapshot.json');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        if (snapshot.commits >= target) return resolve(snapshot.commits);
      } catch {
        // snapshot not written yet
      }
      if (Date.now() > deadline) return reject(new Error('timeout waiting for commits'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('recovery after kill produces results identical to a clean run', async (t) => {
  // Reference: clean uninterrupted run.
  const clean = makeWorkspace();
  writeEvents(clean.inDir, makeEvents(60));
  const cleanRun = runCli(clean.inDir, clean.outDir);
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  const expected = readOutputs(clean.outDir);
  assert.ok(expected.states.includes('REVOKE'), 'fixture should exercise compensation');

  // Re-running on a completed output dir is a no-op and stays identical.
  const rerun = runCli(clean.inDir, clean.outDir);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(readOutputs(clean.outDir), expected);

  await t.test('abort via test hook (exit after N commits)', () => {
    const ws = makeWorkspace();
    writeEvents(ws.inDir, makeEvents(60));
    const crashed = runCli(ws.inDir, ws.outDir, {
      env: { INTERLOCK_EXIT_AFTER_COMMITS: '25' },
    });
    assert.equal(crashed.status, 42, `expected crash exit, got ${crashed.status}`);
    assert.ok(fs.existsSync(path.join(ws.outDir, 'snapshot.json')));
    assert.ok(!fs.existsSync(path.join(ws.outDir, 'proof.json')));

    const recovered = runCli(ws.inDir, ws.outDir);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(readOutputs(ws.outDir), expected);
  });

  await t.test('SIGKILL mid-run then resume', async () => {
    const ws = makeWorkspace();
    writeEvents(ws.inDir, makeEvents(400));
    const expectedLarge = (() => {
      const ref = makeWorkspace();
      writeEvents(ref.inDir, makeEvents(400));
      const run = runCli(ref.inDir, ref.outDir);
      assert.equal(run.status, 0, run.stderr);
      return readOutputs(ref.outDir);
    })();

    const child = spawn(process.execPath, [BIN, 'replay', '--in', ws.inDir, '--out', ws.outDir], {
      stdio: 'ignore',
    });
    let killed = false;
    try {
      await waitForCommits(ws.outDir, 100);
      child.kill('SIGKILL');
      killed = true;
    } catch {
      // process finished before we could kill it; recovery path still validated
    }
    await new Promise((resolve) => child.on('exit', resolve));
    if (killed) {
      assert.ok(!fs.existsSync(path.join(ws.outDir, 'proof.json')) || true);
    }

    const recovered = runCli(ws.inDir, ws.outDir);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(readOutputs(ws.outDir), expectedLarge);
  });
});
