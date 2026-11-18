import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimelineStore, TimelineError } from '../src/timeline.ts';

type Op =
  | { kind: 'root'; id: string }
  | { kind: 'archive'; id: string; start: number; end: number }
  | { kind: 'seal'; id: string }
  | { kind: 'branch'; id: string; parent: string; at: number };

interface OracleTimeline {
  parent: string | null;
  branchLsn: number;
  sealed: boolean;
  segments: [number, number][];
}

type OracleState = Map<string, OracleTimeline>;

function oracleCover(segments: [number, number][], from: number): number {
  let cursor = from;
  const sorted = [...segments].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [start, end] of sorted) {
    if (start > cursor) break;
    if (end > cursor) cursor = end;
  }
  return cursor;
}

function oracleUpTo(state: OracleState, id: string): number {
  const timeline = state.get(id) as OracleTimeline;
  if (timeline.parent === null) return oracleCover(timeline.segments, 0);
  const parentUp = oracleUpTo(state, timeline.parent);
  if (parentUp < timeline.branchLsn) return parentUp;
  return Math.max(timeline.branchLsn, oracleCover(timeline.segments, timeline.branchLsn));
}

function oracleAccepts(state: OracleState, op: Op): boolean {
  switch (op.kind) {
    case 'root':
      return !state.has(op.id);
    case 'archive': {
      const timeline = state.get(op.id);
      return (
        timeline !== undefined &&
        !timeline.sealed &&
        Number.isInteger(op.start) &&
        Number.isInteger(op.end) &&
        op.end > op.start &&
        op.start >= timeline.branchLsn
      );
    }
    case 'seal':
      return state.has(op.id);
    case 'branch': {
      const parent = state.get(op.parent);
      return (
        !state.has(op.id) &&
        parent !== undefined &&
        parent.sealed &&
        Number.isInteger(op.at) &&
        op.at >= parent.branchLsn &&
        op.at <= oracleUpTo(state, op.parent)
      );
    }
  }
}

function oracleApply(state: OracleState, op: Op): void {
  switch (op.kind) {
    case 'root':
      state.set(op.id, { parent: null, branchLsn: 0, sealed: false, segments: [] });
      return;
    case 'archive':
      (state.get(op.id) as OracleTimeline).segments.push([op.start, op.end]);
      return;
    case 'seal':
      (state.get(op.id) as OracleTimeline).sealed = true;
      return;
    case 'branch':
      state.set(op.id, { parent: op.parent, branchLsn: op.at, sealed: false, segments: [] });
      return;
  }
}

function recompute(accepted: Op[]): OracleState {
  const state: OracleState = new Map();
  for (const op of accepted) {
    if (!oracleAccepts(state, op)) {
      throw new Error(`oracle rejects store-accepted op ${JSON.stringify(op)}`);
    }
    oracleApply(state, op);
  }
  return state;
}

