import assert from "node:assert/strict";
import { AlertWindowStore } from "./store.js";
import type { Subscription } from "./store.js";
import { displayBySortedScan } from "./reference.js";
import { mulberry32, pick, randInt } from "./prng.js";
import type { AlertEvent, Batch, ChangeSource } from "./types.js";

export interface HarnessOptions {
  keys?: readonly string[];
  windowSize?: number;
  /** maxQueue given to every subscription created by the harness. */
  subMaxQueue?: number;
  /** Max steps a new subscription is left undrained (snapshot assembly). */
  maxHoldSteps?: number;
}

interface TrackedSub {
  readonly sub: Subscription;
  applied: Map<string, AlertEvent>;
  lastVersion: number | null;
  hold: number;
}

/**
 * Controllable, deterministic executor. Each step interleaves one of:
 * upserting a random event, deleting the earliest displayed event of a key,
 * moving the window, or creating a subscription (snapshot). After every step
 * it verifies:
 *  - versions increase continuously by 1 and carry the correct source;
 *  - batch changes are netted and replay exactly onto the new display set;
 *  - the store matches the fully-sorted-scan reference model;
 *  - every subscriber converges with continuous versions (resync included).
 */
export class Harness {
  readonly store: AlertWindowStore;
  readonly opCounts = { upsert: 0, removeEarliest: 0, moveWindow: 0, subscribe: 0 };

  private readonly rng: () => number;
  private readonly keys: readonly string[];
  private readonly windowSize: number;
  private readonly subMaxQueue: number;
  private readonly maxHoldSteps: number;
  private readonly events = new Map<string, AlertEvent>();
  private readonly subs: TrackedSub[] = [];
  private nextEventSeq = 0;
  private expectedVersion = 0;
  private prevDisplayed = new Map<string, AlertEvent>();

  constructor(seed: number, options: HarnessOptions = {}) {
    this.rng = mulberry32(seed);
    this.keys = options.keys ?? ["cpu", "mem", "disk", "net", "io"];
    this.windowSize = options.windowSize ?? 100;
    this.subMaxQueue = options.subMaxQueue ?? 3;
    this.maxHoldSteps = options.maxHoldSteps ?? 4;
    this.store = new AlertWindowStore({ start: 0, end: this.windowSize });
  }

  run(steps: number): void {
    for (let i = 0; i < steps; i++) this.step();
    // Final convergence check for every live subscription.
    for (const tracked of this.subs) {
      if (tracked.sub.closed) continue;
      tracked.hold = 0;
      this.drainAndVerify(tracked);
    }
  }

  step(): void {
    const roll = this.rng();
    if (roll < 0.35) this.doUpsert();
    else if (roll < 0.6) this.doRemoveEarliest();
    else if (roll < 0.8) this.doMoveWindow();
    else this.doSubscribe();
    this.verifyStoreAgainstReference();
    this.verifySubscribers();
  }

  private doUpsert(): void {
    const win = this.store.currentWindow;
    const event: AlertEvent = {
      id: `e${this.nextEventSeq++}`,
      key: pick(this.rng, this.keys),
      time: randInt(this.rng, win.start - 40, win.end + 40),
    };
    const batch = this.store.upsert(event);
    this.events.set(event.id, event);
    this.opCounts.upsert++;
    this.checkBatch(batch, "upsert");
  }

  private doRemoveEarliest(): void {
    const displayed = this.store.displayedMap();
    if (displayed.size === 0) {
      this.doUpsert();
      return;
    }
    const key = pick(this.rng, [...displayed.keys()]);
    const earliest = displayed.get(key)!;
    const batch = this.store.remove(earliest.id);
    this.events.delete(earliest.id);
    this.opCounts.removeEarliest++;
    this.checkBatch(batch, "remove");
  }

  private doMoveWindow(): void {
    const delta = randInt(this.rng, -30, 31);
    const start = this.store.currentWindow.start + delta;
    const batch = this.store.moveWindow(start, start + this.windowSize);
    this.opCounts.moveWindow++;
    this.checkBatch(batch, "window");
  }

