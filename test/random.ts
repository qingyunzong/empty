import type { TxLike } from "../src/txstate";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Op =
  | { kind: "set"; name: string; value: number }
  | { kind: "add"; name: string; delta: number }
  | { kind: "get"; name: string }
  | { kind: "stage"; id: number }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "rollback" }
  | { kind: "raise" }
  | { kind: "capture"; body: Op[] };

const NAMES = ["a", "b", "c"];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function smallInt(rand: () => number, range: number): number {
  return Math.floor(rand() * (2 * range + 1)) - range;
}

function genOps(rand: () => number, count: number, depth: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < 0.2) {
      ops.push({ kind: "set", name: pick(rand, NAMES), value: smallInt(rand, 20) });
    } else if (r < 0.38) {
      ops.push({ kind: "add", name: pick(rand, NAMES), delta: smallInt(rand, 9) });
    } else if (r < 0.53) {
      ops.push({ kind: "get", name: pick(rand, NAMES) });
    } else if (r < 0.63) {
      ops.push({ kind: "stage", id: Math.floor(rand() * 1000) });
    } else if (r < 0.72) {
      ops.push({ kind: "begin" });
    } else if (r < 0.81) {
      ops.push({ kind: "commit" });
    } else if (r < 0.9) {
      ops.push({ kind: "rollback" });
    } else if (r < 0.97 && depth < 2) {
      ops.push({ kind: "capture", body: genOps(rand, 1 + Math.floor(rand() * 6), depth + 1) });
    } else {
      ops.push({ kind: "raise" });
    }
  }
  return ops;
}

export function genProgram(rand: () => number, maxOps: number): Op[] {
  return genOps(rand, 1 + Math.floor(rand() * maxOps), 0);
}

export function runProgram(tx: TxLike, ops: Op[], trace: string[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case "set":
        tx.set(op.name, op.value);
        break;
      case "add":
        tx.add(op.name, op.delta);
        break;
      case "get":
        trace.push(`get:${op.name}=${tx.get(op.name)}`);
        break;
      case "stage":
        tx.stage({ kind: "emit", payload: op.id });
        break;
      case "begin":
        tx.begin();
        trace.push(`begin d=${tx.depth()}`);
        break;
      case "commit":
        tx.commit();
        trace.push(`commit d=${tx.depth()}`);
        break;
      case "rollback":
        tx.rollback();
        trace.push(`rollback d=${tx.depth()}`);
        break;
      case "raise":
        throw new Error("boom");
      case "capture": {
        const result = tx.capture((t) => {
          runProgram(t, op.body, trace);
          return 0;
        });
        trace.push(
          result.ok
            ? `capture:ok d=${tx.depth()}`
            : `capture:err:${(result.error as Error).name}`,
        );
        break;
      }
    }
  }
}

export function runSafely(tx: TxLike, ops: Op[]): string[] {
  const trace: string[] = [];
  try {
    runProgram(tx, ops, trace);
    trace.push("top:ok");
  } catch (error) {
    trace.push(`top:err:${(error as Error).name}`);
  }
  for (const name of NAMES) {
    trace.push(`final:${name}=${tx.get(name)}`);
  }
  trace.push(`depth=${tx.depth()}`);
  trace.push(`published=${JSON.stringify(tx.published())}`);
  return trace;
}
