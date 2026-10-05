import { test } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LogCompactionSystem } from "../src/index.js";

type KvState = Record<string, number>;
interface KvOp {
  key: string;
  value: number;
}

const kvReducer = (state: KvState, op: KvOp): KvState => ({ ...state, [op.key]: op.value });

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simtest-"));
}

/** Deterministic PRNG so every simulated event sequence is reproducible. */
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

function pick<T>(items: T[], rand: () => number): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick from empty list");
  return item;
}

for (const seed of [1, 7, 42]) {
  test(`event simulation (seed=${seed}): remaining log recovers every live replica`, () => {
    const rand = mulberry32(seed);
    const dir = tmpdir();
    let sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});

    // Oracle: the full history applied to a plain model, never compacted.
    const oracle: KvState = {};
    const live = new Set<string>();
    let nextReplica = 0;
    let nextValue = 0;
    let compactions = 0;
    let crashes = 0;

    const checkInvariants = (): void => {
      for (const id of live) {
        const ack = sys.registry.ackOf(id);
        ok(
          sys.log.startLsn <= ack + 1,
          `replica ${id} ack=${ack} but log starts at ${sys.log.startLsn}`,
        );
        // The remaining log (snapshot <= ack + retained suffix) must rebuild
        // the replica to the exact oracle state.
        deepStrictEqual(sys.recoverReplica(id).state, oracle, `replica ${id} diverged`);
      }
      if (live.size > 0) {
        const minAck = Math.min(...[...live].map((id) => sys.registry.ackOf(id)));
        ok(sys.log.startLsn - 1 <= minAck, "compaction overtook the slowest live replica");
      }
    };

    for (let tick = 0; tick < 400; tick++) {
      const roll = rand();
      if (roll < 0.4) {
        const op: KvOp = { key: `k${Math.floor(rand() * 8)}`, value: nextValue++ };
        sys.append(op);
        oracle[op.key] = op.value;
      } else if (roll < 0.62 && live.size > 0) {
        const id = pick([...live], rand);
        const cur = sys.registry.ackOf(id);
        sys.ackReplica(id, cur + Math.floor(rand() * (sys.log.lastLsn - cur + 1)));
      } else if (roll < 0.72) {
        sys.compact();
        compactions++;
      } else if (roll < 0.84 && live.size < 6) {
        const id = `replica-${nextReplica++}`;
        if (sys.log.startLsn > 1 || rand() < 0.5) {
          sys.registerReplica(id, sys.takeSnapshot());
        } else {
          sys.registerReplica(id);
        }
        live.add(id);
      } else if (roll < 0.92 && live.size > 0) {
        const id = pick([...live], rand);
        sys.deregisterReplica(id);
        live.delete(id);
      } else {
        // Crash + restart: state must be rebuilt from disk alone.
        const membersBefore = sys.registry.members().sort();
        const acksBefore = [...sys.registry.ackVector().entries()].sort();
        const startBefore = sys.log.startLsn;
        const lastBefore = sys.log.lastLsn;
        sys = LogCompactionSystem.open<KvState, KvOp>(dir, kvReducer, {});
        deepStrictEqual(sys.registry.members().sort(), membersBefore);
        deepStrictEqual([...sys.registry.ackVector().entries()].sort(), acksBefore);
        strictEqual(sys.log.startLsn, startBefore);
        strictEqual(sys.log.lastLsn, lastBefore);
        crashes++;
      }
      checkInvariants();
    }

    ok(compactions > 0, "simulation never compacted");
    ok(crashes > 0, "simulation never crashed");
    ok(live.size > 0, "simulation ended with no live replicas");
    console.log(
      `seed=${seed}: 400 events, ${compactions} compactions, ${crashes} restarts, ` +
        `${live.size} live replicas, log [${sys.log.startLsn}..${sys.log.lastLsn}]`,
    );
  });
}
