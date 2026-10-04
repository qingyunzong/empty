'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Store } = require('../src/store');
const { decodeSegment } = require('../src/segment');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
}

// NOTE: this sandbox loses piped child stdout, so capture via temp files.
function runCli(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cli-io-'));
  const outFile = path.join(dir, 'out');
  const errFile = path.join(dir, 'err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, ...env },
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Brute-force reference: independent naive implementation over raw events.
// events: [{ ts, device, seq, tokens, deleted }]
// Positions are cumulative per device over ALL events (deleted ones keep
// occupying their positions but break runs).
// ---------------------------------------------------------------------------
function bruteRuns(events) {
  const byDevice = new Map();
  for (const ev of events) {
    if (!byDevice.has(ev.device)) byDevice.set(ev.device, []);
    byDevice.get(ev.device).push(ev);
  }
  const runs = [];
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    let pos = 0;
    let run = null;
    for (const ev of list) {
      if (ev.deleted) {
        run = null;
      } else {
        if (!run) {
          run = { device, tokens: [], positions: [], events: [] };
          runs.push(run);
        }
        for (const tok of ev.tokens) {
          run.tokens.push(tok);
          run.positions.push(pos);
          run.events.push({ ts: ev.ts, seq: ev.seq });
          pos++;
        }
      }
      if (ev.deleted) pos += ev.tokens.length;
    }
  }
  return runs;
}

const keyOf = (m) => `${m.device}|${m.ts}|${m.seq}|${m.pos}`;

function brutePhrase(events, phrase) {
  const out = [];
  for (const run of bruteRuns(events)) {
    for (let i = 0; i + phrase.length <= run.tokens.length; i++) {
      if (phrase.every((t, j) => run.tokens[i + j] === t)) {
        const ev = run.events[i];
        out.push(keyOf({ device: run.device, ts: ev.ts, seq: ev.seq, pos: run.positions[i] }));
      }
    }
  }
  return out.sort();
}

function bruteNear(events, a, b, k) {
  const out = new Set();
  for (const run of bruteRuns(events)) {
    for (let i = 0; i < run.tokens.length; i++) {
      if (run.tokens[i] !== a) continue;
      for (let j = 0; j < run.tokens.length; j++) {
        if (run.tokens[j] !== b || i === j) continue;
        if (Math.abs(run.positions[i] - run.positions[j]) > k) continue;
        const start = Math.min(i, j);
        const ev = run.events[start];
        out.add(keyOf({ device: run.device, ts: ev.ts, seq: ev.seq, pos: run.positions[start] }));
      }
    }
  }
  return [...out].sort();
}

function storeKeys(matches) {
  return matches.map(keyOf).sort();
}

// ---------------------------------------------------------------------------
// Acceptance 1: enumerate small event streams x all freeze-window patterns,
// compare phrase & near (incl. cross-segment) against brute force.
// ---------------------------------------------------------------------------
test('acceptance 1: exhaustive small streams, all window patterns, cross-segment near', { timeout: 300000 }, () => {
  const tokenOptions = [['a'], ['b'], ['a', 'b'], ['b', 'a'], ['a', 'a'], ['b', 'b']];
  const patterns = ['none', 'all', 'each', 'split'];
  const phrases = [];
  for (const len of [1, 2, 3]) {
    const build = (prefix, n) => {
      if (n === 0) {
        phrases.push(prefix);
        return;
      }
      build([...prefix, 'a'], n - 1);
      build([...prefix, 'b'], n - 1);
    };
    build([], len);
  }
  const nearQueries = [];
  for (const [x, y] of [['a', 'b'], ['b', 'a'], ['a', 'a'], ['b', 'b']]) {
    for (const k of [1, 2, 3]) nearQueries.push([x, y, k]);
  }

  let checked = 0;
  for (const s1 of tokenOptions) {
    for (const s2 of tokenOptions) {
      for (const s3 of tokenOptions) {
        const stream = [s1, s2, s3];
        const rawEvents = stream.map((tokens, i) => ({
          ts: 1000 + i,
          device: 'dev1',
          seq: i,
          tokens,
          deleted: false,
        }));
        for (const pattern of patterns) {
          const dir = tmpdir();
          const store = new Store(dir);
          stream.forEach((tokens, i) => {
            store.append({ device: 'dev1', ts: 1000 + i, text: tokens.join(' ') });
            if (pattern === 'each' || (pattern === 'split' && i === 0)) store.freeze();
          });
          if (pattern === 'all') store.freeze();

          for (const phrase of phrases) {
            assert.deepEqual(
              storeKeys(store.query({ phrase: phrase.join(' ') })),
              brutePhrase(rawEvents, phrase),
              `phrase [${phrase}] stream=${JSON.stringify(stream)} pattern=${pattern}`,
            );
            checked++;
          }
          for (const [x, y, k] of nearQueries) {
            assert.deepEqual(
              storeKeys(store.query({ near: { a: x, b: y, k } })),
              bruteNear(rawEvents, x, y, k),
              `near ${x}~${y} k=${k} stream=${JSON.stringify(stream)} pattern=${pattern}`,
            );
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 0);
  process.stderr.write(`  (acceptance 1: ${checked} query comparisons passed)\n`);
});

// ---------------------------------------------------------------------------
// Acceptance 2: kill mid-merge -> old window still usable.
// ---------------------------------------------------------------------------
test('acceptance 2: merge killed mid-way leaves old window intact', () => {
  const dir = tmpdir();
  const arch = path.join(dir, 'a');
  // Three frozen segments: ts 100..200, 300..400, 500..600.
  for (const [ts, text] of [
    [100, 'alpha one'],
    [200, 'beta two'],
    [300, 'gamma three'],
    [400, 'delta four'],
    [500, 'epsilon five'],
    [600, 'zeta six'],
  ]) {
    const r = runCli(['append', '--archive', arch, '--device', 'dev1', '--ts', String(ts), '--text', text]);
    assert.equal(r.status, 0, r.stderr);
    if (ts === 200 || ts === 400 || ts === 600) {
      const f = runCli(['freeze', '--archive', arch]);
      assert.equal(f.status, 0, f.stderr);
    }
  }
  const before = JSON.parse(runCli(['query', '--archive', arch, '--phrase', 'beta two']).stdout);
  assert.equal(before.length, 1);

  // Kill the merge after staging, before the atomic commit.
  const killed = runCli(
    ['merge', '--archive', arch, '--from', '100', '--to', '400'],
    { ARCHIVE_TEST_KILL: 'after-stage' },
  );
  assert.notEqual(killed.status, 0, 'killed merge must exit non-zero');

  // Old window fully usable: same segments, same query results.
  const stats = JSON.parse(runCli(['stats', '--archive', arch]).stdout);
  assert.deepEqual(
    stats.segments.map((s) => [s.from, s.to]),
    [
      [100, 200],
      [300, 400],
      [500, 600],
    ],
  );
  assert.deepEqual(JSON.parse(runCli(['query', '--archive', arch, '--phrase', 'beta two']).stdout), before);
  const near = JSON.parse(runCli(['query', '--archive', arch, '--near', 'alpha', 'zeta', '--k', '20']).stdout);
  assert.equal(near.length, 1, 'cross-segment near still works after failed merge');

  // A real merge now succeeds and preserves query results.
  const merged = runCli(['merge', '--archive', arch, '--from', '100', '--to', '400']);
  assert.equal(merged.status, 0, merged.stderr);
  const stats2 = JSON.parse(runCli(['stats', '--archive', arch]).stdout);
  assert.equal(stats2.segments.length, 2);
  assert.deepEqual(JSON.parse(runCli(['query', '--archive', arch, '--phrase', 'beta two']).stdout), before);
  const near2 = JSON.parse(runCli(['query', '--archive', arch, '--near', 'alpha', 'zeta', '--k', '20']).stdout);
  assert.deepEqual(near2, near, 'merge must not change query results');

  // Invalid windows are rejected with E_WINDOW.
  const bad = runCli(['merge', '--archive', arch, '--from', '150', '--to', '250']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^E_WINDOW/);
});

// ---------------------------------------------------------------------------
// Acceptance 3: retain boundary -- equal kept once, equal removed once.
// ---------------------------------------------------------------------------
test('acceptance 3: retain boundary equality (kept with --before, removed with --until)', () => {
  const build = () => {
    const arch = path.join(tmpdir(), 'a');
    for (const [ts, tok] of [[100, 'tok100'], [200, 'tok200'], [300, 'tok300']]) {
      const r = runCli(['append', '--archive', arch, '--device', 'dev1', '--ts', String(ts), '--text', tok]);
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(runCli(['freeze', '--archive', arch]).status, 0);
    return arch;
  };
  const hits = (arch, phrase) =>
    JSON.parse(runCli(['query', '--archive', arch, '--phrase', phrase]).stdout).length;

  // --before 200: strictly-older deleted, ts == 200 KEPT.
  const a1 = build();
  const r1 = runCli(['retain', '--archive', a1, '--before', '200']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(hits(a1, 'tok100'), 0, 'ts=100 must be tombstoned');
  assert.equal(hits(a1, 'tok200'), 1, 'ts == before boundary must be kept');
  assert.equal(hits(a1, 'tok300'), 1);

  // --until 200: ts == 200 REMOVED (inclusive).
  const a2 = build();
  const r2 = runCli(['retain', '--archive', a2, '--until', '200']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(hits(a2, 'tok100'), 0);
  assert.equal(hits(a2, 'tok200'), 0, 'ts == until boundary must be removed');
  assert.equal(hits(a2, 'tok300'), 1, 'ts=300 must be kept');

  // Tombstones recorded; invalid retain rejected with E_RETAIN.
  const stats = JSON.parse(runCli(['stats', '--archive', a2]).stdout);
  assert.deepEqual(stats.tombstones, [{ until: 200 }]);
  const bad = runCli(['retain', '--archive', a2, '--before', '1', '--until', '2']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^E_RETAIN/);
});

// ---------------------------------------------------------------------------
// Acceptance 4: shared dictionary update keeps old frozen segments decodable.
// ---------------------------------------------------------------------------
test('acceptance 4: dictionary grows, old frozen segments still decode', () => {
  const dir = tmpdir();
  const store = new Store(dir);
  store.append({ device: 'dev1', ts: 1, text: 'alpha beta' });
  store.freeze(); // dict v1: alpha, beta
  store.append({ device: 'dev1', ts: 2, text: 'gamma delta' });
  store.freeze(); // dict v2: + gamma, delta

  const stats = store.stats();
  assert.equal(stats.dict.version, 2);
  assert.equal(stats.dict.terms, 4);

  // Old segment file decodes against the *current* (grown) dictionary.
  const seg1 = JSON.parse(fs.readFileSync(path.join(dir, 'segments', 'seg-0001.json'), 'utf8'));
  const seg2 = JSON.parse(fs.readFileSync(path.join(dir, 'segments', 'seg-0002.json'), 'utf8'));
  assert.equal(seg1.dictVersion, 1);
  assert.equal(seg2.dictVersion, 2);
  const fresh = new Store(dir);
  const events1 = decodeSegment(seg1, fresh.dict.terms);
  assert.deepEqual(
    events1.map((e) => e.tokens),
    [['alpha', 'beta']],
  );
  const events2 = decodeSegment(seg2, fresh.dict.terms);
  assert.deepEqual(
    events2.map((e) => e.tokens),
    [['gamma', 'delta']],
  );

  // Cross-segment phrase spanning the dict-version boundary still hits.
  const cross = fresh.query({ phrase: 'beta gamma' });
  assert.equal(cross.length, 1);
  assert.deepEqual(
    cross.map((m) => [m.device, m.ts, m.seq, m.pos]),
    [['dev1', 1, 0, 1]],
  );
});
