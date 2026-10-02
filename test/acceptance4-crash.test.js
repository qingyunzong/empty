import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { EventLog } from '../src/log.js';

const T1 = { id: 'T1', project: 'P1', volume: 30, priority: 0, segments: [{ temp: 37, duration: 5 }] };
const T2 = { id: 'T2', project: 'P1', volume: 30, priority: 0, segments: [{ temp: 37, duration: 5 }] };

test('acceptance 4: crash mid-write recovers without double charging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'labsched-'));
  const logPath = join(dir, 'run.log');
  const config = normalizeConfig({});

  const engine = new Engine(config, { logPath });
  assert.equal(engine.applyOp({ op: 'budget', project: 'P1', set: 100 }, 0), null);
  assert.equal(engine.applyOp({ op: 'enqueue', task: T1 }, 1), null);
  assert.equal(engine.applyOp({ op: 'enqueue', task: T2 }, 2), null);
  assert.equal(engine.projects.get('P1').budget, 40);

  // Simulate a crash that tears the final log line.
  truncateSync(logPath, statSync(logPath).size - 7);

  const recovered = Engine.recoverFile(config, logPath);
  assert.ok(recovered.appliedOps.has(0));
  assert.ok(recovered.appliedOps.has(1));
  assert.ok(!recovered.appliedOps.has(2), 'torn op is not considered applied');
  assert.equal(recovered.projects.get('P1').budget, 70, 'only the first charge survived');

  // Re-apply the remaining ops: the torn enqueue must be charged exactly once.
  assert.equal(recovered.applyOp({ op: 'enqueue', task: T2 }, 2), null);
  assert.equal(recovered.projects.get('P1').budget, 40, 'no double charge after recovery');

  const { log, discarded } = EventLog.recover(readFileSync(logPath, 'utf8'));
  assert.equal(discarded, 0, 'repaired log stays a valid chain after appends');
  assert.equal(log.root, recovered.log.root);
});

test('acceptance 4: recovery rejects corrupted chain entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'labsched-'));
  const logPath = join(dir, 'run.log');
  const config = normalizeConfig({});

  const engine = new Engine(config, { logPath });
  engine.applyOp({ op: 'budget', project: 'P1', set: 100 }, 0);
  engine.applyOp({ op: 'enqueue', task: T1 }, 1);

  // Tamper with the first op line: everything from there on must be discarded.
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l && JSON.parse(l).type === 'op');
  const first = JSON.parse(lines[idx]);
  first.data.op.set = 999;
  lines[idx] = JSON.stringify(first);
  const recovered = Engine.recover(config, lines.join('\n'));
  assert.equal(recovered.appliedOps.size, 0, 'corrupted prefix invalidates the chain');
  assert.equal(recovered.projects.has('P1'), false);
});
