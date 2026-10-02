'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChainBuilder } = require('../src/chain');
const { parseFrames } = require('../src/events');

function ev(type, job, leg, seq, ts, causes = []) {
  return { type, job, leg, seq, ts, causes };
}

test('fragmented frames are reassembled into whole events', () => {
  const text =
    '{"type":"ASSIGN","job":"a",\n"leg":0,"seq":1,\n"causes":[],"ts":1}\n' +
    '{"type":"PICK","job":"a","leg":0,"seq":2,"causes":[],"ts":2}\n';
  const events = parseFrames(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].job, 'a');
  assert.throws(() => parseFrames('{"type":"PICK"'), /unterminated/);
});

test('acceptance 1: duplicates + out-of-order input rebuild the reference chain', () => {
  const reference = [
    ev('ASSIGN', 'A', 0, 1, 100),
    ev('PICK', 'A', 0, 2, 200),
    ev('DROP', 'A', 0, 3, 300),
    ev('ASSIGN', 'B', 0, 1, 400, [{ job: 'A', leg: 0 }]),
    ev('PICK', 'B', 0, 2, 500),
    ev('FAIL', 'B', 0, 3, 600, ['A:0']),
    ev('RETRY', 'B', 1, 4, 700),
    ev('PICK', 'B', 1, 5, 800),
    ev('DROP', 'B', 1, 6, 900),
  ];
  const messy = [
    reference[5], reference[2], reference[0], reference[8], reference[4],
    reference[1], reference[7], reference[3], reference[6],
    reference[5], reference[0], reference[8], // duplicates
  ];
  const b1 = new ChainBuilder();
  b1.ingestAll(reference);
  const b2 = new ChainBuilder();
  b2.ingestAll(messy);
  assert.equal(b2.duplicates, 3);
  const c1 = b1.certificate();
  const c2 = b2.certificate();
  assert.equal(c1.chainHash, c2.chainHash);
  assert.equal(c1.legCount, 3);
  assert.deepEqual(c1.rootCauses, []); // B's FAIL was retried and the retry dropped
});

test('acceptance 2: stale pick falsified by late DROP, certificate updates incrementally', () => {
  const b = new ChainBuilder({ timeout: 1000 });
  b.ingestAll([
    ev('ASSIGN', 'A', 0, 1, 0),
    ev('PICK', 'A', 0, 2, 100),
    ev('ASSIGN', 'B', 0, 1, 2000), // advances the virtual clock past 100 + 1000
  ]);
  const c1 = b.certificate();
  assert.equal(c1.staleLog.length, 1);
  assert.equal(c1.staleLog[0].revoked, false);
  assert.equal(c1.staleLog[0].markedAt, 1100);

  b.ingest(ev('DROP', 'A', 0, 3, 1500)); // late DROP falsifies the stale mark
  const c2 = b.certificate();
  assert.equal(c2.staleLog.length, 1); // log retained, not deleted
  assert.equal(c2.staleLog[0].revoked, true);
  assert.equal(c2.staleLog[0].revokedAt, 1500);
  assert.equal(c2.staleLog[0].dropSeq, 3);
  assert.notEqual(c1.chainHash, c2.chainHash); // certificate reflects the update
});

test('stale pick without any DROP stays marked', () => {
  const b = new ChainBuilder({ timeout: 500 });
  b.ingestAll([
    ev('PICK', 'A', 0, 1, 0),
    ev('ASSIGN', 'B', 0, 1, 1000),
  ]);
  const cert = b.certificate();
  assert.equal(cert.staleLog.length, 1);
  assert.equal(cert.staleLog[0].revoked, false);
});

test('acceptance 3: RETRY not following a FAIL is rejected with exit code 15', () => {
  const b = new ChainBuilder();
  b.ingestAll([
    ev('ASSIGN', 'A', 0, 1, 0),
    ev('PICK', 'A', 0, 2, 10),
    ev('RETRY', 'A', 1, 3, 20),
  ]);
  assert.throws(() => b.build(), (err) => err.exitCode === 15 && err.code === 'ERR_ILLEGAL_RETRY');
});

test('RETRY reusing an old leg is rejected', () => {
  const b = new ChainBuilder();
  b.ingestAll([
    ev('ASSIGN', 'A', 0, 1, 0),
    ev('FAIL', 'A', 0, 2, 10),
    ev('RETRY', 'A', 0, 3, 20),
  ]);
  assert.throws(() => b.build(), (err) => err.exitCode === 15);
});

