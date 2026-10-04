import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VersionedHub,
  type Delivery,
  type Subscription,
} from '../src/hub.js';

type State = string[];
type Ev = Delivery<State, string>;

function makeHub(options: {
  snapshot?: (state: State) => State | Promise<State>;
} = {}) {
  return new VersionedHub<State, string>({
    initialState: [],
    apply: (state, data) => [...state, data],
    snapshot: options.snapshot ?? ((s) => [...s]),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks + one macrotask round run. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Collects deliveries into an array. */
function collector(events: Ev[]) {
  return (d: Ev) => {
    events.push(d);
  };
}

/**
 * Asserts the observed stream never skips versions: every snapshot/resync
 * resets the expected version, and every increment is exactly expected+1.
 */
function assertContiguous(events: Ev[]): void {
  let next = -1;
  for (const e of events) {
    if (e.type === 'snapshot' || e.type === 'resync') {
      next = e.version + 1;
    } else if (e.type === 'increment') {
      assert.equal(
        e.version,
        next,
        `version gap: expected increment ${next}, got ${e.version}`,
      );
      next += 1;
    }
  }
}

test('snapshot is delivered first; increments published during the snapshot are buffered and contiguous', async () => {
  const gate = deferred<State>();
  const hub = makeHub({ snapshot: () => gate.promise });
  const events: Ev[] = [];
  hub.subscribe(collector(events));

  // Increments arrive while the snapshot Promise is still pending.
  hub.publish('a');
  hub.publish('b');
  await flush();
  assert.equal(events.length, 0, 'nothing may be delivered before the snapshot');

  gate.resolve(['a', 'b']);
  await flush();

  assert.deepEqual(
    events.map((e) => [e.type, e.type === 'closed' ? null : e.version]),
    [
      ['snapshot', 0],
      ['increment', 1],
      ['increment', 2],
    ],
  );
  assertContiguous(events);
  hub.close();
});

test('buffer overflow triggers an explicit resync instead of skipping versions', async () => {
  const hub = makeHub();
  const events: Ev[] = [];
  const release = deferred<void>();
  let blocked = true;
  // Slow client: the first increment blocks the handler until released.
  hub.subscribe(
    async (d) => {
      events.push(d);
      if (d.type === 'increment' && blocked) {
        blocked = false;
        await release.promise;
      }
    },
    { bufferSize: 2 },
  );
  await flush(); // snapshot delivered

  hub.publish('u1');
  await flush(); // u1 now in flight, handler blocked
  hub.publish('u2');
  hub.publish('u3'); // queue full: [u2, u3]
  await flush();
  assert.equal(
    events.filter((e) => e.type === 'resync').length,
    0,
    'no resync before overflow',
  );

  hub.publish('u4'); // overflow: drops u2/u3, schedules explicit resync
  release.resolve();
  hub.publish('u5');
  await flush();

  const resyncs = events.filter((e) => e.type === 'resync');
  assert.equal(resyncs.length, 1, 'overflow must produce exactly one explicit resync');
  assert.equal(resyncs[0]!.type === 'resync' && resyncs[0]!.version, 4);
  assert.deepEqual(
    events.map((e) => e.type),
    ['snapshot', 'increment', 'resync', 'increment'],
  );
  assertContiguous(events);
  hub.close();
});

test('close() interleaved with a pending snapshot Promise does not resurrect the subscription', async () => {
  const gate = deferred<State>();
  const hub = makeHub({ snapshot: () => gate.promise });
  const events: Ev[] = [];
  const sub = hub.subscribe(collector(events));

  hub.publish('x');
  sub.close('test-close');
  assert.equal(hub.subscriberCount, 0);

  // Snapshot Promise resolves after close: must be dropped.
  gate.resolve(['x']);
  hub.publish('y');
  await flush();

  assert.deepEqual(
    events.map((e) => e.type),
    ['closed'],
    'only the closed notification may be observed',
  );
  hub.close();
});

test('hub.close() while a snapshot Promise is pending prevents any delivery', async () => {
  const gate = deferred<State>();
  const hub = makeHub({ snapshot: () => gate.promise });
  const events: Ev[] = [];
  hub.subscribe(collector(events));

  hub.close();
  gate.resolve([]);
  await flush();

  assert.deepEqual(
    events.map((e) => e.type),
    ['closed'],
  );
});

test('reentrant publish from inside a handler stays ordered and contiguous', async () => {
  const hub = makeHub();
  const events: Ev[] = [];
  let fired = false;
  hub.subscribe((d) => {
    events.push(d);
    if (!fired && d.type === 'increment' && d.data === 'trigger') {
      fired = true;
      hub.publish('reentrant'); // reentrant update inside the delivery loop
    }
  });
  await flush();

  hub.publish('trigger');
  await flush();

  assert.deepEqual(
    events.map((e) => [e.type, e.type === 'increment' ? e.data : null]),
    [
      ['snapshot', null],
      ['increment', 'trigger'],
      ['increment', 'reentrant'],
    ],
  );
  assertContiguous(events);
  hub.close();
});

test('reentrant close from inside a handler stops further deliveries', async () => {
  const hub = makeHub();
  const events: Ev[] = [];
  let sub!: Subscription;
  sub = hub.subscribe((d) => {
    events.push(d);
    if (d.type === 'increment') sub.close('enough');
  });
  await flush();

  hub.publish('one');
  hub.publish('two');
  await flush();

  assert.deepEqual(
    events.map((e) => e.type),
    ['snapshot', 'increment', 'closed'],
  );
  assert.equal(hub.subscriberCount, 0);
  hub.close();
});

test('slow client resyncs while a fast client on the same hub is unaffected', async () => {
  const hub = makeHub();
  const slowEvents: Ev[] = [];
  const fastEvents: Ev[] = [];
  const release = deferred<void>();
  let blocked = true;

  hub.subscribe(
    async (d) => {
      slowEvents.push(d);
      if (d.type === 'increment' && blocked) {
        blocked = false;
        await release.promise;
      }
    },
    { bufferSize: 1 },
  );
  hub.subscribe(collector(fastEvents), { bufferSize: 100 });
  await flush();

  hub.publish('m1');
  await flush(); // slow handler now blocked on m1
  for (const m of ['m2', 'm3', 'm4', 'm5']) hub.publish(m);
  await flush();

  // Fast client saw everything, contiguously, with no resync.
  assert.deepEqual(
    fastEvents.map((e) => e.type),
    ['snapshot', 'increment', 'increment', 'increment', 'increment', 'increment'],
  );
  assertContiguous(fastEvents);

  release.resolve();
  hub.publish('m6');
  await flush();

  // Slow client overflowed and got explicit resync(s), still contiguous.
  assert.ok(slowEvents.some((e) => e.type === 'resync'));
  assertContiguous(slowEvents);
  assertContiguous(fastEvents);
  hub.close();
});

test('publish after hub.close() throws and closed subscriptions stay silent', async () => {
  const hub = makeHub();
  const events: Ev[] = [];
  hub.subscribe(collector(events));
  await flush();
  hub.publish('before');
  await flush();
  hub.close();
  assert.throws(() => hub.publish('after'));
  await flush();
  assert.deepEqual(
    events.map((e) => e.type),
    ['snapshot', 'increment', 'closed'],
  );
});
