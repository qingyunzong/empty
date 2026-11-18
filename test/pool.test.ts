import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConnectionPool,
  computeBackoffDelay,
} from "../src/pool.ts";

const FAST_BACKOFF = { baseMs: 100, factor: 2, maxMs: 1_000 };

function readyPool(ids: string[]): ConnectionPool {
  const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
  for (const id of ids) {
    const attempt = pool.add(id);
    assert.equal(pool.connected(id, attempt.attempt), true);
  }
  return pool;
}

describe("connection readiness", () => {
  it("keeps readyCount in one-to-one correspondence with available ids", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    assert.equal(pool.readyCount, 0);
    assert.deepEqual(pool.availableIds, []);

    const a = pool.add("a");
    const b = pool.add("b");
    assert.equal(pool.readyCount, 0);
    assert.deepEqual(pool.readyIds, []);

    assert.equal(pool.connected("b", b.attempt), true);
    assert.equal(pool.connected("a", a.attempt), true);
    assert.deepEqual(pool.readyIds, ["a", "b"]);
    assert.deepEqual(pool.availableIds, ["a", "b"]);
    assert.equal(pool.readyCount, 2);
    assert.equal(pool.readyCount, pool.availableIds.length);

    assert.equal(pool.failed("a", a.attempt), true);
    assert.deepEqual(pool.readyIds, ["b"]);
    assert.equal(pool.readyCount, 1);
    assert.equal(pool.readyCount, pool.availableIds.length);
    assert.equal(pool.snapshot().readyCount, pool.snapshot().readyIds.length);
  });

  it("never selects connecting or reconnecting members", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    const a = pool.add("a");
    const b = pool.add("b");
    pool.connected("a", a.attempt);

    assert.equal(pool.select(), "a");
    assert.equal(pool.failed("a", a.attempt), true);
    assert.equal(pool.select(), null, "reconnecting members are not allocatable");
    assert.deepEqual(pool.readyIds, []);

    const retry = pool.advance(100);
    assert.deepEqual(retry.map((item) => item.id), ["a"]);
    assert.equal(pool.select(), null, "connecting members are not allocatable");
    pool.connected("a", retry[0].attempt);
    assert.equal(pool.select(), "a");

    assert.equal(pool.connected("b", b.attempt), true);
    assert.equal(pool.readyCount, 2);
  });
});

describe("deterministic selection", () => {
  it("round-robins over stable id order and skips unavailable members", () => {
    const pool = readyPool(["c", "a", "b"]);
    assert.deepEqual(
      [pool.select(), pool.select(), pool.select(), pool.select()],
      ["a", "b", "c", "a"],
    );

    const b = pool.failed("b", pool.attemptOf("b") as number);
    assert.equal(b, true);
    assert.deepEqual([pool.select(), pool.select(), pool.select()], [
      "c",
      "a",
      "c",
    ]);
  });

  it("selects the same member for the same key and ready set", () => {
    const pool = readyPool(["a", "b", "c", "d"]);
    const expected = pool.selectForKey("tenant:42");
    assert.ok(expected !== null);
    assert.equal(pool.selectForKey("tenant:42"), expected);
    assert.equal(pool.selectForKey("tenant:42"), expected);

    const keys = ["tenant:1", "tenant:2", "tenant:3", "tenant:4", "tenant:5"];
    const first = keys.map((key) => pool.selectForKey(key));
    const second = keys.map((key) => pool.selectForKey(key));
    assert.deepEqual(second, first);
  });
});

describe("reconnect backoff", () => {
  it("uses a deterministic capped exponential schedule", () => {
    assert.equal(computeBackoffDelay(1, FAST_BACKOFF), 100);
    assert.equal(computeBackoffDelay(2, FAST_BACKOFF), 200);
    assert.equal(computeBackoffDelay(3, FAST_BACKOFF), 400);
    assert.equal(computeBackoffDelay(4, FAST_BACKOFF), 800);
    assert.equal(computeBackoffDelay(5, FAST_BACKOFF), 1_000);
    assert.equal(computeBackoffDelay(50, FAST_BACKOFF), 1_000);
  });

  it("advances retries only at the scheduled deadline", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    const a = pool.add("a");
    pool.connected("a", a.attempt);
    pool.failed("a", a.attempt);
    assert.equal(pool.nextRetryAt, 100);
    assert.equal(pool.snapshot().members[0].retryAt, 100);

    assert.deepEqual(pool.advance(99), []);
    assert.equal(pool.attemptOf("a"), 1);
    assert.equal(pool.snapshot().members[0].state, "reconnecting");

    assert.deepEqual(pool.advance(1), [{ id: "a", attempt: 2, at: 100 }]);
    assert.equal(pool.snapshot().members[0].state, "connecting");
    assert.equal(pool.nextRetryAt, null);

    assert.deepEqual(pool.advance(10_000), []);
    assert.equal(pool.attemptOf("a"), 2, "one deadline creates one attempt");
  });

  it("advances the interval after each failed reconnect and caps it", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    const initial = pool.add("a");
    assert.equal(pool.failed("a", initial.attempt), true);
    assert.equal(pool.nextRetryAt, 100);

    const second = pool.advance(100)[0];
    assert.equal(second.attempt, 2);
    assert.equal(pool.failed("a", second.attempt), true);
    assert.equal(pool.nextRetryAt, 300, "second failure waits 200ms");

    const third = pool.advance(200)[0];
    assert.equal(third.attempt, 3);
    assert.equal(pool.failed("a", third.attempt), true);
    assert.equal(pool.nextRetryAt, 700, "third failure waits 400ms");

    const fourth = pool.advance(400)[0];
    assert.equal(fourth.attempt, 4);
    assert.equal(pool.failed("a", fourth.attempt), true);
    assert.equal(pool.nextRetryAt, 1_500, "fourth failure waits 800ms");

    const fifth = pool.advance(800)[0];
    assert.equal(fifth.attempt, 5);
    assert.equal(pool.failed("a", fifth.attempt), true);
    assert.equal(pool.nextRetryAt, 2_500, "delay is capped at 1000ms");
  });

  it("does not move the deadline for duplicate or stale failures", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    const a = pool.add("a");
    pool.connected("a", a.attempt);
    assert.equal(pool.failed("a", a.attempt), true);
    const before = pool.snapshot();

    assert.equal(pool.failed("a", a.attempt), false);
    assert.equal(pool.failed("a", 999), false);
    assert.equal(pool.connected("a", a.attempt), false);
    assert.deepEqual(pool.snapshot(), before);
    assert.deepEqual(pool.advance(99), []);
  });
});