function oracleReachable(state: OracleState, id: string): string[] {
  const result: string[] = [];
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const [child, timeline] of state) {
      if (timeline.parent !== null && frontier.includes(timeline.parent) && !result.includes(child)) {
        result.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return result.sort();
}

function applyToStore(store: TimelineStore, op: Op): void {
  switch (op.kind) {
    case 'root':
      store.createRoot(op.id);
      return;
    case 'archive':
      store.archiveSegment(op.id, op.start, op.end);
      return;
    case 'seal':
      store.seal(op.id);
      return;
    case 'branch':
      store.createBranch(op.id, op.parent, op.at);
      return;
  }
}

function replay(accepted: Op[]): TimelineStore {
  const store = new TimelineStore();
  for (const op of accepted) applyToStore(store, op);
  return store;
}

function checkAgreement(store: TimelineStore, accepted: Op[], maxLsn: number): void {
  const oracle = recompute(accepted);
  store.validate();

  assert.deepEqual(
    store.timelines().sort(),
    [...oracle.keys()].sort(),
    'timeline sets diverged',
  );

  for (const id of store.timelines()) {
    const oracleTimeline = oracle.get(id) as OracleTimeline;
    assert.equal(store.isSealed(id), oracleTimeline.sealed, `seal state of ${id}`);
    assert.equal(
      store.recoverableUpTo(id),
      oracleUpTo(oracle, id),
      `recoverableUpTo diverged for ${id} after ${JSON.stringify(accepted)}`,
    );
    for (let lsn = 0; lsn <= maxLsn + 1; lsn += 1) {
      assert.equal(
        store.isRecoverable(id, lsn),
        lsn <= oracleUpTo(oracle, id),
        `recoverability of (${id}, ${lsn}) diverged after ${JSON.stringify(accepted)}`,
      );
    }
    assert.deepEqual(
      [...store.reachableFrom(id)].sort(),
      oracleReachable(oracle, id),
      `reachability from ${id} diverged`,
    );
    const parent = store.parentOf(id);
    assert.equal(parent === null, oracleTimeline.parent === null);
    if (parent !== null && oracleTimeline.parent !== null) {
      assert.equal(parent.parentId, oracleTimeline.parent);
      assert.equal(parent.branchLsn, oracleTimeline.branchLsn);
    }
  }

  for (let lsn = 0; lsn <= maxLsn + 1; lsn += 1) {
    const expected = [...oracle.keys()]
      .filter((id) => lsn <= oracleUpTo(oracle, id))
      .sort();
    assert.deepEqual(
      store.findRecoverableTimelines(lsn).sort(),
      expected,
      `recovery targets for lsn ${lsn} diverged`,
    );
  }

  const roundTrip = TimelineStore.restore(store.snapshot());
  assert.deepEqual(roundTrip.snapshot(), store.snapshot(), 'snapshot round-trip changed state');
}

function buildAlphabet(ids: string[], maxLsn: number): Op[] {
  const alphabet: Op[] = [{ kind: 'root', id: ids[0] }];
  for (const id of ids) {
    for (let start = 0; start < maxLsn; start += 1) {
      for (let end = start + 1; end <= maxLsn; end += 1) {
        alphabet.push({ kind: 'archive', id, start, end });
      }
    }
    alphabet.push({ kind: 'seal', id });
  }
  for (const id of ids) {
    for (const parent of ids) {
      if (parent === id) continue;
      for (let at = 0; at <= maxLsn; at += 1) {
        alphabet.push({ kind: 'branch', id, parent, at });
      }
    }
  }
  return alphabet;
}

function exploreExhaustively(ids: string[], maxLsn: number, depth: number): number {
  const alphabet = buildAlphabet(ids, maxLsn);
  const visited = new Set<string>();

  const step = (accepted: Op[], remaining: number): void => {
    const store = replay(accepted);
    const hash = JSON.stringify(store.snapshot());
    if (visited.has(hash)) return;
    visited.add(hash);
    checkAgreement(store, accepted, maxLsn);
    if (remaining === 0) return;

    const oracle = recompute(accepted);
    for (const op of alphabet) {
      const trial = TimelineStore.restore(store.snapshot());
      const before = JSON.stringify(trial.snapshot());
      let thrown: unknown = null;
      try {
        applyToStore(trial, op);
      } catch (err) {
        thrown = err;
      }
      if (thrown === null) {
        assert.ok(oracleAccepts(oracle, op), `oracle rejects ${JSON.stringify(op)}`);
        step([...accepted, op], remaining - 1);
      } else {
        assert.ok(thrown instanceof TimelineError, `unexpected error: ${thrown}`);
        assert.ok(
          !oracleAccepts(oracle, op),
          `store rejects oracle-accepted op ${JSON.stringify(op)}`,
        );
        assert.equal(
          JSON.stringify(trial.snapshot()),
          before,
          `rejected op ${JSON.stringify(op)} mutated the store`,
        );
      }
    }
  };

  step([], depth);
  return visited.size;
}

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

test('exhaustive: 2 timelines, lsn 0..3, depth 6 interleavings agree with full recompute', () => {
  const states = exploreExhaustively(['A', 'B'], 3, 6);
  assert.ok(states > 100, `expected a rich state space, visited only ${states}`);
});

test('exhaustive: 3 timelines, lsn 0..3, depth 5 interleavings agree with full recompute', () => {
  const states = exploreExhaustively(['A', 'B', 'C'], 3, 5);
  assert.ok(states > 40, `expected a rich state space, visited only ${states}`);
});

test('fuzz: seeded long histories stay consistent with full recompute', () => {
  const rand = mulberry32(0x5eed);
  const ids = ['A', 'B', 'C', 'D'];
  const maxLsn = 8;
  const alphabet = buildAlphabet(ids, maxLsn);

  for (let history = 0; history < 300; history += 1) {
    const accepted: Op[] = [];
    const store = new TimelineStore();
    const sealedSnapshots = new Map<string, string>();
    const length = 20 + Math.floor(rand() * 40);

    for (let stepIndex = 0; stepIndex < length; stepIndex += 1) {
      const op = alphabet[Math.floor(rand() * alphabet.length)];
      const before = JSON.stringify(store.snapshot());
      try {
        applyToStore(store, op);
        accepted.push(op);
        if (op.kind === 'seal') {
          sealedSnapshots.set(op.id, JSON.stringify(store.info(op.id).segments));
        }
      } catch (err) {
        assert.ok(err instanceof TimelineError, `unexpected error: ${err}`);
        assert.equal(JSON.stringify(store.snapshot()), before, 'rejected op mutated state');
      }

      for (const [id, frozen] of sealedSnapshots) {
        assert.equal(
          JSON.stringify(store.info(id).segments),
          frozen,
          `sealed timeline ${id} was rewritten`,
        );
      }
      checkAgreement(store, accepted, maxLsn);
    }
  }
});
