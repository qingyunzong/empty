'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Processor, RetryError } = require('../src/processor');

function ev(type, job, leg, seq, causes, ts) {
  return { type, job, leg, seq, causes, ts };
}

// Deterministic shuffle so tests are reproducible.
function shuffled(arr, seed) {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('acceptance 1: duplicates + out-of-order yield the reference chain', () => {
  const ordered = [
    ev('ASSIGN', 'jobA', 'L1', 0, [], 100),
    ev('PICK', 'jobA', 'L1', 1, [], 110),
    ev('DROP', 'jobA', 'L1', 2, [], 120),
    ev('ASSIGN', 'jobB', 'L1', 0, ['jobA'], 130),
    ev('PICK', 'jobB', 'L1', 1, ['jobA'], 140),
    ev('FAIL', 'jobB', 'L1', 2, ['jobA'], 150),
    ev('RETRY', 'jobB', 'L2', 3, ['jobA'], 160),
    ev('PICK', 'jobB', 'L2', 4, ['jobA'], 170),
    ev('DROP', 'jobB', 'L2', 5, ['jobA'], 180),
  ];

  const reference = new Processor({ timeoutMs: 10000 });
  for (const e of ordered) reference.ingest(e);
  const ref = reference.finalize();

  // Scramble order and inject duplicates of every event.
  const noisy = [];
  for (const e of shuffled(ordered, 42)) {
    noisy.push(e, { ...e }); // exact duplicate
  }
  const scrambled = shuffled(noisy, 7);

  const proc = new Processor({ timeoutMs: 10000 });
  for (const e of scrambled) proc.ingest(e);
  const out = proc.finalize();

  assert.equal(proc.duplicates, ordered.length);
  assert.deepEqual(out.chain, ref.chain);
  assert.equal(out.chainHash, ref.chainHash);
  assert.deepEqual(out.rootCauses, ref.rootCauses);
  // The FAIL on jobB/L1 was compensated by RETRY -> L2 -> DROP.
  assert.deepEqual(out.uncompensatedFails, []);
  assert.deepEqual(out.rootCauses, []);
});

test('acceptance 2: stale PICK is refuted by later DROP; certificate updates incrementally', () => {
  const proc = new Processor({ timeoutMs: 100 });
  proc.ingest(ev('ASSIGN', 'jobA', 'L1', 0, [], 0));
  proc.ingest(ev('PICK', 'jobA', 'L1', 1, [], 10));

  let cert = proc.getCertificate();
  assert.equal(cert.staleLog.length, 0, 'no stale before clock passes timeout');

  // Virtual clock advances past the timeout via an unrelated event.
  proc.ingest(ev('ASSIGN', 'jobB', 'L1', 0, [], 500));
  cert = proc.getCertificate();
  assert.equal(cert.staleLog.length, 1, 'PICK timed out and was marked stale');
  assert.equal(cert.staleLog[0].revoked, false);
  const hashWhenStale = cert.chainHash;
  const staleMark = { ...cert.staleLog[0] };

  // Late DROP refutes the stale mark; the log keeps both the mark and the revocation.
  proc.ingest(ev('DROP', 'jobA', 'L1', 2, [], 600));
  cert = proc.getCertificate();
  assert.equal(cert.staleLog.length, 1, 'log retains the stale record');
  assert.equal(cert.staleLog[0].revoked, true, 'stale mark revoked by DROP');
  assert.equal(cert.staleLog[0].markedAt, staleMark.markedAt, 'original mark preserved');
  assert.equal(cert.staleLog[0].revokedAt, 600);
  assert.equal(cert.legs.find((l) => l.job === 'jobA').status, 'dropped');
  assert.notEqual(cert.chainHash, hashWhenStale, 'certificate chain hash updated incrementally');
});

test('acceptance 3: RETRY after a non-FAIL event is rejected', () => {
  const proc = new Processor();
  proc.ingest(ev('ASSIGN', 'jobA', 'L1', 0, [], 0));
  proc.ingest(ev('PICK', 'jobA', 'L1', 1, [], 10));
  proc.ingest(ev('RETRY', 'jobA', 'L2', 2, [], 20)); // previous event is PICK, not FAIL
  assert.throws(() => proc.finalize(), RetryError);
});

test('RETRY may not reuse an existing leg (old legs are immutable)', () => {
  const proc = new Processor();
  proc.ingest(ev('ASSIGN', 'jobA', 'L1', 0, [], 0));
  proc.ingest(ev('FAIL', 'jobA', 'L1', 1, [], 10));
  proc.ingest(ev('RETRY', 'jobA', 'L1', 2, [], 20)); // reuses leg L1
  assert.throws(() => proc.finalize(), /leg L1 already exists/);
});

test('RETRY immediately after FAIL with a fresh leg is legal', () => {
  const proc = new Processor();
  proc.ingest(ev('ASSIGN', 'jobA', 'L1', 0, [], 0));
  proc.ingest(ev('FAIL', 'jobA', 'L1', 1, [], 10));
  proc.ingest(ev('RETRY', 'jobA', 'L2', 2, [], 20));
  proc.ingest(ev('DROP', 'jobA', 'L2', 3, [], 30));
  const out = proc.finalize();
  assert.deepEqual(out.uncompensatedFails, []);
});

test('acceptance 4: root-cause analysis matches brute force over enumerated causes graphs', () => {
  const jobs = ['J0', 'J1', 'J2'];

  // Brute-force reference: transitive ancestors via DFS, then filter.
  function bruteForceRoots(edges, fails) {
    const ancestors = (job) => {
      const seen = new Set();
      const stack = [...(edges[job] || [])];
      while (stack.length) {
        const n = stack.pop();
        if (seen.has(n)) continue;
        seen.add(n);
        for (const m of edges[n] || []) stack.push(m);
      }
      return seen;
    };
    return fails.filter((f) => {
      const anc = ancestors(f.job);
      return !fails.some((g) => g !== f && g.ts <= f.ts && anc.has(g.job));
    }).map((f) => ({ job: f.job, seq: f.seq, ts: f.ts }))
      .sort((a, b) => (a.ts - b.ts) || a.job.localeCompare(b.job));
  }

  const perms = [
    ['J0', 'J1', 'J2'], ['J0', 'J2', 'J1'], ['J1', 'J0', 'J2'],
    ['J1', 'J2', 'J0'], ['J2', 'J0', 'J1'], ['J2', 'J1', 'J0'],
  ];

  let cases = 0;
  for (const rank of perms) {
    // Edges only from earlier rank to later rank => guaranteed acyclic.
    const pairs = [];
    for (let i = 0; i < rank.length; i++) {
      for (let j = i + 1; j < rank.length; j++) pairs.push([rank[i], rank[j]]);
    }
    for (let mask = 0; mask < (1 << pairs.length); mask++) {
      const edges = { J0: [], J1: [], J2: [] };
      pairs.forEach(([a, b], k) => { if (mask & (1 << k)) edges[a].push(b); });
      for (let failMask = 0; failMask < 8; failMask++) {
        const events = [];
        const fails = [];
        jobs.forEach((job, idx) => {
          events.push(ev('ASSIGN', job, 'L1', 0, edges[job], idx * 10));
          if (failMask & (1 << idx)) {
            const ts = 100 + idx * 10;
            events.push(ev('FAIL', job, 'L1', 1, edges[job], ts));
            fails.push({ job, seq: 1, ts });
          }
        });
        const proc = new Processor();
        for (const e of shuffled(events, 13)) proc.ingest(e);
        const got = proc.finalize().rootCauses;
        const want = bruteForceRoots(edges, fails);
        assert.deepEqual(got, want, `rank=${rank} mask=${mask} failMask=${failMask}`);
        cases++;
      }
    }
  }
  assert.ok(cases >= 300, `enumerated ${cases} small causes configurations`);
});

test('equal-ts upstream FAIL explains a downstream FAIL', () => {
  const proc = new Processor();
  proc.ingest(ev('FAIL', 'up', 'L1', 0, [], 50));
  proc.ingest(ev('FAIL', 'down', 'L1', 0, ['up'], 50));
  const out = proc.finalize();
  assert.deepEqual(out.rootCauses, [{ job: 'up', seq: 0, ts: 50 }]);
});

test('uncompensated FAIL followed by a failed RETRY stays a root cause', () => {
  const proc = new Processor();
  proc.ingest(ev('ASSIGN', 'jobA', 'L1', 0, [], 0));
  proc.ingest(ev('FAIL', 'jobA', 'L1', 1, [], 10));
  proc.ingest(ev('RETRY', 'jobA', 'L2', 2, [], 20));
  proc.ingest(ev('FAIL', 'jobA', 'L2', 3, [], 30));
  const out = proc.finalize();
  assert.equal(out.uncompensatedFails.length, 2);
  assert.deepEqual(out.rootCauses.map((r) => r.seq), [1, 3]);
});
