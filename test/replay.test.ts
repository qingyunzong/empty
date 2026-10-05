import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation, auditReplay, computeLedger } from "../src/index.js";
import type { SimConfig, TickSnapshot } from "../src/index.js";

function fleetConfig(): SimConfig {
  return {
    maxTicks: 60,
    recordHistory: true,
    chargers: [
      {
        id: "c1",
        node: "Hub",
        capacity: 1,
        ratePerTick: 3,
        windows: [{ start: 0, end: 20 }],
      },
      {
        id: "c2",
        node: "Depot",
        capacity: 2,
        ratePerTick: 5,
        windows: [{ start: 10, end: 30 }],
      },
    ],
    vehicles: [
      {
        id: "v1",
        startNode: "A",
        path: [
          { to: "Hub", ticks: 2, energy: 4 },
          { to: "Depot", ticks: 2, energy: 6 },
        ],
        batteryCapacity: 30,
        initialBattery: 20,
        chargePlan: [{ node: "Hub", targetBattery: 26 }],
        auxDrainPerTick: 1,
      },
      {
        id: "v2",
        startNode: "Hub",
        path: [{ to: "Depot", ticks: 3, energy: 3 }],
        batteryCapacity: 25,
        initialBattery: 8,
        chargePlan: [
          { node: "Hub", targetBattery: 20 },
          { node: "Depot", targetBattery: 25 },
        ],
        auxDrainPerTick: 2,
      },
      {
        id: "v3",
        startNode: "Depot",
        path: [],
        batteryCapacity: 10,
        initialBattery: 10,
      },
    ],
  };
}

test("snapshot restore replays to an identical trace and event log", () => {
  const config = fleetConfig();
  const sim1 = new Simulation(config);
  for (let i = 0; i < 7; i += 1) sim1.step();
  const snap = sim1.snapshot();
  sim1.run();

  const sim2 = new Simulation(config);
  sim2.restore(snap);
  sim2.run();

  // Event logs (including the restored prefix) must be identical.
  assert.deepEqual([...sim2.eventLog], [...sim1.eventLog]);
  // Battery/state trace from the restore point onward must match.
  const tail = sim1.history.slice(7);
  assert.deepEqual([...sim2.history], [...tail]);
  assert.deepEqual(sim2.vehicleSnapshots(), sim1.vehicleSnapshots());
});

test("two fresh runs of the same config are fully deterministic", () => {
  const a = new Simulation(fleetConfig());
  const b = new Simulation(fleetConfig());
  a.run();
  b.run();
  assert.deepEqual([...a.eventLog], [...b.eventLog]);
  assert.deepEqual([...a.history], [...b.history]);
});

test("event-log replay reproduces every snapshot and the ledger balances", () => {
  const config = fleetConfig();
  const sim = new Simulation(config);
  sim.run();
  const audit = auditReplay(config, sim.eventLog, sim.history);
  assert.deepEqual(audit.failures, []);
  assert.equal(audit.ok, true);

  const ledgers = computeLedger(config, sim.eventLog, sim.history);
  assert.equal(ledgers.length, 3);
  for (const l of ledgers) {
    assert.equal(
      l.initialBattery + l.charged - l.driveConsumed - l.auxConsumed,
      l.finalBattery,
      `ledger for ${l.vehicleId}`,
    );
    assert.equal(l.balanced, true);
  }
  // Sanity: the scenario actually exercised all three event kinds.
  const kinds = new Set(sim.eventLog.map((e) => e.type));
  assert.deepEqual([...kinds].sort(), ["aux", "charge", "drive"]);
});

test("audit flags a tampered negative battery in the history", () => {
  const config = fleetConfig();
  const sim = new Simulation(config);
  sim.run();
  const tampered: TickSnapshot[] = sim.history.map((s) => ({
    tick: s.tick,
    vehicles: s.vehicles.map((v) => ({ ...v })),
  }));
  const frame = tampered[3];
  const vehicle = frame?.vehicles[0];
  assert.ok(frame && vehicle);
  vehicle.battery = -1;
  const audit = auditReplay(config, sim.eventLog, tampered);
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((f) => f.includes("negative battery")));
});

test("audit flags a tampered event log (energy created out of thin air)", () => {
  const config = fleetConfig();
  const sim = new Simulation(config);
  sim.run();
  const events = sim.eventLog.filter((e) => e.type !== "charge");
  const audit = auditReplay(config, events, sim.history);
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.length > 0);
});
