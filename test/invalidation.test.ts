import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderedInvalidationBus } from "../src/index.js";
import { flushMicrotasks } from "./helpers.js";

describe("OrderedInvalidationBus", () => {
  it("does not let a later event overtake a slow subscriber", async () => {
    const bus = new OrderedInvalidationBus<string>();
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    bus.subscribe(async (event) => {
      if (event.key === "a") {
        await firstGate;
      }
      seen.push(`first:${event.key}`);
    });
    bus.subscribe((event) => {
      seen.push(`second:${event.key}`);
    });

    const first = bus.publish({ key: "a", version: 1, origin: "o" });
    const second = bus.publish({ key: "b", version: 1, origin: "o" });
    await flushMicrotasks();
    assert.deepEqual(seen, []);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(seen, [
      "first:a",
      "second:a",
      "first:b",
      "second:b",
    ]);
  });

  it("keeps delivering in order after a subscriber throws", async () => {
    const errors: unknown[] = [];
    const bus = new OrderedInvalidationBus<string>({
      onError: (error) => errors.push(error),
    });
    const seen: string[] = [];

    bus.subscribe((event) => {
      seen.push(`bad:${event.key}`);
      throw new Error(`bad subscriber saw ${event.key}`);
    });
    bus.subscribe((event) => {
      seen.push(`good:${event.key}`);
    });

    await bus.publish({ key: "a", version: 1, origin: "o" });
    await bus.publish({ key: "b", version: 1, origin: "o" });
    assert.deepEqual(seen, ["bad:a", "good:a", "bad:b", "good:b"]);
    assert.equal(errors.length, 2);
  });
});
