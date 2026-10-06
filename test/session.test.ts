import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SearchSession } from "../src/session.js";
import { ControlledStream, tick } from "./helpers.js";

describe("SearchSession cancellation", () => {
  test("beginning a new query cancels the previous one", () => {
    const session = new SearchSession();
    const first = session.beginQuery();
    const second = session.beginQuery();
    assert.ok(first.cancelled);
    assert.ok(!second.cancelled);
    assert.equal(session.activeQuery, second);
  });

  test("pages of a cancelled query are rejected and never enter the new query", () => {
    const session = new SearchSession();
    const oldQuery = session.beginQuery();
    assert.ok(session.dispatch(oldQuery, { hits: [{ id: "a", score: 1, version: 1 }] }));

    const newQuery = session.beginQuery();
    session.dispatch(newQuery, { hits: [{ id: "b", score: 2, version: 1 }] });

    // Late page from the old query, dispatched through its stale handle.
    assert.equal(session.dispatch(oldQuery, { hits: [{ id: "z", score: 99, version: 1 }] }), false);
    // Direct ingestion into the cancelled handle is refused too.
    assert.equal(oldQuery.ingest({ hits: [{ id: "y", score: 98, version: 1 }] }), false);

    assert.deepEqual(
      newQuery.results().map((h) => h.id),
      ["b"],
    );
  });

  test("drain stops at cancellation; in-flight pages are discarded", async () => {
    const session = new SearchSession();
    const query = session.beginQuery();
    const stream = new ControlledStream();

    const drained = query.drain(stream);
    stream.push({ hits: [{ id: "a", score: 1, version: 1 }] });
    await tick();

    // Cancel while drain is waiting for the next page, then deliver a page
    // that was already in flight: it must be discarded.
    query.cancel();
    stream.push({ hits: [{ id: "late", score: 99, version: 1 }] });
    stream.close();

    const results = await drained;
    assert.deepEqual(
      results.map((h) => h.id),
      ["a"],
    );
  });

  test("old query stream cannot leak into the next query's results", async () => {
    const session = new SearchSession();

    const oldQuery = session.beginQuery();
    const oldStream = new ControlledStream();
    const oldDrained = oldQuery.drain(oldStream);
    oldStream.push({ hits: [{ id: "kept", score: 5, version: 1 }] });
    await tick();

    // User issues a new query; the old one is cancelled.
    const newQuery = session.beginQuery();
    const newStream = new ControlledStream();
    const newDrained = newQuery.drain(newStream);

    // The old source keeps emitting after cancellation.
    oldStream.push({ hits: [{ id: "stale", score: 100, version: 1 }] });
    oldStream.close();
    newStream.push({ hits: [{ id: "fresh", score: 7, version: 1 }] });
    newStream.close();

    assert.deepEqual(
      (await oldDrained).map((h) => h.id),
      ["kept"],
    );
    assert.deepEqual(
      (await newDrained).map((h) => h.id),
      ["fresh"],
    );
  });

  test("drain returns merged results when the source completes normally", async () => {
    const session = new SearchSession();
    const query = session.beginQuery();
    const stream = new ControlledStream();
    const drained = query.drain(stream);
    stream.push({ hits: [{ id: "b", score: 1, version: 1 }] });
    stream.push({ hits: [{ id: "a", score: 2, version: 1 }] });
    stream.close();
    assert.deepEqual(
      (await drained).map((h) => h.id),
      ["a", "b"],
    );
  });
});