test('event after FAIL in the same leg is rejected (old leg immutable)', () => {
  const b = new ChainBuilder();
  b.ingestAll([
    ev('ASSIGN', 'A', 0, 1, 0),
    ev('FAIL', 'A', 0, 2, 10),
    ev('DROP', 'A', 0, 3, 20),
  ]);
  assert.throws(() => b.build(), (err) => err.exitCode === 15 && err.code === 'ERR_LEG_MODIFICATION');
});

test('causes cycle rejects the whole batch with exit code 14', () => {
  const b = new ChainBuilder();
  b.ingestAll([
    ev('ASSIGN', 'A', 0, 1, 0, [{ job: 'B', leg: 0 }]),
    ev('ASSIGN', 'B', 0, 1, 0, [{ job: 'A', leg: 0 }]),
  ]);
  assert.throws(() => b.build(), (err) => err.exitCode === 14 && err.code === 'ERR_CAUSES_CYCLE');
});

test('acceptance 4: root causes match brute-force reference over enumerated cause graphs', () => {
  const jobNames = ['J0', 'J1', 'J2'];

  // Independent reference implementation used only for cross-checking.
  function referenceRootCauses(jobs, edges) {
    const uncompensated = [];
    for (const job of jobs) {
      const success = job.legs[job.legs.length - 1].hasDrop;
      job.legs.forEach((leg, i) => {
        if (!leg.fail) return;
        const retried = job.legs.slice(i + 1).some((l) => l.hasRetry);
        if (!(success && retried)) uncompensated.push(job.name + '#' + i);
      });
    }
    const preds = {};
    for (const job of jobs) job.legs.forEach((_, i) => { preds[job.name + '#' + i] = []; });
    for (const [a, b] of edges) preds[b].push(a);
    return uncompensated.filter((start) => {
      const seen = new Set();
      const stack = [...preds[start]];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        if (uncompensated.includes(n)) return false;
        stack.push(...preds[n]);
      }
      return true;
    }).sort();
  }

  let checked = 0;
  for (let failMask = 0; failMask < 64; failMask++) {
    for (let causeMask1 = 0; causeMask1 < 4; causeMask1++) {
      for (let causeMask2 = 0; causeMask2 < 16; causeMask2++) {
        const events = [];
        const jobs = [];
        const edges = [];
        jobNames.forEach((name, ji) => {
          const f0 = !!(failMask & (1 << (ji * 2)));
          const f1 = !!(failMask & (1 << (ji * 2 + 1)));
          const legs = [{ fail: f0, hasRetry: false, hasDrop: !f0 }];
          if (f0) legs.push({ fail: f1, hasRetry: true, hasDrop: !f1 });
          jobs.push({ name, legs });
          for (let i = 1; i < legs.length; i++) edges.push([name + '#' + (i - 1), name + '#' + i]);
        });
        const causesFor = (ji) => {
          if (ji === 0) return [];
          const candidates = [];
          for (let pj = 0; pj < ji; pj++) {
            jobs[pj].legs.forEach((_, li) => candidates.push({ job: jobNames[pj], leg: li }));
          }
          const mask = ji === 1 ? causeMask1 : causeMask2;
          return candidates.filter((_, ci) => mask & (1 << ci));
        };
        jobNames.forEach((name, ji) => {
          const causes = causesFor(ji);
          for (const c of causes) edges.push([c.job + '#' + c.leg, name + '#0']);
          const base = ji * 1000;
          events.push(ev('ASSIGN', name, 0, 1, base + 1, causes));
          events.push(ev('PICK', name, 0, 2, base + 2));
          const legs = jobs[ji].legs;
          if (legs[0].fail) {
            events.push(ev('FAIL', name, 0, 3, base + 3));
            events.push(ev('RETRY', name, 1, 4, base + 4));
            events.push(ev('PICK', name, 1, 5, base + 5));
            if (legs[1].hasDrop) events.push(ev('DROP', name, 1, 6, base + 6));
            else events.push(ev('FAIL', name, 1, 6, base + 6));
          } else {
            events.push(ev('DROP', name, 0, 3, base + 3));
          }
        });
        const builder = new ChainBuilder();
        builder.ingestAll(events);
        const got = builder.certificate().rootCauses.map((r) => r.job + '#' + r.leg).sort();
        assert.deepEqual(got, referenceRootCauses(jobs, edges),
          'mismatch for mask ' + failMask + '/' + causeMask1 + '/' + causeMask2);
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, 'enumeration should cover many graphs, got ' + checked);
});
