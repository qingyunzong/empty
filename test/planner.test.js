import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as runCli } from '../cli.js';
import {
  Planner,
  PlannerError,
  linearScan,
  MAX_ENUM,
  MAX_K,
  E_LIMIT,
  E_TIE,
  E_STATE,
} from '../src/planner.js';

const DESC = '低温 固化 工艺 使用 MAT1 与 设备 EQ1 完成 作业';

function makeJob(id, overrides = {}) {
  return {
    id,
    description: DESC,
    material: 'MAT1',
    equipment: 'EQ1',
    cost: 5,
    overdue: 0,
    ...overrides,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference: recursively enumerates every subset of size 1..k.
function bruteForce(eligible, k, budget) {
  const n = eligible.length;
  let best = null;
  const ties = [];
  function visit(start, size, cost, score, ids) {
    if (size > 0 && size <= k && cost <= budget) {
      const remaining = budget - cost;
      const key = { score, cost, remaining };
      if (!best || score > best.score || (score === best.score && remaining > best.remaining)) {
        best = key;
        ties.length = 0;
        ties.push([...ids].sort());
      } else if (score === best.score && remaining === best.remaining) {
        ties.push([...ids].sort());
      }
    }
    if (size === k) return;
    for (let i = start; i < n; i += 1) {
      ids.push(eligible[i].id);
      visit(i + 1, size + 1, cost + eligible[i].cost, score + eligible[i].score, ids);
      ids.pop();
    }
  }
  visit(0, 0, 0, 0, []);
  if (!best) return null;
  ties.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  });
  return { best, ties };
}

test('acceptance 1: top-k and ties match exhaustive subset enumeration', () => {
  const rand = mulberry32(20261002);
  const pool = ['低温', '固化', 'MAT1', 'EQ1', 'noise', 'alpha', 'beta'];
  for (let round = 0; round < 30; round += 1) {
    const planner = new Planner();
    const count = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
      const len = 5 + Math.floor(rand() * 8);
      const tokens = [];
      for (let j = 0; j < len; j += 1) tokens.push(pool[Math.floor(rand() * pool.length)]);
      if (rand() < 0.6) tokens.push('低温', '固化');
      if (rand() < 0.7) tokens.push('MAT1');
      if (rand() < 0.7) tokens.push('EQ1');
      planner.addJob({
        id: `J${i}`,
        description: tokens.join(' '),
        material: 'MAT1',
        equipment: 'EQ1',
        cost: 1 + Math.floor(rand() * 9),
        overdue: Math.floor(rand() * 6),
      });
    }
    if (rand() < 0.3) planner.voidJob(`J${Math.floor(rand() * count)}`);
    const k = 1 + Math.floor(rand() * 3);
    const budget = 5 + Math.floor(rand() * 15);

    // Index recall: every scan-passing, non-voided job must be an index candidate.
    const indexIds = new Set(planner.indexCandidates('MAT1', 'EQ1'));
    const eligible = [];
    for (const [id, job] of planner.jobs) {
      const scan = linearScan(job.description, 'MAT1', 'EQ1');
      if (scan.match) {
        assert.ok(indexIds.has(id), `index missed scan-passing job ${id}`);
        if (!job.voided) {
          eligible.push({ id, cost: job.cost, score: scan.hits * 10 - job.overdue });
        }
      }
    }

    const expected = bruteForce(eligible, k, budget);
    const actual = planner.select({ material: 'MAT1', equipment: 'EQ1', k, budget });
    if (eligible.length === 0) {
      assert.equal(actual.status, 'EMPTY');
      continue;
    }
    if (!expected) {
      assert.equal(actual.status, 'OVER_BUDGET');
      continue;
    }
    assert.equal(actual.status, 'OK');
    assert.deepEqual(actual.best, expected.best, `round ${round} best mismatch`);
    assert.deepEqual(
      actual.results.map((r) => r.jobs),
      expected.ties,
      `round ${round} ties mismatch`,
    );
  }
});

