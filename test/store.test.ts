import assert from 'node:assert/strict';
import test from 'node:test';
import { composeDiffs, invertDiff, RuleDiff } from '../src/diff';
import { Decision, Rule, summarize, Summary } from '../src/rules';
import { BatchOp, DiffVerificationError, PolicyStore } from '../src/store';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECISIONS: readonly Decision[] = ['allow', 'deny', 'audit'];
const SOURCES = ['ops-console', 'sync-job', 'audit-import', 'emergency-push'];

function makeRule(seq: number, rand: () => number): Rule {
  return {
    id: `rule-${seq}`,
    decision: DECISIONS[Math.floor(rand() * DECISIONS.length)] ?? 'allow',
    source: SOURCES[Math.floor(rand() * SOURCES.length)] ?? 'ops-console',
    pattern: `cidr:10.${Math.floor(rand() * 256)}.0.0/16`,
  };
}

function applyToRules(
  rules: ReadonlyMap<string, Rule>,
  diff: RuleDiff,
): Map<string, Rule> {
  const next = new Map(rules);
  for (const rule of diff.removed) next.delete(rule.id);
  for (const rule of diff.added) next.set(rule.id, rule);
  return next;
}

test('批量增删生成带前后摘要的差分', () => {
  const store = new PolicyStore();
  const first = store.plan([
    { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
    { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
  ]);
  assert.equal(first.before.ruleCount, 0);
  assert.equal(first.after.ruleCount, 2);
  assert.deepEqual(first.after.decisions, { allow: 1, deny: 1 });
  assert.deepEqual(first.after.sources, { s1: 1, s2: 1 });
  assert.deepEqual(first.added.map((r) => r.id), ['a', 'b']);
  assert.equal(first.removed.length, 0);
  store.publish(first);

  const second = store.plan([
    { kind: 'delete', id: 'a' },
    { kind: 'add', rule: { id: 'c', decision: 'audit', source: 's1', pattern: 'p3' } },
  ]);
  assert.equal(second.before.hash, first.after.hash);
  assert.equal(second.after.ruleCount, 2);
  assert.deepEqual(second.removed.map((r) => r.id), ['a']);
  assert.deepEqual(second.added.map((r) => r.id), ['c']);
  assert.deepEqual(second.after.decisions, { deny: 1, audit: 1 });
  store.publish(second);
  assert.equal(store.current.seq, 2);
});

test('先核后像：前像摘要不符则拒绝且不产生新版本', () => {
  const store = new PolicyStore();
  const diff = store.plan([
    { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
  ]);
  store.publish(diff);
  const stale = store.plan([
    { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
  ]);
  store.publish(stale);
  const before = store.length;
  assert.throws(() => store.publish(diff), DiffVerificationError);
  assert.equal(store.length, before);
  assert.equal(store.current.seq, 2);

  const forged: RuleDiff = { ...stale, after: { ...stale.after, ruleCount: 99 } };
  assert.throws(() => store.publish(forged), DiffVerificationError);
  assert.equal(store.length, before);
});

test('历史版本不被后续发布改变', () => {
  const store = new PolicyStore();
  const summaries: Summary[] = [store.current.summary];
  for (let i = 0; i < 5; i += 1) {
    const diff = store.plan([
      { kind: 'add', rule: { id: `r${i}`, decision: 'allow', source: 's', pattern: `p${i}` } },
    ]);
    store.publish(diff);
    summaries.push(store.current.summary);
  }
  for (let seq = 0; seq < summaries.length; seq += 1) {
    const version = store.version(seq);
    assert.equal(version.summary.hash, summaries[seq]?.hash);
    assert.equal(version.summary.ruleCount, seq);
  }
  const v1 = store.version(1);
  assert.throws(() => {
    (v1.rules as Map<string, Rule>).set('hack', {
      id: 'hack', decision: 'allow', source: 'x', pattern: 'y',
    });
  });
  assert.equal(store.version(1).summary.ruleCount, 1);
});

test('策略热更与读者快照隔离', () => {
  const store = new PolicyStore();
  store.publish(store.plan([
    { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
  ]));
  const reader = store.snapshot();
  assert.equal(reader.seq, 1);

  store.publish(store.plan([
    { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
    { kind: 'delete', id: 'a' },
  ]));
  assert.equal(store.current.seq, 2);

  assert.equal(reader.seq, 1);
  assert.equal(reader.has('a'), true);
  assert.equal(reader.has('b'), false);
  assert.equal(reader.get('a')?.decision, 'allow');
  assert.equal(store.current.rules.has('a'), false);
  assert.equal(store.current.rules.has('b'), true);
});

test('随机差分复合与逆放核对：决议及来源完全恢复', () => {
  const rand = mulberry32(20261005);
  const store = new PolicyStore();
  const initial = store.current.summary;
  const diffs: RuleDiff[] = [];
  let ruleSeq = 0;

  for (let round = 0; round < 60; round += 1) {
    const batch: BatchOp[] = [];
    const working = new Set(store.current.rules.keys());
    const ops = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < ops; i += 1) {
      const canDelete = working.size > 0;
      if (!canDelete || rand() < 0.6) {
        const rule = makeRule(ruleSeq, rand);
        ruleSeq += 1;
        working.add(rule.id);
        batch.push({ kind: 'add', rule });
      } else {
        const ids = [...working];
        const id = ids[Math.floor(rand() * ids.length)];
        if (id === undefined) continue;
        working.delete(id);
        batch.push({ kind: 'delete', id });
      }
    }
    const diff = store.plan(batch);
    store.publish(diff);
    diffs.push(diff);
  }

  const baseSeq = store.current.seq - diffs.length;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const i = Math.floor(rand() * diffs.length);
    const j = i + Math.floor(rand() * (diffs.length - i));
    let composed = diffs[i];
    for (let k = i + 1; k <= j; k += 1) {
      const next = diffs[k];
      assert.ok(composed !== undefined && next !== undefined);
      composed = composeDiffs(composed, next);
    }
    assert.ok(composed !== undefined);
    assert.equal(composed.before.hash, diffs[i]?.before.hash);
    assert.equal(composed.after.hash, diffs[j]?.after.hash);
    const startVersion = store.version(baseSeq + i);
    const landed = summarize(applyToRules(startVersion.rules, composed));
    assert.equal(landed.hash, composed.after.hash);
    assert.equal(landed.ruleCount, composed.after.ruleCount);
    assert.deepEqual(landed.decisions, composed.after.decisions);
    assert.deepEqual(landed.sources, composed.after.sources);
  }

  const tipSnapshot = store.snapshot();
  for (let k = diffs.length - 1; k >= 0; k -= 1) {
    const diff = diffs[k];
    assert.ok(diff !== undefined);
    store.unpublish(diff);
  }
  assert.equal(store.current.seq, baseSeq + diffs.length * 2);
  assert.equal(store.current.summary.hash, initial.hash);
  assert.equal(store.current.summary.ruleCount, 0);
  assert.deepEqual(store.current.summary.decisions, {});
  assert.deepEqual(store.current.summary.sources, {});
  assert.equal(store.current.rules.size, 0);
  assert.equal(store.version(baseSeq).summary.hash, initial.hash);

  assert.equal(tipSnapshot.summary.hash, diffs[diffs.length - 1]?.after.hash);
  assert.equal(tipSnapshot.summary.ruleCount, diffs[diffs.length - 1]?.after.ruleCount);
});

test('逆放顺序错误时先核失败、库状态不变', () => {
  const store = new PolicyStore();
  const d1 = store.plan([
    { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
  ]);
  store.publish(d1);
  const d2 = store.plan([
    { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
  ]);
  store.publish(d2);
  const before = store.length;
  assert.throws(() => store.unpublish(d1), DiffVerificationError);
  assert.equal(store.length, before);
  store.unpublish(d2);
  store.unpublish(d1);
  assert.equal(store.current.seq, 4);
  assert.equal(store.current.rules.size, 0);
  assert.equal(store.current.summary.hash, store.version(0).summary.hash);
});

test('差分复合要求相邻且逆差分前后摘要互换', () => {
  const store = new PolicyStore();
  const d1 = store.plan([
    { kind: 'add', rule: { id: 'a', decision: 'allow', source: 's1', pattern: 'p1' } },
  ]);
  store.publish(d1);
  const d2 = store.plan([
    { kind: 'add', rule: { id: 'b', decision: 'deny', source: 's2', pattern: 'p2' } },
  ]);
  store.publish(d2);
  const d3 = store.plan([
    { kind: 'add', rule: { id: 'c', decision: 'audit', source: 's3', pattern: 'p3' } },
  ]);
  assert.throws(() => composeDiffs(d1, d3), /not adjacent/);
  const inverse = invertDiff(d2);
  assert.equal(inverse.before.hash, d2.after.hash);
  assert.equal(inverse.after.hash, d2.before.hash);
  assert.deepEqual(inverse.added, d2.removed);
  assert.deepEqual(inverse.removed, d2.added);
});
