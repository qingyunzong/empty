"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const observable_store_js_1 = require("../src/observable-store.js");
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
/** Flushes the microtask queue (notification delivery happens on microtasks). */
async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}
(0, node_test_1.test)("commit is synchronous, notification is asynchronous", async () => {
    const store = new observable_store_js_1.ObservableStore(0);
    const seen = [];
    store.subscribe((s) => {
        seen.push(s.value);
    });
    const version = store.set(42);
    strict_1.default.equal(version, 1);
    strict_1.default.equal(store.getState(), 42, "state is committed synchronously");
    strict_1.default.equal(store.getVersion(), 1);
    strict_1.default.deepEqual(seen, [], "observer is not notified synchronously");
    await flushMicrotasks();
    strict_1.default.deepEqual(seen, [42], "observer is notified asynchronously");
    await store.close();
});
(0, node_test_1.test)("observer exception does not roll back state or block other observers", async () => {
    const errors = [];
    const store = new observable_store_js_1.ObservableStore(0, {
        onObserverError: (e) => errors.push(e),
    });
    const boom = new Error("observer blew up");
    store.subscribe(() => {
        throw boom;
    });
    const seen = [];
    store.subscribe((s) => {
        seen.push(s.value);
    });
    store.set(7);
    await flushMicrotasks();
    strict_1.default.equal(store.getState(), 7, "committed state is kept");
    strict_1.default.deepEqual(seen, [7], "other observers are still notified");
    strict_1.default.deepEqual(errors, [boom], "error is routed to onObserverError");
    // The store keeps working after an observer failure.
    store.set(8);
    await flushMicrotasks();
    strict_1.default.equal(store.getState(), 8);
    strict_1.default.deepEqual(seen, [7, 8]);
    await store.close();
});
(0, node_test_1.test)("rejecting async observer is treated like a throwing observer", async () => {
    const errors = [];
    const store = new observable_store_js_1.ObservableStore(0, {
        onObserverError: (e) => errors.push(e),
    });
    const boom = new Error("async failure");
    store.subscribe(async () => {
        throw boom;
    });
    store.set(1);
    await flushMicrotasks();
    strict_1.default.equal(store.getState(), 1);
    strict_1.default.deepEqual(errors, [boom]);
    await store.close();
});
(0, node_test_1.test)("slow observer receives only the latest version with the skipped range", async () => {
    const store = new observable_store_js_1.ObservableStore(0);
    const gate = deferred();
    let firstCall = true;
    const snapshots = [];
    store.subscribe(async (s) => {
        snapshots.push(s);
        if (firstCall) {
            firstCall = false;
            await gate.promise; // block the first callback while more commits land
        }
    });
    store.set(1);
    await flushMicrotasks(); // first notification is now in-flight and blocked
    store.set(2);
    store.set(3);
    store.set(4);
    await flushMicrotasks();
    strict_1.default.equal(snapshots.length, 1, "still blocked on the first callback");
    gate.resolve();
    await flushMicrotasks();
    strict_1.default.equal(snapshots.length, 2, "intermediate versions are coalesced");
    strict_1.default.equal(snapshots[0].version, 1);
    strict_1.default.equal(snapshots[0].skipped, null);
    strict_1.default.equal(snapshots[1].value, 4, "only the latest version is delivered");
    strict_1.default.equal(snapshots[1].version, 4);
    strict_1.default.deepEqual(snapshots[1].skipped, { from: 2, to: 3 }, "skipped range covers the superseded versions");
    await store.close();
});
(0, node_test_1.test)("unsubscribe waits for the in-flight callback to finish", async () => {
    const store = new observable_store_js_1.ObservableStore(0);
    const gate = deferred();
    const events = [];
    const sub = store.subscribe(async () => {
        events.push("callback:start");
        await gate.promise;
        events.push("callback:end");
    });
    store.set(1);
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["callback:start"], "callback is in-flight");
    let unsubscribed = false;
    const done = sub.unsubscribe().then(() => {
        unsubscribed = true;
    });
    strict_1.default.equal(sub.closed, true);
    await flushMicrotasks();
    strict_1.default.equal(unsubscribed, false, "unsubscribe waits for the callback");
    gate.resolve();
    await done;
    strict_1.default.equal(unsubscribed, true);
    strict_1.default.deepEqual(events, ["callback:start", "callback:end"]);
    store.set(2);
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["callback:start", "callback:end"], "no more notifications");
    await store.close();
});
(0, node_test_1.test)("reentrant update inside an observer is serialized, not nested", async () => {
    const store = new observable_store_js_1.ObservableStore(0);
    const gate = deferred();
    const events = [];
    let reentered = false;
    store.subscribe(async (s) => {
        events.push(`enter:${s.version}`);
        if (!reentered) {
            reentered = true;
            await gate.promise; // hold the first callback, then update reentrantly
            store.update((n) => n + 1);
        }
        events.push(`exit:${s.version}`);
    });
    store.set(1);
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["enter:1"]);
    gate.resolve();
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["enter:1", "exit:1", "enter:2", "exit:2"], "reentrant commit is delivered after the current callback completes");
    strict_1.default.equal(store.getState(), 2);
    strict_1.default.equal(store.getVersion(), 2);
    await store.close();
});
(0, node_test_1.test)("close waits for in-flight callbacks and no notifications happen afterwards", async () => {
    const store = new observable_store_js_1.ObservableStore(0);
    const gate = deferred();
    const events = [];
    store.subscribe(async (s) => {
        events.push(`enter:${s.version}`);
        await gate.promise;
        events.push(`exit:${s.version}`);
    });
    store.set(1);
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["enter:1"], "callback is in-flight");
    store.set(2); // pending notification that must be dropped by close()
    let closed = false;
    const closing = store.close().then(() => {
        closed = true;
    });
    await flushMicrotasks();
    strict_1.default.equal(closed, false, "close waits for the in-flight callback");
    strict_1.default.equal(store.closed, true);
    gate.resolve();
    await closing;
    strict_1.default.equal(closed, true);
    strict_1.default.deepEqual(events, ["enter:1", "exit:1"], "pending notification for version 2 is never delivered");
    strict_1.default.throws(() => store.set(3), /closed/);
    strict_1.default.throws(() => store.subscribe(() => undefined), /closed/);
    await flushMicrotasks();
    strict_1.default.deepEqual(events, ["enter:1", "exit:1"], "no notifications after close");
});
(0, node_test_1.test)("update computes from the latest committed state", async () => {
    const store = new observable_store_js_1.ObservableStore(10);
    store.update((n) => n + 5);
    store.update((n) => n * 2);
    strict_1.default.equal(store.getState(), 30);
    strict_1.default.equal(store.getVersion(), 2);
    await store.close();
});
