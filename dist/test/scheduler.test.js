import assert from 'node:assert/strict';
import test from 'node:test';
import { ClockBackwardError, NoPausedTickError, PausedTickError, ReentrantAdvanceError, Scheduler, } from '../src/index.js';
const labels = (entries) => entries.map((e) => e.label);
test('advance completes only I/O that is due', () => {
    const s = new Scheduler();
    s.scheduleAt(5, 'early', () => { });
    s.scheduleAt(10, 'edge', () => { });
    s.scheduleAt(15, 'late', () => { });
    const report = s.advanceTo(10);
    assert.deepEqual(labels(report.delivered), ['early', 'edge']);
    assert.equal(report.now, 10);
    assert.equal(report.exhausted, false);
    assert.equal(s.pendingCount, 1);
    const rest = s.advanceTo(15);
    assert.deepEqual(labels(rest.delivered), ['late']);
    assert.equal(s.now(), 15);
});
test('microtasks run in registration-id order, including late arrivals', () => {
    const s = new Scheduler();
    s.queueMicrotask('m1', () => {
        s.queueMicrotask('m4', () => { });
    });
    s.queueMicrotask('m2', () => { });
    s.queueMicrotask('m3', () => { });
    const report = s.advanceBy(0);
    assert.deepEqual(labels(report.delivered), ['m1', 'm2', 'm3', 'm4']);
    assert.deepEqual(report.delivered.map((e) => e.id), [1, 2, 3, 4]);
});
test('same-time events are appended to the tail of the queue', () => {
    const s = new Scheduler();
    s.scheduleAt(5, 'A', () => {
        s.scheduleAt(5, 'C', () => { }); // reentrant add lands behind everything at t=5
    });
    s.scheduleAt(5, 'B', () => { });
    s.scheduleAt(5, 'D', () => { });
    const report = s.advanceTo(5);
    assert.deepEqual(labels(report.delivered), ['A', 'B', 'D', 'C']);
});
test('microtasks drain after each I/O delivery', () => {
    const s = new Scheduler();
    s.scheduleAt(5, 'A', () => {
        s.queueMicrotask('micro-of-A', () => { });
    });
    s.scheduleAt(5, 'B', () => { });
    const report = s.advanceTo(5);
    assert.deepEqual(labels(report.delivered), ['A', 'micro-of-A', 'B']);
});
test('tick budget can be exceeded and the tick resumed', () => {
    const s = new Scheduler({ budget: 2 });
    for (const t of [1, 2, 3, 4]) {
        s.scheduleAt(t, `e${t}`, () => { });
    }
    const first = s.advanceTo(10);
    assert.equal(first.exhausted, true);
    assert.deepEqual(labels(first.delivered), ['e1', 'e2']);
    assert.equal(first.now, 2, 'clock stops at the last delivered event');
    assert.equal(s.paused, true);
    assert.throws(() => s.advanceTo(10), PausedTickError);
    const second = s.resume();
    assert.equal(second.exhausted, false);
    assert.deepEqual(labels(second.delivered), ['e3', 'e4']);
    assert.equal(second.now, 10, 'clock reaches the target once the tick finishes');
    assert.equal(s.paused, false);
    assert.throws(() => s.resume(), NoPausedTickError);
});
test('budget also bounds microtask delivery within a tick', () => {
    const s = new Scheduler({ budget: 1 });
    s.scheduleAt(0, 'io', () => {
        s.queueMicrotask('follow-up', () => { });
    });
    const first = s.advanceBy(0);
    assert.equal(first.exhausted, true);
    assert.deepEqual(labels(first.delivered), ['io']);
    const second = s.resume();
    assert.equal(second.exhausted, false);
    assert.deepEqual(labels(second.delivered), ['follow-up']);
});
test('the clock refuses to go backward', () => {
    const s = new Scheduler({ startTime: 10 });
    assert.throws(() => s.advanceTo(9), ClockBackwardError);
    assert.throws(() => s.advanceBy(-1), ClockBackwardError);
    assert.throws(() => s.scheduleAt(3, 'past', () => { }), ClockBackwardError);
    assert.throws(() => s.scheduleIn(-2, 'past', () => { }), ClockBackwardError);
    assert.equal(s.now(), 10);
    s.advanceTo(20);
    assert.throws(() => s.advanceTo(19), ClockBackwardError);
    s.advanceTo(20); // advancing to the current time is allowed
    assert.equal(s.now(), 20);
});
test('trace records logical time of every delivery and cancellation', () => {
    const s = new Scheduler();
    s.scheduleAt(2, 'two', () => { });
    const doomed = s.scheduleAt(4, 'four', () => { });
    s.scheduleAt(6, 'six', () => { });
    s.advanceTo(3);
    assert.equal(doomed.cancel(), true);
    const report = s.advanceTo(10);
    assert.deepEqual(labels(report.delivered), ['six']);
    const trace = s.trace();
    assert.deepEqual(trace.map((e) => [e.time, e.label, e.action]), [
        [2, 'two', 'delivered'],
        [3, 'four', 'cancelled'],
        [6, 'six', 'delivered'],
    ]);
    assert.deepEqual(trace.map((e) => e.seq), [0, 1, 2]);
});
test('cancelled events are skipped; cancel is idempotent and fails after delivery', () => {
    const s = new Scheduler();
    const a = s.scheduleAt(1, 'a', () => { });
    const b = s.scheduleAt(1, 'b', () => { });
    assert.equal(a.cancel(), true);
    assert.equal(a.cancel(), false, 'second cancel is a no-op');
    const report = s.advanceTo(1);
    assert.deepEqual(labels(report.delivered), ['b']);
    assert.equal(b.cancel(), false, 'cannot cancel after delivery');
    assert.equal(s.pendingCount, 0);
});
test('handlers may reentrantly schedule and cancel, but not advance', () => {
    const s = new Scheduler();
    const errors = [];
    let victim;
    s.scheduleAt(5, 'driver', () => {
        s.scheduleAt(7, 'reentrant-io', () => { });
        s.queueMicrotask('reentrant-micro', () => { });
        assert.equal(victim.cancel(), true);
        try {
            s.advanceTo(100);
        }
        catch (err) {
            errors.push(err);
        }
    });
    victim = s.scheduleAt(5, 'victim', () => { });
    const report = s.advanceTo(10);
    assert.deepEqual(labels(report.delivered), ['driver', 'reentrant-micro', 'reentrant-io']);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof ReentrantAdvanceError);
    assert.equal(s.now(), 10);
});
/**
 * List model: a naive reference implementation kept as a plain list. The
 * scenario below exercises cancellation and reentrant scheduling; the
 * scheduler's delivery trace must match the model exactly.
 */
