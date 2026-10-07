import { test } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { applyPullPlan, computePullPlan } from '../src/sync.js';
import { referenceDiff } from '../src/reference.js';
import { ReplicaServer } from '../src/server.js';
import { buildTrie } from '../src/trie.js';
import { hashValue } from '../src/hash.js';

function makeLocal(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function assertPlanMatchesReference(
  local: Map<string, string>,
  server: ReplicaServer,
): ReturnType<typeof computePullPlan> {
  const plan = computePullPlan(local, server);
  const expected = referenceDiff(local, server.snapshot());
  deepStrictEqual(plan.pull, expected.pull, 'pull keys must match full-map diff');
  deepStrictEqual(plan.remove, expected.remove, 'remove keys must match full-map diff');
  strictEqual(plan.version, server.currentVersion, 'plan must be consistent with remote version');
  applyPullPlan(local, server, plan);
  deepStrictEqual([...local].sort(), [...server.snapshot()].sort(), 'replicas must converge after apply');
  return plan;
}

test('identical replicas: empty plan, only root-level RPCs', () => {
  const data: Record<string, string> = {};
  for (let i = 0; i < 128; i += 1) data[`key-${i}`] = `value-${i}`;
  const server = new ReplicaServer(data);
  const plan = computePullPlan(makeLocal(data), server);
  deepStrictEqual(plan.pull, []);
  deepStrictEqual(plan.remove, []);
  strictEqual(plan.restarts, 0);
  ok(plan.requests <= 2, `expected <= 2 requests, got ${plan.requests}`);
});

test('changed, added and deleted keys match the full-map reference diff', () => {
  const local = makeLocal({ a: '1', b: '2', c: '3', stale: 'old' });
  const server = new ReplicaServer({ a: '1', b: 'changed', c: '3', fresh: 'new' });
  const plan = assertPlanMatchesReference(local, server);
  deepStrictEqual(plan.pull, ['b', 'fresh']);
  deepStrictEqual(plan.remove, ['stale']);
  strictEqual(plan.restarts, 0);
});

test('empty remote removes everything; empty local pulls everything', () => {
  const data = { x: '1', y: '2', z: '3' };
  const server = new ReplicaServer(data);
  const planRemove = computePullPlan(makeLocal(data), new ReplicaServer());
  deepStrictEqual(planRemove.pull, []);
  deepStrictEqual(planRemove.remove, ['x', 'y', 'z']);
  const local = makeLocal({});
  assertPlanMatchesReference(local, server);
  deepStrictEqual([...local.keys()].sort(), ['x', 'y', 'z']);
});

test('minimality: only differing subtrees are fetched on a large replica set', () => {
  const base: Record<string, string> = {};
  for (let i = 0; i < 512; i += 1) base[`obj-${i}`] = `v${i}`;
  const local = makeLocal(base);
  const remote = { ...base };
  // 5 value changes, 3 additions, 2 deletions => 10 divergent leaves of 512.
  for (const k of ['obj-1', 'obj-100', 'obj-255', 'obj-400', 'obj-511']) remote[k] = 'mutated';
  for (const k of ['new-1', 'new-2', 'new-3']) remote[k] = 'added';
  delete remote['obj-7'];
  delete remote['obj-300'];
  const server = new ReplicaServer(remote);
  const plan = assertPlanMatchesReference(local, server);
  strictEqual(plan.pull.length, 8);
  strictEqual(plan.remove.length, 2);
  // Full traversal would visit every one of the ~1023 trie nodes; the plan
  // must stay proportional to divergent leaves x tree depth.
  ok(plan.requests < 250, `expected < 250 requests, got ${plan.requests}`);
});

test('mid-sync version change restarts the branch and still converges', () => {
  const base: Record<string, string> = {};
  for (let i = 0; i < 128; i += 1) base[`k-${i}`] = `v${i}`;
  const remote = { ...base };
  remote['k-5'] = 'changed';
  const server = new ReplicaServer(remote);
  const local = makeLocal(base);

  let calls = 0;
  server.beforeRequest = () => {
    calls += 1;
    if (calls === 3) {
      // Concurrent writer commits mid-sync: version bumps under the client.
      server.set('k-200', 'concurrent');
      server.beforeRequest = null;
    }
  };

  const plan = computePullPlan(local, server);
  ok(plan.restarts >= 1, 'expected at least one branch restart');
  const expected = referenceDiff(local, server.snapshot());
  deepStrictEqual(plan.pull, expected.pull);
  deepStrictEqual(plan.remove, expected.remove);
  strictEqual(plan.version, server.currentVersion);
  applyPullPlan(local, server, plan);
  deepStrictEqual([...local].sort(), [...server.snapshot()].sort());
});

test('persistent version instability fails loudly instead of looping', () => {
  const server = new ReplicaServer({ a: '1' });
  let n = 0;
  server.beforeRequest = () => {
    n += 1;
    server.set(`churn-${n}`, 'x');
  };
  let threw = false;
  try {
    computePullPlan(makeLocal({}), server);
  } catch (err) {
    threw = true;
    ok(/unstable/.test(String(err)));
  }
  ok(threw, 'expected computePullPlan to throw on unstable remote');
});

test('trie is deterministic and sensitive to key and value changes', () => {
  const a = buildTrie([['k', hashValue('v')]]);
  const b = buildTrie([['k', hashValue('v')]]);
  const c = buildTrie([['k', hashValue('other')]]);
  const d = buildTrie([['other-key', hashValue('v')]]);
  strictEqual(a?.hash, b?.hash);
  notStrictEqual(a?.hash, c?.hash);
  notStrictEqual(a?.hash, d?.hash);
});

test('reference diff itself is sane', () => {
  const diff = referenceDiff(
    new Map([['a', '1'], ['b', '2'], ['gone', 'x']]),
    new Map([['a', '1'], ['b', '3'], ['new', 'y']]),
  );
  deepStrictEqual(diff.pull, ['b', 'new']);
  deepStrictEqual(diff.remove, ['gone']);
});

test('server version bumps on every mutation', () => {
  const server = new ReplicaServer({ a: '1' });
  const v0 = server.currentVersion;
  server.set('a', '2');
  strictEqual(server.currentVersion, v0 + 1);
  server.set('b', '1');
  strictEqual(server.currentVersion, v0 + 2);
  server.delete('a');
  strictEqual(server.currentVersion, v0 + 3);
  server.delete('missing');
  strictEqual(server.currentVersion, v0 + 3);
});
