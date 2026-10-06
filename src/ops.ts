import { createHash } from "node:crypto";
import { createPrng, pickInt } from "./prng";

export type Op =
  | { kind: "submit"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "pump"; steps: number };

const ID_POOL = ["a", "b", "c", "d"];

export function generateOps(seed: number, count: number): Op[] {
  const rand = createPrng(seed);
  const ops: Op[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    if (roll < 0.45) {
      ops.push({ kind: "submit", id: ID_POOL[pickInt(rand, 0, ID_POOL.length - 1)] as string });
    } else if (roll < 0.75) {
      ops.push({ kind: "cancel", id: ID_POOL[pickInt(rand, 0, ID_POOL.length - 1)] as string });
    } else {
      ops.push({ kind: "pump", steps: pickInt(rand, 1, 3) });
    }
  }
  return ops;
}

export function serializeOps(ops: readonly Op[]): string {
  return ops.map((op) => {
    switch (op.kind) {
      case "submit":
        return `submit(${op.id})`;
      case "cancel":
        return `cancel(${op.id})`;
      case "pump":
        return `pump(${op.steps})`;
    }
  }).join(";");
}

// Source hash: binds any diff report to the exact op sequence that produced it.
export function hashOps(ops: readonly Op[]): string {
  return createHash("sha256").update(serializeOps(ops)).digest("hex");
}
