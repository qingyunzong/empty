import test from "node:test";
import assert from "node:assert/strict";

import { RouteCache, keySlot } from "../build/src/index.js";

function topology(epoch, migrations = []) {
  return {
    epoch,
    nodes: {
      A: { host: "10.0.0.1", port: 7000 },
      B: { host: "10.0.0.2", port: 7000 },
      C: { host: "10.0.0.3", port: 7000 },
    },
    slots: [
      { start: 0, end: 5460, owner: "A" },
      { start: 5461, end: 10922, owner: "B" },
      { start: 10923, end: 16383, owner: "C" },
    ],
    migrations,
  };
}

test("route cache tracks stable, migrating and importing slots", () => {
  const cache = new RouteCache(
    topology(1, [
      { slot: 100, from: "A", to: "B", state: "migrating" },
      { slot: 6000, from: "B", to: "C", state: "importing" },
    ]),
  );

  assert.equal(cache.require(200).phase, "stable");
  assert.equal(cache.require(200).owner, "A");

  const migrating = cache.require(100);
  assert.equal(migrating.phase, "migrating");
  assert.equal(migrating.owner, "A");
  assert.equal(migrating.source, "A");
  assert.equal(migrating.target, "B");

  const importing = cache.require(6000);
  assert.equal(importing.phase, "importing");
  assert.equal(importing.owner, "B");
  assert.equal(importing.source, "B");
  assert.equal(importing.target, "C");
});

test("MOVED updates are persistent and clear migration state", () => {
  const cache = new RouteCache(
    topology(1, [{ slot: 100, from: "A", to: "B", state: "migrating" }]),
  );
  const before = cache.revision;

  const route = cache.applyMoved(100, { host: "10.0.0.3", port: 7000 }, "C");
  assert.equal(route.owner, "C");
  assert.equal(route.phase, "stable");
  assert.equal(cache.require(100).owner, "C");
  assert.ok(cache.revision > before);
});

test("older topology epochs and stale refreshes cannot undo a newer MOVED", () => {
  const cache = new RouteCache(topology(2));
  cache.applyMoved(200, { host: "10.0.0.3", port: 7000 }, "C");

  cache.applyTopology(topology(1));
  assert.equal(cache.require(200).owner, "C");
  assert.equal(cache.epoch, 2);

  // Simulate a refresh that started at revision 0 and returned after MOVED.
  cache.applyTopology(topology(3), { ifLocalRevisionAtMost: 0 });
  assert.equal(cache.require(200).owner, "C");
  assert.equal(cache.require(300).owner, "A");
});

test("hash slot lookup agrees with the cache's slot range model", () => {
  const slot = keySlot("cache-test-key");
  assert.ok(Number.isInteger(slot));
  assert.ok(slot >= 0 && slot < 16384);
});