describe("health checks", () => {
  it("keeps a member selectable while a check is in flight", () => {
    const pool = readyPool(["a", "b"]);
    const before = pool.readyCount;
    const ticket = pool.beginHealthCheck("a");
    assert.ok(ticket !== null);
    assert.equal(pool.snapshot().members[0].checking, true);
    assert.equal(pool.readyCount, before);
    assert.deepEqual(pool.readyIds, ["a", "b"]);

    assert.equal(pool.completeHealthCheck(ticket, true), true);
    assert.equal(pool.readyCount, before);
    assert.equal(pool.snapshot().members[0].checking, false);
  });

  it("removes a failing member and schedules the base retry interval", () => {
    const pool = readyPool(["a", "b"]);
    const ticket = pool.beginHealthCheck("b");
    assert.ok(ticket !== null);
    assert.equal(pool.completeHealthCheck(ticket, false), true);

    assert.deepEqual(pool.readyIds, ["a"]);
    const b = pool.snapshot().members[1];
    assert.equal(b.state, "reconnecting");
    assert.equal(b.retryAt, 100);
    assert.equal(pool.select(), "a");
    assert.equal(pool.select(), "a");
  });

  it("ignores stale health tickets after a reconnect", () => {
    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    const first = pool.add("a");
    pool.connected("a", first.attempt);

    const oldTicket = pool.beginHealthCheck("a");
    assert.ok(oldTicket !== null);

    // The old socket dies while its health probe is still in flight.
    assert.equal(pool.failed("a", first.attempt), true);
    assert.deepEqual(pool.readyIds, []);
    assert.equal(pool.completeHealthCheck(oldTicket, true), false);
    assert.equal(pool.snapshot().members[0].state, "reconnecting");

    const retry = pool.advance(100)[0];
    assert.equal(retry.attempt, 2);
    assert.equal(pool.connected("a", retry.attempt), true);
    assert.deepEqual(pool.readyIds, ["a"]);

    // A late completion from the previous attempt must not regress readiness.
    assert.equal(pool.completeHealthCheck(oldTicket, false), false);
    assert.equal(pool.completeHealthCheck(oldTicket, true), false);
    assert.equal(pool.snapshot().members[0].state, "ready");
    assert.equal(pool.readyCount, 1);
    assert.equal(pool.select(), "a");
  });

  it("does not let an old probe complete a newer in-flight probe", () => {
    const pool = readyPool(["a"]);
    const oldTicket = pool.beginHealthCheck("a");
    assert.ok(oldTicket !== null);
    assert.equal(pool.completeHealthCheck(oldTicket, true), true);

    const freshTicket = pool.beginHealthCheck("a");
    assert.ok(freshTicket !== null);
    assert.notEqual(freshTicket.token, oldTicket.token);
    assert.equal(pool.completeHealthCheck(oldTicket, false), false);
    assert.equal(pool.snapshot().members[0].checking, true);
    assert.equal(pool.snapshot().members[0].state, "ready");
    assert.equal(pool.completeHealthCheck(freshTicket, true), true);
  });
});

describe("membership and validation", () => {
  it("supports removal and permanent close", () => {
    const pool = readyPool(["a", "b"]);
    assert.equal(pool.remove("a"), true);
    assert.equal(pool.has("a"), false);
    assert.deepEqual(pool.readyIds, ["b"]);
    assert.equal(pool.connected("a", 1), false);

    assert.equal(pool.close("b"), true);
    assert.equal(pool.readyCount, 0);
    assert.equal(pool.close("b"), false);
    assert.equal(pool.connected("b", pool.attemptOf("b") as number), false);
  });

  it("rejects invalid configuration and time movement", () => {
    assert.throws(
      () => new ConnectionPool({ backoff: { baseMs: 0 } }),
      RangeError,
    );
    assert.throws(
      () => new ConnectionPool({ backoff: { factor: 0.5 } }),
      RangeError,
    );
    assert.throws(
      () => new ConnectionPool({ backoff: { maxMs: 1 } }),
      RangeError,
    );

    const pool = new ConnectionPool({ backoff: FAST_BACKOFF });
    assert.throws(() => pool.advance(-1), RangeError);
    assert.throws(() => pool.advanceTo(-1), RangeError);
    assert.throws(() => pool.add(""), TypeError);
    pool.add("a");
    assert.throws(() => pool.add("a"), /already exists/);
  });
});