test('acceptance 2: budget off-by-one boundary', () => {
  const planner = new Planner();
  planner.addJob(makeJob('A', { cost: 5, overdue: 0 }));
  // B scores higher (extra phrase occurrence -> more hits) but costs 6.
  planner.addJob(makeJob('B', { cost: 6, overdue: 0, description: `${DESC} 低温 固化` }));

  // cost == budget is feasible; budget - 1 below the cheapest job is not.
  assert.equal(planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 5 }).status, 'OK');
  assert.equal(planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 4 }).status, 'OVER_BUDGET');

  // Pair costs 5 + 6 = 11: budget 10 rejects the pair, budget 11 accepts it.
  const at10 = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 2, budget: 10 });
  assert.equal(at10.status, 'OK');
  assert.deepEqual(at10.results.map((r) => r.jobs), [['B']]);
  const at11 = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 2, budget: 11 });
  assert.deepEqual(at11.results.map((r) => r.jobs), [['A', 'B']]);
  assert.equal(at11.best.remaining, 0);
});

test('acceptance 3: void excludes immediately, restore recovers, explain cites index/scan', () => {
  const planner = new Planner();
  planner.addJob(makeJob('A', { cost: 5 }));
  planner.addJob(makeJob('B', { cost: 5, overdue: 3 }));

  planner.voidJob('A');
  const afterVoid = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 2, budget: 10 });
  assert.deepEqual(afterVoid.results.map((r) => r.jobs), [['B']]);

  const voidedExplain = planner.explain('A', { material: 'MAT1', equipment: 'EQ1' });
  assert.equal(voidedExplain.decision, 'excluded-voided');
  assert.equal(voidedExplain.sources.invertedIndex.matched, true);
  assert.equal(voidedExplain.sources.linearScan.match, true);
  assert.deepEqual(
    voidedExplain.audit.map((e) => e.action),
    ['add', 'void'],
  );

  planner.restoreJob('A');
  const afterRestore = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 2, budget: 10 });
  assert.deepEqual(afterRestore.results.map((r) => r.jobs), [['A', 'B']]);

  const explain = planner.explain('A', { material: 'MAT1', equipment: 'EQ1' });
  assert.equal(explain.decision, 'eligible');
  assert.equal(explain.sources.invertedIndex.matched, true);
  assert.ok(explain.sources.invertedIndex.candidateIds.includes('A'));
  assert.equal(explain.sources.linearScan.phraseOk, true);
  assert.equal(explain.sources.linearScan.proximityOk, true);
  assert.deepEqual(
    explain.audit.map((e) => e.action),
    ['add', 'void', 'restore'],
  );
});

test('acceptance 4: EMPTY and OVER_BUDGET are distinct statuses', () => {
  const planner = new Planner();
  planner.addJob(makeJob('NOMATCH', { description: '普通 固化 工艺 MAT1 EQ1' }));
  const empty = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 100 });
  assert.equal(empty.status, 'EMPTY');
  assert.deepEqual(empty.results, []);

  planner.addJob(makeJob('PRICEY', { id: 'PRICEY', cost: 10 }));
  const over = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 9 });
  assert.equal(over.status, 'OVER_BUDGET');
  assert.deepEqual(over.eligible, ['PRICEY']);
});

test('proximity filter: material/equipment codes must be within 6 words', () => {
  const close = '低温 固化 MAT1 a b c d e f EQ1 tail';
  const far = '低温 固化 MAT1 a b c d e f g EQ1 tail';
  assert.equal(linearScan(close, 'MAT1', 'EQ1').match, true);
  assert.equal(linearScan(close, 'MAT1', 'EQ1').minGap, 6);
  assert.equal(linearScan(far, 'MAT1', 'EQ1').match, false);
  assert.equal(linearScan(far, 'MAT1', 'EQ1').minGap, 7);
});

test('E_LIMIT: invalid k, negative budget, and enumeration overflow', () => {
  const planner = new Planner();
  planner.addJob(makeJob('A'));
  assert.throws(
    () => planner.select({ material: 'MAT1', equipment: 'EQ1', k: 0, budget: 10 }),
    (err) => err instanceof PlannerError && err.code === E_LIMIT,
  );
  assert.throws(
    () => planner.select({ material: 'MAT1', equipment: 'EQ1', k: MAX_K + 1, budget: 10 }),
    (err) => err.code === E_LIMIT,
  );
  assert.throws(
    () => planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: -1 }),
    (err) => err.code === E_LIMIT,
  );
  assert.throws(
    () => planner.addJob(makeJob('B', { cost: -1 })),
    (err) => err.code === E_LIMIT,
  );

  const big = new Planner();
  for (let i = 0; i < MAX_ENUM + 1; i += 1) big.addJob(makeJob(`J${i}`));
  assert.throws(
    () => big.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 1000 }),
    (err) => err.code === E_LIMIT,
  );
});

