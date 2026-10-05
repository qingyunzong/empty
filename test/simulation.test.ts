import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation, legTickCost } from "../src/index.js";
import type { SimConfig } from "../src/index.js";

test("leg energy is spread as integers summing to the leg total", () => {
  const leg = { to: "B", ticks: 3, energy: 7 };
  const costs = [0, 1, 2].map((p) => legTickCost(leg, p));
  assert.deepEqual(costs, [3, 2, 2]);
  assert.equal(costs.reduce((a, b) => a + b, 0), 7);
});

test("vehicle follows its fixed path with exact integer energy drain", () => {
  const config: SimConfig = {
    maxTicks: 50,
    recordHistory: true,
    chargers: [],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [
          { to: "B", ticks: 3, energy: 7 },
          { to: "C", ticks: 2, energy: 4 },
        ],
        batteryCapacity: 100,
        initialBattery: 100,
      },
    ],
  };
  const sim = new Simulation(config);
  const ticks = sim.run();
  assert.equal(ticks, 5);
  const final = sim.vehicleSnapshots()[0];
  assert.ok(final);
  assert.equal(final.node, "C");
  assert.equal(final.state, "done");
  assert.equal(final.battery, 89); // 100 - 7 - 4
  const driveSum = sim.eventLog
    .filter((e) => e.type === "drive")
    .reduce((a, e) => a + e.amount, 0);
  assert.equal(driveSum, 11);
});

test("battery 0: vehicle may stop but cannot keep driving, never negative", () => {
  const config: SimConfig = {
    maxTicks: 20,
    recordHistory: true,
    chargers: [],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [{ to: "B", ticks: 2, energy: 4 }], // 2 per tick
        batteryCapacity: 10,
        initialBattery: 2,
      },
    ],
  };
  const sim = new Simulation(config);
  sim.run();
  const v = sim.vehicleSnapshots()[0];
  assert.ok(v);
  assert.equal(v.state, "stalled");
  assert.equal(v.battery, 0);
  assert.equal(v.legProgress, 1); // stopped mid-leg
  for (const snap of sim.history) {
    for (const vs of snap.vehicles) {
      assert.ok(vs.battery >= 0, `negative battery at tick ${snap.tick}`);
    }
  }
});

test("insufficient battery for the integer tick cost also stalls without going negative", () => {
  const config: SimConfig = {
    maxTicks: 20,
    chargers: [],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [{ to: "B", ticks: 2, energy: 4 }],
        batteryCapacity: 10,
        initialBattery: 3,
      },
    ],
  };
  const sim = new Simulation(config);
  sim.run();
  const v = sim.vehicleSnapshots()[0];
  assert.ok(v);
  assert.equal(v.state, "stalled");
  assert.equal(v.battery, 1); // 3 - 2, cannot pay the next 2
});

test("arrival and charging grant happen in the same tick (arrival first)", () => {
  const config: SimConfig = {
    maxTicks: 100,
    chargers: [
      {
        id: "c1",
        node: "B",
        capacity: 1,
        ratePerTick: 5,
        windows: [{ start: 0, end: 100 }],
      },
    ],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [{ to: "B", ticks: 2, energy: 0 }],
        batteryCapacity: 40,
        initialBattery: 10,
        chargePlan: [{ node: "B", targetBattery: 20 }],
      },
    ],
  };
  const sim = new Simulation(config);
  const ticks = sim.run();
  // Charges during ticks 1-2; the slot is released on the following tick.
  assert.equal(ticks, 4);
  const chargeTicks = sim.eventLog
    .filter((e) => e.type === "charge")
    .map((e) => e.tick);
  // Arrives during tick 1 and is granted a slot in that same tick.
  assert.deepEqual(chargeTicks, [1, 2]);
  const v = sim.vehicleSnapshots()[0];
  assert.ok(v);
  assert.equal(v.battery, 20);
  assert.equal(v.state, "done");
});

