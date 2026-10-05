import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Network, observe, TickObservation } from "../src/model";

test("same-tick order: complete -> move -> start", () => {
  const net = new Network({
    desks: [
      { id: "A", inputCapacity: 2, outputCapacity: 2, serviceTime: 1 },
      { id: "B", inputCapacity: 2, outputCapacity: 2, serviceTime: 1 },
    ],
    edges: [{ from: "A", to: "B" }],
    sinks: ["B"],
    sources: [{ desk: "A", firstTick: 1, interval: 1, total: 1 }],
  });

  net.tick(); // tick 1: source injects, A starts service
  equal(net.deskState("A").server?.customer.id, 1);
  equal(net.deskState("B").server, null);

  net.tick(); // tick 2: A completes, customer moves A->B, B starts, same tick
  equal(net.deskState("A").server, null);
  equal(net.deskState("A").output.length, 0);
  equal(net.deskState("B").input.length, 0);
  equal(net.deskState("B").server?.customer.id, 1);
  equal(net.deskState("B").server?.remaining, 1);

  const history = net.deskState("B").server!.customer.history;
  deepEqual(history, [
    { desk: "A", serviceTime: 1, startedAt: 1, completedAt: 2 },
    { desk: "B", serviceTime: 1, startedAt: 2, completedAt: -1 },
  ]);

  net.tick(); // tick 3: B completes and drains to the sink
  equal(net.departedCustomers().length, 1);
  deepEqual(net.departedCustomers()[0]!.history.map((r) => r.completedAt), [2, 3]);
});

test("downstream full: upstream keeps its service slot occupied", () => {
  const net = new Network({
    desks: [
      { id: "A", inputCapacity: 4, outputCapacity: 1, serviceTime: 1 },
      { id: "B", inputCapacity: 1, outputCapacity: 1, serviceTime: 10 },
    ],
    edges: [{ from: "A", to: "B" }],
    sinks: ["B"],
    sources: [{ desk: "A", firstTick: 1, interval: 1, total: 5 }],
  });

  net.run(5);
  // B is busy with customer 1 for 10 ticks and its input holds customer 2,
  // so A's output queue (capacity 1) is stuck holding customer 3.
  const a = net.deskState("A");
  deepEqual(a.output.map((c) => c.id), [3]);
  // Customer 4 finished service but cannot unload: A keeps the slot.
  equal(a.server?.customer.id, 4);
  equal(a.server?.remaining, 0);
  equal(a.server?.blocked, true);

  net.tick();
  // Still blocked, and customer 5 waits in input: no new service starts
  // while the slot is retained.
  const a2 = net.deskState("A");
  equal(a2.server?.customer.id, 4);
  equal(a2.server?.blocked, true);
  deepEqual(a2.input.map((c) => c.id), [5]);

  net.run(60);
  // Eventually everything drains; service slots were never stolen.
  equal(net.customerCount(), 0);
  equal(net.departedCustomers().length, 5);
  const c4 = net.departedCustomers().find((c) => c.id === 4)!;
  const aRecord = c4.history.find((r) => r.desk === "A")!;
  equal(aRecord.serviceTime, 1);
  ok(aRecord.completedAt - aRecord.startedAt > 1, "customer 4 was held by blocking");
});

test("circular wait emerges under load and is reported with evidence", () => {
  const svc = (c: { id: number }) => 1 + ((2 * c.id) % 3);
  const net = new Network({
    desks: [
      { id: "A", inputCapacity: 2, outputCapacity: 1, serviceTime: svc },
      { id: "B", inputCapacity: 2, outputCapacity: 2, serviceTime: svc },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ],
    sources: [
      { desk: "A", firstTick: 1, interval: 1, total: 30 },
      { desk: "B", firstTick: 1, interval: 1, total: 30 },
    ],
  });

  let evidence = null;
  for (let i = 0; i < 50 && !evidence; i++) {
    net.tick();
    evidence = net.detectCircularWait();
  }
  ok(evidence, "expected a circular wait");
  equal(evidence!.cycle[0], evidence!.cycle[evidence!.cycle.length - 1]);
  equal(evidence!.cycle.length, 3); // A -> B -> A (or B -> A -> B)
  deepEqual([...new Set(evidence!.cycle)].sort(), ["A", "B"]);
  for (const edge of evidence!.edges) {
    ok(edge.waitingCustomerIds.length > 0);
    equal(edge.downstreamInputOccupancy, edge.downstreamInputCapacity);
  }
});