test('E_TIE: --one rejects multiple optima, default returns all ties', () => {
  const planner = new Planner();
  planner.addJob(makeJob('A', { cost: 5 }));
  planner.addJob(makeJob('B', { cost: 5 }));
  const all = planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 5 });
  assert.equal(all.results.length, 2);
  assert.deepEqual(all.results.map((r) => r.jobs), [['A'], ['B']]);
  assert.throws(
    () => planner.select({ material: 'MAT1', equipment: 'EQ1', k: 1, budget: 5, one: true }),
    (err) => err.code === E_TIE,
  );
});

test('E_STATE: duplicate add, double void, restore of active job, unknown id', () => {
  const planner = new Planner();
  planner.addJob(makeJob('A'));
  assert.throws(() => planner.addJob(makeJob('A')), (err) => err.code === E_STATE);
  planner.voidJob('A');
  assert.throws(() => planner.voidJob('A'), (err) => err.code === E_STATE);
  planner.restoreJob('A');
  assert.throws(() => planner.restoreJob('A'), (err) => err.code === E_STATE);
  assert.throws(() => planner.voidJob('NOPE'), (err) => err.code === E_STATE);
  assert.throws(() => planner.explain('NOPE', { material: 'M', equipment: 'E' }), (err) => err.code === E_STATE);
});

test('CLI: add/void/restore/select/explain round-trip over a persisted db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'));
  const db = join(dir, 'db.json');
  const invoke = (args) => {
    const out = { stdout: '', stderr: '' };
    const io = {
      stdout: { write: (chunk) => { out.stdout += chunk; } },
      stderr: { write: (chunk) => { out.stderr += chunk; } },
    };
    const status = runCli([...args, '--db', db], io);
    return { status, ...out };
  };
  const run = (args) => {
    const res = invoke(args);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const runErr = (args) => {
    const res = invoke(args);
    assert.notEqual(res.status, 0);
    return { status: res.status, stderr: JSON.parse(res.stderr) };
  };
  try {
    run(['add', '--id', 'A', '--desc', DESC, '--material', 'MAT1', '--equipment', 'EQ1', '--cost', '5', '--overdue', '0']);
    run(['add', '--id', 'B', '--desc', DESC, '--material', 'MAT1', '--equipment', 'EQ1', '--cost', '5', '--overdue', '0']);

    let out = run(['select', '--material', 'MAT1', '--equipment', 'EQ1', '--k', '2', '--budget', '10']);
    assert.deepEqual(out.results.map((r) => r.jobs), [['A', 'B']]);

    run(['void', '--id', 'A']);
    out = run(['select', '--material', 'MAT1', '--equipment', 'EQ1', '--k', '2', '--budget', '10']);
    assert.deepEqual(out.results.map((r) => r.jobs), [['B']]);

    out = run(['explain', '--id', 'A', '--material', 'MAT1', '--equipment', 'EQ1']);
    assert.equal(out.decision, 'excluded-voided');
    assert.equal(out.sources.invertedIndex.matched, true);
    assert.equal(out.sources.linearScan.match, true);

    run(['restore', '--id', 'A']);
    out = run(['select', '--material', 'MAT1', '--equipment', 'EQ1', '--k', '2', '--budget', '10']);
    assert.deepEqual(out.results.map((r) => r.jobs), [['A', 'B']]);

    const tie = runErr(['select', '--material', 'MAT1', '--equipment', 'EQ1', '--k', '1', '--budget', '5', '--one']);
    assert.equal(tie.status, 1);
    assert.equal(tie.stderr.error.code, E_TIE);

    const state = runErr(['void', '--id', 'GHOST']);
    assert.equal(state.status, 1);
    assert.equal(state.stderr.error.code, E_STATE);

    const limit = runErr(['select', '--material', 'MAT1', '--equipment', 'EQ1', '--k', '0', '--budget', '5']);
    assert.equal(limit.status, 1);
    assert.equal(limit.stderr.error.code, E_LIMIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