test("occupancy capacity: FIFO queue, waiting drains auxiliary energy", () => {
  const config: SimConfig = {
    maxTicks: 50,
    recordHistory: true,
    chargers: [
      {
        id: "c1",
        node: "S",
        capacity: 1,
        ratePerTick: 2,
        windows: [{ start: 0, end: 50 }],
      },
    ],
    vehicles: [
      {
        id: "v1",
        startNode: "S",
        path: [],
        batteryCapacity: 20,
        initialBattery: 10,
        chargePlan: [{ node: "S", targetBattery: 16 }],
      },
      {
        id: "v2",
        startNode: "S",
        path: [],
        batteryCapacity: 20,
        initialBattery: 10,
        chargePlan: [{ node: "S", targetBattery: 16 }],
        auxDrainPerTick: 3,
      },
    ],
  };
  const sim = new Simulation(config);
  sim.run();
  const firstCharge = (id: string) =>
    sim.eventLog.find((e) => e.type === "charge" && e.vehicleId === id)?.tick;
  assert.equal(firstCharge("v1"), 0); // FIFO: v1 holds the single slot first
  assert.equal(firstCharge("v2"), 3); // v2 waits 3 ticks, then takes the slot
  const aux = sim.eventLog
    .filter((e) => e.type === "aux" && e.vehicleId === "v2")
    .reduce((a, e) => a + e.amount, 0);
  assert.equal(aux, 9); // 3 ticks * 3 aux drain while queued
  const snaps = sim.vehicleSnapshots();
  assert.equal(snaps.find((s) => s.id === "v1")?.battery, 16);
  assert.equal(snaps.find((s) => s.id === "v2")?.battery, 16);
});

test("charger windows: no grant outside operating hours, aux drain clamps at 0", () => {
  const config: SimConfig = {
    maxTicks: 30,
    recordHistory: true,
    chargers: [
      {
        id: "c1",
        node: "S",
        capacity: 1,
        ratePerTick: 4,
        windows: [{ start: 5, end: 10 }],
      },
    ],
    vehicles: [
      {
        id: "v1",
        startNode: "S",
        path: [],
        batteryCapacity: 20,
        initialBattery: 2,
        chargePlan: [{ node: "S", targetBattery: 10 }],
        auxDrainPerTick: 5,
      },
    ],
  };
  const sim = new Simulation(config);
  sim.run();
  const chargeTicks = sim.eventLog
    .filter((e) => e.type === "charge")
    .map((e) => e.tick);
  assert.deepEqual(chargeTicks, [5, 6, 7]); // nothing before the window opens
  const aux = sim.eventLog
    .filter((e) => e.type === "aux")
    .reduce((a, e) => a + e.amount, 0);
  assert.equal(aux, 2); // drain clamped: only 2 available, never negative
  const v = sim.vehicleSnapshots()[0];
  assert.ok(v);
  assert.equal(v.battery, 10);
  for (const snap of sim.history) {
    for (const vs of snap.vehicles) {
      assert.ok(vs.battery >= 0, `negative battery at tick ${snap.tick}`);
    }
  }
});

test("invalid configs are rejected", () => {
  const base: SimConfig = {
    maxTicks: 10,
    chargers: [],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [],
        batteryCapacity: 10,
        initialBattery: 5,
      },
    ],
  };
  assert.throws(
    () =>
      new Simulation({
        ...base,
        vehicles: [
          ...base.vehicles,
          { id: "v1", startNode: "A", path: [], batteryCapacity: 1, initialBattery: 0 },
        ],
      }),
  );
  assert.throws(
    () =>
      new Simulation({
        ...base,
        vehicles: [
          {
            id: "v2",
            startNode: "A",
            path: [],
            batteryCapacity: 10,
            initialBattery: 5,
            chargePlan: [{ node: "nowhere", targetBattery: 9 }],
          },
        ],
      }),
  );
});