test("a fully wedged cycle is absorbing: evidence persists every tick", () => {
  const customer = (id: number) => ({ id, history: [] });
  const net = Network.fromSnapshot(
    {
      desks: [
        { id: "A", inputCapacity: 2, outputCapacity: 1, serviceTime: 1 },
        { id: "B", inputCapacity: 2, outputCapacity: 2, serviceTime: 1 },
      ],
      edges: [
        { from: "A", to: "B" },
        { from: "B", to: "A" },
      ],
    },
    {
      time: 10,
      nextCustomerId: 10,
      departed: [],
      sources: [],
      desks: {
        A: {
          input: [customer(1), customer(2)],
          server: { customer: customer(3), remaining: 0, blocked: true },
          output: [customer(4)],
        },
        B: {
          input: [customer(5), customer(6)],
          server: { customer: customer(7), remaining: 0, blocked: true },
          output: [customer(8), customer(9)],
        },
      },
    },
  );

  for (let i = 0; i < 10; i++) {
    const evidence = net.detectCircularWait();
    ok(evidence, `tick ${net.currentTime}: expected persistent circular wait`);
    deepEqual([...new Set(evidence!.cycle)].sort(), ["A", "B"]);
    const ab = evidence!.edges.find((e) => e.from === "A")!;
    deepEqual(ab.waitingCustomerIds, [4, 3]); // output queue + blocked server slot
    equal(net.customerCount(), 9); // nobody moves, nobody leaves
    net.tick();
  }
});

test("no false positive: open chain never reports circular wait", () => {
  const net = new Network({
    desks: [
      { id: "A", inputCapacity: 1, outputCapacity: 1, serviceTime: 1 },
      { id: "B", inputCapacity: 1, outputCapacity: 1, serviceTime: 3 },
    ],
    edges: [{ from: "A", to: "B" }],
    sinks: ["B"],
    sources: [{ desk: "A", firstTick: 1, interval: 1, total: 6 }],
  });
  net.run(40);
  equal(net.detectCircularWait(), null);
  equal(net.departedCustomers().length, 6);
});

test("snapshot replay matches the per-tick model: counts and service times", () => {
  const config = {
    desks: [
      {
        id: "A",
        inputCapacity: 3,
        outputCapacity: 1,
        serviceTime: (c: { id: number }) => 1 + ((c.id * 7) % 3),
      },
      {
        id: "B",
        inputCapacity: 2,
        outputCapacity: 1,
        serviceTime: (c: { id: number }) => 1 + ((c.id * 5) % 4),
      },
      { id: "C", inputCapacity: 2, outputCapacity: 2, serviceTime: 2 },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ],
    sinks: ["C"],
    sources: [{ desk: "A", firstTick: 1, interval: 1, total: 12 }],
  };

  const original = new Network(config);
  original.run(15);
  const snapshot = original.snapshot();

  const originalObs: TickObservation[] = [];
  for (let i = 0; i < 25; i++) {
    original.tick();
    originalObs.push(observe(original));
  }

  const replay = Network.fromSnapshot(config, snapshot);
  const replayObs: TickObservation[] = [];
  for (let i = 0; i < 25; i++) {
    replay.tick();
    replayObs.push(observe(replay));
  }

  deepEqual(replayObs, originalObs);
  // Snapshot is a deep copy: replaying must not disturb the original.
  equal(original.currentTime, 40);
  deepEqual(observe(original), originalObs[originalObs.length - 1]);
});

test("customer conservation holds at every tick", () => {
  const net = new Network({
    desks: [
      { id: "A", inputCapacity: 2, outputCapacity: 1, serviceTime: 2 },
      { id: "B", inputCapacity: 2, outputCapacity: 1, serviceTime: 1 },
    ],
    edges: [{ from: "A", to: "B" }],
    sinks: ["B"],
    sources: [{ desk: "A", firstTick: 1, interval: 2, total: 8 }],
  });
  for (let t = 0; t < 40; t++) {
    net.tick();
    const injected = Math.min(8, Math.floor((net.currentTime - 1) / 2) + 1);
    equal(
      net.customerCount() + net.departedCustomers().length,
      Math.max(0, injected),
      `tick ${net.currentTime}`,
    );
  }
});
