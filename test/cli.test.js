import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../src/cli.js';

function run(args) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
  });
  return { code, json: stdout ? JSON.parse(stdout) : null, stderr };
}

const input = {
  config: {
    capacity: 6, runTime: 4, cleanTime: 1, dayLength: 24,
    compensationSlots: 3, agingRate: 1, supportedGroups: ['A'],
    recipes: { R1: { group: 'A', dailyQuota: 100 } },
  },
  orders: [
    { id: 'N1', recipe: 'R1', batches: 2, batchSize: 3, due: 100 },
    { id: 'N2', recipe: 'R1', batches: 2, batchSize: 3, due: 100 },
  ],
};

describe('CLI end-to-end', () => {
  it('plan writes state, replan applies events and reports a diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
    const inputPath = join(dir, 'input.json');
    const eventsPath = join(dir, 'events.json');
    const statePath = join(dir, 'state.json');
    writeFileSync(inputPath, JSON.stringify(input));
    writeFileSync(eventsPath, JSON.stringify({
      now: 4,
      freezeHorizon: 4,
      add: [{ id: 'U1', recipe: 'R1', batches: 2, batchSize: 3, due: 6, priority: 'urgent' }],
    }));

    const planned = run(['plan', inputPath, '--state', statePath]);
    assert.equal(planned.code, 0);
    assert.equal(planned.json.ok, true);
    assert.equal(planned.json.runs.length, 2);

    const replanned = run(['replan', eventsPath, '--state', statePath]);
    assert.equal(replanned.code, 0);
    assert.equal(replanned.json.ok, true);
    assert.equal(replanned.json.revision, 2);
    assert.deepEqual(replanned.json.freezeBoundary, { time: 4, frozenRuns: [1] });
    assert.equal(replanned.json.runs[1].loads[0].order, 'U1');
    assert.deepEqual(replanned.json.diff.removedRuns, [2]);

    // State file persisted and reflects the second revision.
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.revision, 2);
    assert.equal(state.runs.length, 3);
  });

  it('exits with code 2 on infeasible input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify({
      config: input.config,
      orders: [{ id: 'BIG', recipe: 'R1', batches: 1, batchSize: 99, due: 1 }],
    }));
    const result = run(['plan', badPath]);
    assert.equal(result.code, 2);
    assert.equal(result.json.ok, false);
    assert.match(result.json.errors[0], /exceeds furnace capacity/);
  });

  it('verify compares greedy against exhaustive enumeration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'furnace-'));
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify(input));
    const result = run(['verify', inputPath]);
    assert.equal(result.code, 0);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.greedy.total, result.json.enumerated.total);
  });

  it('rejects bad usage with exit code 1', () => {
    const result = run(['frobnicate']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /usage:/);
  });
});
