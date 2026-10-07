import test from "node:test";
import assert from "node:assert/strict";
import { mergeRoundRobin } from "../src/merge.js";
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
const tick = () => Promise.resolve();
/** An async source fully driven by the test via controlled promises. */
class ControlledSource {
    nextCalls = 0;
    returnCalls = 0;
    throwCalls = 0;
    inbox = [];
    next() {
        this.nextCalls += 1;
        const slot = deferred();
        this.inbox.push(slot);
        return slot.promise;
    }
    return() {
        this.returnCalls += 1;
        return Promise.resolve({ value: undefined, done: true });
    }
    throw(error) {
        this.throwCalls += 1;
        return Promise.reject(error);
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    /** Number of unresolved next() calls currently in flight. */
    get inFlight() {
        return this.inbox.length;
    }
    deliver(value) {
        this.inbox.shift().resolve({ value, done: false });
    }
    end() {
        this.inbox.shift().resolve({ value: undefined, done: true });
    }
    fail(error) {
        this.inbox.shift().reject(error);
    }
}
test("delivers items in round-robin source order, not arrival order", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const merged = mergeRoundRobin([a, b, c]);
    // c and b resolve first; the merger must still emit a's item first.
    c.deliver("c0");
    b.deliver("b0");
    await tick();
    const first = merged.next();
    a.deliver("a0");
    assert.deepEqual(await first, { value: "a0", done: false });
    assert.deepEqual(await merged.next(), { value: "b0", done: false });
    assert.deepEqual(await merged.next(), { value: "c0", done: false });
    // Second round, a is exhausted.
    b.deliver("b1");
    a.end();
    c.deliver("c1");
    assert.deepEqual(await merged.next(), { value: "b1", done: false });
    assert.deepEqual(await merged.next(), { value: "c1", done: false });
    b.end();
    c.end();
    assert.deepEqual(await merged.next(), { value: undefined, done: true });
    // Natural exhaustion does not force-close sources.
    assert.equal(a.returnCalls, 0);
    assert.equal(b.returnCalls, 0);
    assert.equal(c.returnCalls, 0);
});
test("keeps at most one in-flight prefetch per source", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = mergeRoundRobin([a, b]);
    assert.equal(a.nextCalls, 1);
    assert.equal(b.nextCalls, 1);
    assert.equal(a.inFlight, 1);
    assert.equal(b.inFlight, 1);
    a.deliver(1);
    await tick();
    assert.equal(a.inFlight, 0, "a's prefetch resolved, none re-issued yet");
    assert.equal(b.inFlight, 1);
    assert.deepEqual(await merged.next(), { value: 1, done: false });
    assert.equal(a.nextCalls, 2, "consuming a's item triggers exactly one new prefetch");
    assert.equal(a.inFlight, 1);
    assert.equal(b.nextCalls, 1, "b is never asked for a second concurrent item");
    b.deliver(2);
    assert.deepEqual(await merged.next(), { value: 2, done: false });
    assert.equal(b.nextCalls, 2);
    await merged.return();
    await merged.return();
});
test("return() delivers already-fetched items before closing", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = mergeRoundRobin([a, b]);
    a.deliver("a0");
    b.deliver("b0");
    await tick();
    // Delivered items win the race against return().
    assert.deepEqual(await merged.return(), { value: "a0", done: false });
    assert.deepEqual(await merged.return(), { value: "b0", done: false });
    // Buffer drained: now the close actually happens.
    assert.deepEqual(await merged.return(), { value: undefined, done: true });
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1);
});
test("return() releases remaining in-flight prefetches", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = mergeRoundRobin([a, b]);
    a.deliver("a0");
    await tick();
    assert.equal(b.inFlight, 1);
    assert.deepEqual(await merged.return(), { value: "a0", done: false });
    const closing = merged.return();
    await tick();
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1, "b is released while its prefetch is in flight");
    // The released prefetch settles late; its item is discarded.
    b.deliver("b-late");
    assert.deepEqual(await closing, { value: undefined, done: true });
    assert.deepEqual(await merged.next(), { value: undefined, done: true });
});
test("concurrent duplicate return() closes every source exactly once", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const merged = mergeRoundRobin([a, b, c]);
    const results = await Promise.all([merged.return(), merged.return(), merged.return()]);
    assert.deepEqual(results, [
        { value: undefined, done: true },
        { value: undefined, done: true },
        { value: undefined, done: true },
    ]);
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1);
    assert.equal(c.returnCalls, 1);
    // Extra returns after the close are no-ops.
    await merged.return();
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1);
    assert.equal(c.returnCalls, 1);
});
test("a failing source is closed and reported while others keep flowing", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const c = new ControlledSource();
    const failures = [];
    const merged = mergeRoundRobin([a, b, c], {
        onSourceError: (failure) => failures.push(failure),
    });
    const boom = new Error("boom");
    a.deliver("a0");
    b.fail(boom);
    c.deliver("c0");
    await tick();
    assert.deepEqual(await merged.next(), { value: "a0", done: false });
    // Hitting b's slot closes only b, reports it, and moves on to c.
    assert.deepEqual(await merged.next(), { value: "c0", done: false });
    assert.deepEqual(failures, [{ index: 1, error: boom }]);
    assert.equal(b.returnCalls, 1, "the failed source is closed");
    assert.equal(a.returnCalls, 0, "healthy sources are left open");
    assert.equal(c.returnCalls, 0);
    a.deliver("a1");
    c.deliver("c1");
    assert.deepEqual(await merged.next(), { value: "a1", done: false });
    assert.deepEqual(await merged.next(), { value: "c1", done: false });
    a.end();
    c.end();
    assert.deepEqual(await merged.next(), { value: undefined, done: true });
    assert.equal(failures.length, 1, "the failure is reported exactly once");
    assert.equal(b.returnCalls, 1, "the failed source is never closed twice");
});
test("for-await with break closes every source exactly once", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = mergeRoundRobin([a, b]);
    a.deliver(1);
    const seen = [];
    for await (const value of merged) {
        seen.push(value);
        break;
    }
    await tick();
    assert.deepEqual(seen, [1]);
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1);
});
test("throw() on the merged iterator closes all sources and propagates", async () => {
    const a = new ControlledSource();
    const b = new ControlledSource();
    const merged = mergeRoundRobin([a, b]);
    const cause = new Error("consumer failed");
    await assert.rejects(merged.throw(cause), (error) => error === cause);
    assert.equal(a.returnCalls, 1);
    assert.equal(b.returnCalls, 1);
    assert.deepEqual(await merged.next(), { value: undefined, done: true });
});
