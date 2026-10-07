import { RollbackDSU } from "../src/rollback-dsu";

declare const process: { exit(code: number): never };

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}
function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL: ${msg} — expected ${expected}, got ${actual}`);
  }
}

/**
 * Reference model: keeps the raw merge log, truncates it on rollback, and
 * rebuilds the connectivity graph from scratch (BFS) to derive components
 * and their minimum member ids. Deliberately naive — the DSU under test
 * must agree with it after every operation.
 */
class ReferenceModel {
  private merges: Array<[number, number]> = [];
  private snaps: number[] = [];

  constructor(private readonly n: number) {}

  get operationCount(): number {
    return this.merges.length;
  }
  get snapshotCount(): number {
    return this.snaps.length;
  }

  merge(a: number, b: number): void {
    this.merges.push([a, b]); // repeated merges occupy a slot here too
  }

  snapshot(): number {
    this.snaps.push(this.merges.length);
    return this.snaps.length - 1;
  }

  rollback(token?: number): void {
    if (this.snaps.length === 0) throw new Error("rollback without snapshot");
    let target: number;
    if (token === undefined) {
      target = this.snaps.pop()!;
    } else {
      target = this.snaps[token]!;
      this.snaps.length = token;
    }
    this.merges.length = target;
  }

  /** Rebuild the graph from the surviving merge log. */
  private rebuildComponents(): number[] {
    const adj: number[][] = Array.from({ length: this.n }, () => []);
    for (const [a, b] of this.merges) {
      adj[a]!.push(b);
      adj[b]!.push(a);
    }
    const compMin = new Array<number>(this.n).fill(-1);
    for (let s = 0; s < this.n; s++) {
      if (compMin[s] !== -1) continue;
      const members: number[] = [];
      const stack = [s];
      compMin[s] = s; // mark visited
      while (stack.length > 0) {
        const u = stack.pop()!;
        members.push(u);
        for (const v of adj[u]!) {
          if (compMin[v] === -1) {
            compMin[v] = s;
            stack.push(v);
          }
        }
      }
      const min = Math.min(...members);
      for (const m of members) compMin[m] = min;
    }
    return compMin;
  }

  componentMin(x: number): number {
    return this.rebuildComponents()[x]!;
  }

  componentCount(): number {
    const mins = this.rebuildComponents();
    return new Set(mins).size;
  }

  connected(a: number, b: number): boolean {
    const mins = this.rebuildComponents();
    return mins[a] === mins[b];
  }
}

// ---------- deterministic tests ----------

function testBasicMergeAndMinId(): void {
  const d = new RollbackDSU(6);
  eq(d.components, 6, "initial component count");
  eq(d.find(3), 3, "singleton is its own min");
  d.merge(4, 2);
  d.merge(5, 4);
  eq(d.find(5), 2, "component identity is the minimum member id");
  eq(d.find(2), 2, "min id for every member");
  eq(d.components, 4, "component count after merges");
  check(d.connected(2, 5), "connected after merges");
  check(!d.connected(0, 5), "not connected across components");
}

function testRepeatedMergeOccupiesSlot(): void {
  const d = new RollbackDSU(4);
  d.merge(0, 1);
  const snap = d.snapshot();
  const before = d.operationCount;
  check(!d.merge(0, 1), "repeated merge reports no change");
  check(!d.merge(1, 0), "repeated merge (reversed) reports no change");
  eq(d.operationCount, before + 2, "repeated merges occupy operation slots");
  d.rollback(snap);
  eq(d.operationCount, before, "rollback consumes the repeated-merge slots");
  check(d.connected(0, 1), "pre-snapshot merge survives rollback");
  eq(d.find(1), 0, "min id intact after rollback of no-op merges");
}

function testRollbackUndoesMergesAfterSnapshot(): void {
  const d = new RollbackDSU(5);
  d.merge(0, 1);
  d.snapshot();
  d.merge(1, 2);
  d.merge(3, 4);
  eq(d.components, 2, "merged down to two components");
  d.rollback();
  eq(d.components, 4, "rollback restores component count");
  check(d.connected(0, 1), "pre-snapshot merge kept");
  check(!d.connected(1, 2), "post-snapshot merge undone");
  check(!d.connected(3, 4), "post-snapshot merge undone");
  eq(d.find(0), 0, "min id after rollback");
  eq(d.find(3), 3, "singleton restored after rollback");
}

function testNestedSnapshots(): void {
  const d = new RollbackDSU(6);
  d.merge(0, 1);
  const s1 = d.snapshot();
  d.merge(2, 3);
  d.snapshot();
  d.merge(1, 2);
  eq(d.find(3), 0, "all four connected with min 0");
  d.rollback(); // undo merge(1,2)
  check(!d.connected(0, 2), "inner rollback undoes only inner merges");
  eq(d.find(3), 2, "inner component min restored");
  d.rollback(s1); // undo merge(2,3) as well
  check(!d.connected(2, 3), "outer rollback by token undoes newer snapshots too");
  eq(d.snapshotCount, 0, "snapshot stack drained");
  eq(d.find(1), 0, "outer component intact");
}

function testMinIdNotRootBySize(): void {
  const d = new RollbackDSU(4);
  d.merge(2, 3); // component {2,3}
  d.merge(0, 1); // component {0,1}
  d.merge(3, 1); // joins; larger side may win the root, min must still be 0
  eq(d.find(3), 0, "min member id regardless of which side became root");
  eq(d.find(2), 0, "min propagates to every member");
}

function testNoPathCompression(): void {
  const d = new RollbackDSU(8);
  // Build a tall-ish chain: 0-1, 2-3, 4-5, 6-7, then join pairs, then halves.
  d.merge(0, 1);
  d.merge(2, 3);
  d.merge(4, 5);
  d.merge(6, 7);
  d.merge(1, 3);
  d.merge(5, 7);
  d.merge(3, 7);
  const internals = d as unknown as { parent: number[] };
  const before = internals.parent.slice();
  for (let i = 0; i < 8; i++) d.find(i);
  const after = internals.parent;
  check(
    before.every((p, i) => after[i] === p),
    "find() must not compress paths (compression would break rollback)"
  );
}

function testRollbackErrors(): void {
  const d = new RollbackDSU(3);
  let threw = false;
  try {
    d.rollback();
  } catch {
    threw = true;
  }
  check(threw, "rollback without snapshot throws");
  d.snapshot();
  threw = false;
  try {
    d.rollback(7);
  } catch {
    threw = true;
  }
  check(threw, "rollback with unknown token throws");
}

// ---------- randomized test against the rebuilding reference ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function verifyAgainstReference(
  d: RollbackDSU,
  ref: ReferenceModel,
  n: number,
  ctx: string
): void {
  eq(d.operationCount, ref.operationCount, `${ctx}: operation count`);
  eq(d.snapshotCount, ref.snapshotCount, `${ctx}: snapshot count`);
  eq(d.components, ref.componentCount(), `${ctx}: component count`);
  for (let x = 0; x < n; x++) {
    eq(d.find(x), ref.componentMin(x), `${ctx}: min id of member ${x}`);
  }
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      eq(d.connected(a, b), ref.connected(a, b), `${ctx}: connected(${a},${b})`);
    }
  }
}

function testRandomizedAgainstRebuild(): void {
  const seeds = [1, 7, 42, 1337, 20261007];
  for (const seed of seeds) {
    const rand = mulberry32(seed);
    const n = 12;
    const d = new RollbackDSU(n);
    const ref = new ReferenceModel(n);
    const tokens: number[] = [];
    const steps = 600;
    for (let step = 0; step < steps; step++) {
      const r = rand();
      const ctx = `seed=${seed} step=${step}`;
      if (r < 0.5) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        d.merge(a, b);
        ref.merge(a, b);
      } else if (r < 0.68) {
        tokens.push(d.snapshot());
        ref.snapshot();
      } else if (r < 0.88) {
        if (tokens.length > 0) {
          if (rand() < 0.3) {
            // roll back to a random live snapshot by token
            const idx = Math.floor(rand() * tokens.length);
            d.rollback(tokens[idx]);
            ref.rollback(tokens[idx]);
            tokens.length = idx;
          } else {
            d.rollback();
            ref.rollback();
            tokens.pop();
          }
        }
      } else {
        // query-only step: exercise find/connected without mutating
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        eq(d.find(a), ref.componentMin(a), `${ctx}: query find(${a})`);
        eq(d.connected(a, b), ref.connected(a, b), `${ctx}: query connected`);
      }
      verifyAgainstReference(d, ref, n, ctx);
    }
  }
}

// ---------- run ----------

testBasicMergeAndMinId();
testRepeatedMergeOccupiesSlot();
testRollbackUndoesMergesAfterSnapshot();
testNestedSnapshots();
testMinIdNotRootBySize();
testNoPathCompression();
testRollbackErrors();
testRandomizedAgainstRebuild();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all tests passed");
