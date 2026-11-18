import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectionPool } from "../src/pool.ts";

const BACKOFF = { baseMs: 100, factor: 2, maxMs: 400 };

function stateOf(pool: ConnectionPool, id: string) {
  const member = pool.get(id);
  assert.ok(member !== undefined);
  return member;
}

describe("reconnect / health-check interleaving", () => {
  it("does not let a late health result regress a reconnected member", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    const first = pool.add("a");
    pool.connected("a", first.attempt);
    const doomed = pool.beginHealthCheck("a");
    assert.ok(doomed !== null);

    pool.failed("a", first.attempt);
    assert.equal(stateOf(pool, "a").state, "reconnecting");
    const retry = pool.advance(100)[0];
    pool.connected("a", retry.attempt);
    assert.equal(stateOf(pool, "a").attempt, 2);
    assert.equal(stateOf(pool, "a").state, "ready");
    assert.equal(pool.readyCount, 1);

    // Both a stale success and a stale failure must be pure no-ops.
    const before = stateOf(pool, "a");
    assert.equal(pool.completeHealthCheck(doomed, true), false);
    assert.deepEqual(stateOf(pool, "a"), before);
    assert.equal(pool.completeHealthCheck(doomed, false), false);
    assert.deepEqual(stateOf(pool, "a"), before);
    assert.equal(pool.readyCount, 1);
    assert.equal(pool.select(), "a");
  });

  it("keeps the retry deadline stable while stale probes arrive", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    const initial = pool.add("a");
    pool.connected("a", initial.attempt);
    const oldCheck = pool.beginHealthCheck("a");
    assert.ok(oldCheck !== null);

    pool.failed("a", initial.attempt);
    const deadline = stateOf(pool, "a").retryAt;
    assert.equal(deadline, 100);

    assert.equal(pool.completeHealthCheck(oldCheck, false), false);
    assert.equal(pool.completeHealthCheck(oldCheck, true), false);
    assert.equal(pool.failed("a", initial.attempt), false);
    assert.equal(stateOf(pool, "a").retryAt, deadline);
    assert.equal(stateOf(pool, "a").attempt, 1);
    assert.equal(stateOf(pool, "a").failures, 1);

    assert.deepEqual(pool.advance(99), []);
    assert.equal(stateOf(pool, "a").state, "reconnecting");
    assert.deepEqual(pool.advance(1), [{ id: "a", attempt: 2, at: 100 }]);
    assert.deepEqual(pool.advance(1_000), []);
    assert.equal(stateOf(pool, "a").attempt, 2);
  });

  it("only schedules one retry per failed attempt despite duplicate events", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    const initial = pool.add("a");

    assert.equal(pool.failed("a", initial.attempt), true);
    const firstDeadline = stateOf(pool, "a").retryAt;
    assert.equal(pool.failed("a", initial.attempt), false);
    assert.equal(stateOf(pool, "a").retryAt, firstDeadline);

    const retry = pool.advance(100)[0];
    assert.equal(pool.failed("a", retry.attempt), true);
    const secondDeadline = stateOf(pool, "a").retryAt;
    assert.equal(secondDeadline, 300);
    assert.equal(pool.failed("a", retry.attempt), false);
    assert.equal(pool.failed("a", initial.attempt), false);
    assert.equal(stateOf(pool, "a").retryAt, secondDeadline);
    assert.equal(stateOf(pool, "a").failures, 2);
  });

  it("ignores completions from the pre-reconnect connection attempt", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    const first = pool.add("a");
    pool.connected("a", first.attempt);
    pool.failed("a", first.attempt);
    const retry = pool.advance(100)[0];
    pool.connected("a", retry.attempt);
    const before = stateOf(pool, "a");

    assert.equal(pool.connected("a", first.attempt), false);
    assert.equal(pool.failed("a", first.attempt), false);
    assert.deepEqual(stateOf(pool, "a"), before);
    assert.equal(pool.readyCount, 1);
    assert.equal(pool.select(), "a");
  });

  it("is insensitive to health checks that complete successfully", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    for (const id of ["a", "b", "c"]) {
      const attempt = pool.add(id);
      pool.connected(id, attempt.attempt);
    }

    const beforeReady = [...pool.readyIds];
    const ticket = pool.beginHealthCheck("b");
    assert.ok(ticket !== null);
    assert.deepEqual(pool.readyIds, beforeReady);
    assert.equal(pool.readyCount, 3);
    const selectedDuringCheck = pool.select();
    assert.ok(selectedDuringCheck !== null);

    assert.equal(pool.completeHealthCheck(ticket, true), true);
    assert.deepEqual(pool.readyIds, beforeReady);
    assert.equal(pool.readyCount, 3);
    const after = [pool.select(), pool.select(), pool.select()];
    assert.equal(new Set(after).size, 3);
  });

  it("recomputes readiness from state, never from a drifting counter", () => {
    const pool = new ConnectionPool({ backoff: BACKOFF });
    const attempts = new Map<string, number>();
    for (const id of ["a", "b", "c", "d"]) {
      attempts.set(id, pool.add(id).attempt);
    }
    for (const id of ["a", "c"]) {
      pool.connected(id, attempts.get(id) as number);
    }
    assert.equal(pool.readyCount, 2);

    const ticket = pool.beginHealthCheck("c");
    assert.ok(ticket !== null);
    pool.completeHealthCheck(ticket, false);
    assert.equal(pool.readyCount, 1);
    assert.deepEqual(pool.readyIds, ["a"]);

    const cRetry = pool.advance(100).find((item) => item.id === "c");
    assert.ok(cRetry !== undefined);
    pool.connected("c", cRetry.attempt);
    assert.equal(pool.readyCount, 2);
    assert.deepEqual(pool.readyIds, ["a", "c"]);
    assert.equal(pool.readyCount, pool.availableIds.length);
    assert.equal(pool.snapshot().readyCount, pool.snapshot().members.filter(
      (member) => member.state === "ready",
    ).length);
  });
});