  private doSubscribe(): void {
    const sub = this.store.subscribe({ maxQueue: this.subMaxQueue });
    const hold = randInt(this.rng, 0, this.maxHoldSteps + 1);
    this.subs.push({ sub, applied: new Map(), lastVersion: null, hold });
    this.opCounts.subscribe++;
  }

  private checkBatch(batch: Batch | null, source: ChangeSource): void {
    assert.ok(batch, "a mutating operation must commit a batch");
    assert.equal(batch.source, source, "batch source must match the operation");
    assert.equal(
      batch.version,
      this.expectedVersion + 1,
      "versions must be continuous (increase by exactly 1)",
    );
    this.expectedVersion = batch.version;

    const addedIds = new Set<string>();
    const removedIds = new Set<string>();
    for (const change of batch.changes) {
      (change.type === "added" ? addedIds : removedIds).add(change.event.id);
    }
    for (const id of addedIds) {
      assert.ok(!removedIds.has(id), `net changes must not contain cancelled item ${id}`);
    }

    const replayed = new Map(this.prevDisplayed);
    for (const change of batch.changes) {
      if (change.type === "added") replayed.set(change.event.key, change.event);
      else replayed.delete(change.event.key);
    }
    assertDisplayEqual(
      replayed,
      this.store.displayedMap(),
      "batch changes must replay exactly onto the previous display set",
    );
    this.prevDisplayed = this.store.displayedMap();
  }

  private verifyStoreAgainstReference(): void {
    const win = this.store.currentWindow;
    const expected = displayBySortedScan(this.events.values(), win.start, win.end);
    assertDisplayEqual(
      this.store.displayedMap(),
      expected,
      "store display set must match the fully-sorted-scan reference",
    );
  }

  private verifySubscribers(): void {
    for (const tracked of this.subs) {
      if (tracked.sub.closed) continue;
      if (tracked.hold > 0) {
        tracked.hold--;
        continue;
      }
      this.drainAndVerify(tracked);
    }
  }

  private drainAndVerify(tracked: TrackedSub): void {
    for (const msg of tracked.sub.drain()) {
      switch (msg.kind) {
        case "snapshot":
          tracked.applied = byKey(msg.items);
          tracked.lastVersion = msg.version;
          break;
        case "batch":
          assert.ok(tracked.lastVersion !== null, "a snapshot must precede batches");
          assert.equal(
            msg.version,
            tracked.lastVersion + 1,
            "subscriber versions must be continuous",
          );
          for (const change of msg.changes) {
            if (change.type === "added") {
              tracked.applied.set(change.event.key, change.event);
            } else {
              assert.equal(
                tracked.applied.get(change.event.key)?.id,
                change.event.id,
                "a removal must match the subscriber's displayed event",
              );
              tracked.applied.delete(change.event.key);
            }
          }
          tracked.lastVersion = msg.version;
          break;
        case "resync":
          assert.equal(
            msg.fromVersion,
            tracked.lastVersion,
            "resync must chain to the last delivered version (no version lost)",
          );
          assert.ok(
            tracked.lastVersion === null || msg.version > tracked.lastVersion,
            "resync version must advance",
          );
          tracked.applied = byKey(msg.items);
          tracked.lastVersion = msg.version;
          break;
      }
    }
    assertDisplayEqual(
      tracked.applied,
      this.store.displayedMap(),
      "subscriber must converge to the store display set",
    );
  }
}

function byKey(items: readonly AlertEvent[]): Map<string, AlertEvent> {
  return new Map(items.map((event) => [event.key, event]));
}

/** Deterministic [key, eventId] signature of a display set. */
export function displaySignature(
  display: ReadonlyMap<string, AlertEvent>,
): [string, string][] {
  return [...display.entries()]
    .map(([key, event]) => [key, event.id] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function assertDisplayEqual(
  actual: ReadonlyMap<string, AlertEvent>,
  expected: ReadonlyMap<string, AlertEvent>,
  message?: string,
): void {
  assert.deepEqual(displaySignature(actual), displaySignature(expected), message);
}