class ListModel {
    now = 0;
    nextId = 1;
    pending = [];
    delivered = [];
    scheduleAt(time, label, run) {
        const id = this.nextId++;
        this.pending.push({ id, time, kind: 'io', label, cancelled: false, run });
        return id;
    }
    queueMicrotask(label, run) {
        const id = this.nextId++;
        this.pending.push({ id, time: this.now, kind: 'microtask', label, cancelled: false, run });
        return id;
    }
    cancel(id) {
        const e = this.pending.find((p) => p.id === id);
        if (e)
            e.cancelled = true;
    }
    #deliver(e) {
        this.pending.splice(this.pending.indexOf(e), 1);
        this.delivered.push({ time: this.now, id: e.id, label: e.label });
        e.run();
    }
    advanceTo(target) {
        for (;;) {
            const dueIo = this.pending
                .filter((p) => p.kind === 'io' && !p.cancelled && p.time <= target)
                .sort((a, b) => a.time - b.time || a.id - b.id)[0];
            if (dueIo) {
                this.now = dueIo.time;
                this.#deliver(dueIo);
                for (;;) {
                    const micro = this.pending.find((p) => p.kind === 'microtask' && !p.cancelled);
                    if (!micro)
                        break;
                    this.#deliver(micro);
                }
                continue;
            }
            const micro = this.pending.find((p) => p.kind === 'microtask' && !p.cancelled);
            if (micro) {
                this.#deliver(micro);
                continue;
            }
            break;
        }
        this.now = target;
    }
}
test('list model: cancellation and reentrancy match the scheduler', () => {
    const s = new Scheduler();
    const model = new ListModel();
    // One scenario script, instantiated once per implementation so every
    // callback reentrantly schedules on / cancels in its own scheduler.
    const scenario = (api) => {
        let cancelVictim = () => { };
        api.scheduleAt(3, 'A', () => {
            api.scheduleAt(3, 'D', () => { }); // reentrant same-time add -> tail
            api.queueMicrotask('M3', () => { });
            api.scheduleAt(9, 'G', () => { }); // future reentrant add within target
            cancelVictim(); // cancel a not-yet-delivered same-time event
        });
        const victim = api.scheduleAt(3, 'victim', () => {
            throw new Error('victim must have been cancelled');
        });
        cancelVictim = () => victim.cancel();
        api.scheduleAt(5, 'C', () => { });
        api.queueMicrotask('M1', () => { });
        api
            .queueMicrotask('M2', () => {
            throw new Error('M2 must have been cancelled');
        })
            .cancel();
    };
    scenario({
        scheduleAt: (t, l, r) => s.scheduleAt(t, l, r),
        queueMicrotask: (l, r) => s.queueMicrotask(l, r),
    });
    scenario({
        scheduleAt: (t, l, r) => {
            const id = model.scheduleAt(t, l, r);
            return { cancel: () => model.cancel(id) };
        },
        queueMicrotask: (l, r) => {
            const id = model.queueMicrotask(l, r);
            return { cancel: () => model.cancel(id) };
        },
    });
    s.advanceTo(10);
    model.advanceTo(10);
    const actual = s
        .trace()
        .filter((e) => e.action === 'delivered')
        .map((e) => ({ time: e.time, id: e.id, label: e.label }));
    assert.deepEqual(actual, model.delivered);
    assert.deepEqual(actual.map((e) => e.label), ['A', 'M1', 'M3', 'D', 'C', 'G'], 'scenario sanity check');
    assert.equal(s.now(), model.now);
});
