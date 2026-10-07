import { test } from "node:test";
import assert from "node:assert/strict";
import { Saga, SagaError, CancelledError } from "../src/saga.js";
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
async function rejection(promise) {
    try {
        await promise;
    }
    catch (err) {
        assert.ok(err instanceof SagaError, "expected SagaError");
        return err;
    }
    assert.ok(false, "expected promise to reject");
}
function tracker(events) {
    return (name) => ({
        async run() {
            events.push(`run:${name}`);
        },
        async compensate() {
            events.push(`undo:${name}`);
        },
    });
}
test("happy path: steps run in dependency order, no compensation", async () => {
    const events = [];
    const saga = new Saga([
        { id: "a", ...tracker(events)("a") },
        { id: "b", dependsOn: ["a"], ...tracker(events)("b") },
        { id: "c", dependsOn: ["b"], ...tracker(events)("c") },
    ]);
    await saga.execute();
    assert.deepEqual(events, ["run:a", "run:b", "run:c"]);
});
test("failure: only succeeded compensable steps compensated, reverse dependency order", async () => {
    const events = [];
    const saga = new Saga([
        { id: "a", ...tracker(events)("a") },
        { id: "b", dependsOn: ["a"], ...tracker(events)("b") },
        {
            id: "c",
            dependsOn: ["b"],
            async run() {
                events.push("run:c");
                throw new Error("boom");
            },
            async compensate() {
                events.push("undo:c");
            },
        },
        { id: "d", dependsOn: ["c"], ...tracker(events)("d") },
    ]);
    // step without compensate must be skipped silently during rollback
    const noComp = tracker(events)("e");
    noComp.compensate = undefined;
    const err = await rejection(saga.execute());
    assert.equal(err.compensationErrors.length, 0);
    assert.match(err.message, /rollback completed/);
    assert.deepEqual(events, ["run:a", "run:b", "run:c", "undo:b", "undo:a"]);
});
test("compensation failures are aggregated, not reported as successful rollback", async () => {
    const events = [];
    const saga = new Saga([
        {
            id: "a",
            async run() {
                events.push("run:a");
            },
            async compensate() {
                events.push("undo:a");
                throw new Error("undo-a failed");
            },
        },
        {
            id: "b",
            dependsOn: ["a"],
            async run() {
                events.push("run:b");
            },
            async compensate() {
                events.push("undo:b");
                throw new Error("undo-b failed");
            },
        },
        {
            id: "c",
            dependsOn: ["b"],
            async run() {
                throw new Error("run-c failed");
            },
        },
    ]);
    const err = await rejection(saga.execute());
    // remaining compensations still attempted, in reverse order, despite failures
    assert.deepEqual(events, ["run:a", "run:b", "undo:b", "undo:a"]);
    assert.equal(err.compensationErrors.length, 2);
    assert.deepEqual(err.compensationErrors.map((e) => e.message), ["undo-b failed", "undo-a failed"]);
    assert.match(err.message, /rollback incomplete: 2 compensation\(s\) failed/);
    assert.ok(err.cause.message.includes("run-c failed"));
});
test("cancellation triggers the same compensation rules", async () => {
    const events = [];
    const gate = deferred();
    const saga = new Saga([
        { id: "a", ...tracker(events)("a") },
        {
            id: "b",
            dependsOn: ["a"],
            async run() {
                events.push("run:b");
                await gate.promise;
            },
            async compensate() {
                events.push("undo:b");
            },
        },
        { id: "c", dependsOn: ["b"], ...tracker(events)("c") },
    ]);
    const executing = saga.execute();
    await Promise.resolve();
    saga.cancel();
    gate.resolve();
    const err = await rejection(executing);
    assert.ok(err.cause instanceof CancelledError);
    // c never ran; only a and b compensated, reverse order
    assert.deepEqual(events, ["run:a", "run:b", "undo:b", "undo:a"]);
});
test("controlled promises: enumeration order verified exactly once", async () => {
    const events = [];
    const gates = {
        a: deferred(),
        b: deferred(),
        undoB: deferred(),
    };
    const step = (name, gate) => ({
        id: name,
        dependsOn: name === "a" ? [] : [name === "b" ? "a" : "b"],
        async run() {
            events.push(`run:${name}`);
            await gate?.promise;
        },
        async compensate() {
            events.push(`undo:${name}`);
            if (name === "b")
                await gates.undoB.promise;
        },
    });
    const saga = new Saga([step("a", gates.a), step("b", gates.b), step("c")]);
    const executing = saga.execute();
    await Promise.resolve();
    assert.deepEqual(events, ["run:a"]); // b must not start before a resolves
    gates.a.resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, ["run:a", "run:b"]);
    saga.cancel();
    gates.b.resolve();
    await new Promise((r) => setImmediate(r));
    // rollback started with b; a waits until b's compensation resolves
    assert.deepEqual(events, ["run:a", "run:b", "undo:b"]);
    gates.undoB.resolve();
    const err = await rejection(executing);
    assert.ok(err.cause instanceof CancelledError);
    // one-time verification of the complete enumeration sequence
    assert.deepEqual(events, ["run:a", "run:b", "undo:b", "undo:a"]);
});
test("invalid graphs are rejected", () => {
    assert.throws(() => new Saga([{ id: "a", run() { } }, { id: "a", run() { } }]), /duplicate step id/);
    assert.throws(() => new Saga([{ id: "a", dependsOn: ["ghost"], run() { } }]), /unknown step/);
    assert.throws(() => new Saga([
        { id: "a", dependsOn: ["b"], run() { } },
        { id: "b", dependsOn: ["a"], run() { } },
    ]), /cycle/);
});
