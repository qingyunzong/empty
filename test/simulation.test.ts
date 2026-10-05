import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, verifyReplay } from "../src/index.js";
import type { SimConfig, SimResult, TickSnapshot } from "../src/index.js";

function snap(result: SimResult, tick: number): TickSnapshot {
  const snapshot = result.snapshots[tick];
  assert.ok(snapshot, `missing snapshot at tick ${tick}`);
  return snapshot;
}

function vehicleEnergy(result: SimResult, tick: number, id: string): number {
  const vehicle = snap(result, tick).vehicles.find((item) => item.id === id);
  assert.ok(vehicle, `missing vehicle ${id} at tick ${tick}`);
  return vehicle.energy;
}

test("移动按整数能耗扣减电量", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "B", energy: 3 },
      { from: "B", to: "C", energy: 4 },
    ],
    vehicles: [{ id: "v1", path: ["A", "B", "C"], initialEnergy: 10, batteryCapacity: 10 }],
    stations: [],
    maxTicks: 4,
  };
  const result = simulate(config);
  assert.equal(vehicleEnergy(result, 0, "v1"), 7);
  assert.equal(vehicleEnergy(result, 1, "v1"), 3);
  assert.equal(snap(result, 1).vehicles[0]?.status, "done");
  assert.equal(vehicleEnergy(result, 3, "v1"), 3);
  assert.equal(verifyReplay(result).ok, true);
});

test("同 tick 先到达再充电授予", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "B", energy: 2 },
      { from: "B", to: "C", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "B", "C"], initialEnergy: 4, batteryCapacity: 12, chargeStops: ["B"] },
    ],
    stations: [{ node: "B", capacity: 1, chargePerTick: 5, windows: [[0, 10]] }],
    maxTicks: 6,
  };
  const result = simulate(config);
  const tick0 = snap(result, 0);
  assert.equal(tick0.vehicles[0]?.node, "B");
  assert.equal(tick0.vehicles[0]?.energy, 7);
  const kinds = result.ledger.filter((entry) => entry.tick === 0).map((entry) => entry.kind);
  assert.deepEqual(kinds, ["move", "charge"]);
  assert.equal(verifyReplay(result).ok, true);
});

test("充电占位容量限制与排队等待耗辅助能量", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "S", energy: 1 },
      { from: "B", to: "S", energy: 1 },
      { from: "S", to: "Z", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "S", "Z"], initialEnergy: 2, batteryCapacity: 3, chargeStops: ["S"] },
      { id: "v2", path: ["B", "S", "Z"], initialEnergy: 6, batteryCapacity: 8, chargeStops: ["S"], auxDrainPerTick: 2 },
    ],
    stations: [{ node: "S", capacity: 1, chargePerTick: 2, windows: [[0, 10]] }],
    maxTicks: 8,
  };
  const result = simulate(config);
  const tick0 = snap(result, 0);
  assert.deepEqual(tick0.stations[0]?.granted, ["v1"]);
  assert.equal(vehicleEnergy(result, 0, "v1"), 3);
  assert.equal(vehicleEnergy(result, 0, "v2"), 3);
  const tick1 = snap(result, 1);
  assert.deepEqual(tick1.stations[0]?.granted, ["v2"]);
  assert.equal(vehicleEnergy(result, 1, "v2"), 5);
  assert.equal(verifyReplay(result).ok, true);
});

test("电量不足可停不能继续走且电量不为负", () => {
  const config: SimConfig = {
    edges: [{ from: "A", to: "B", energy: 5 }],
    vehicles: [
      { id: "stuck", path: ["A", "B"], initialEnergy: 2, batteryCapacity: 10 },
      { id: "zero", path: ["A", "B"], initialEnergy: 0, batteryCapacity: 10 },
    ],
    stations: [],
    maxTicks: 5,
  };
  const result = simulate(config);
  for (let tick = 0; tick < 5; tick += 1) {
    assert.equal(vehicleEnergy(result, tick, "stuck"), 2);
    assert.equal(vehicleEnergy(result, tick, "zero"), 0);
    assert.equal(snap(result, tick).vehicles[0]?.status, "stranded");
    assert.equal(snap(result, tick).vehicles[0]?.node, "A");
  }
  assert.equal(result.ledger.length, 0);
  assert.equal(verifyReplay(result).ok, true);
});

test("等待辅助能耗在 0 处截断不为负", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "S", energy: 1 },
      { from: "S", to: "Z", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "S", "Z"], initialEnergy: 3, batteryCapacity: 9, chargeStops: ["S"], auxDrainPerTick: 5 },
    ],
    stations: [{ node: "S", capacity: 1, chargePerTick: 1, windows: [[4, 6]] }],
    maxTicks: 4,
  };
  const result = simulate(config);
  assert.equal(vehicleEnergy(result, 0, "v1"), 0);
  assert.equal(vehicleEnergy(result, 3, "v1"), 0);
  assert.equal(verifyReplay(result).ok, true);
});

test("充电时段窗口外不授予", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "S", energy: 1 },
      { from: "S", to: "Z", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "S", "Z"], initialEnergy: 2, batteryCapacity: 6, chargeStops: ["S"] },
    ],
    stations: [{ node: "S", capacity: 1, chargePerTick: 2, windows: [[3, 5]] }],
    maxTicks: 6,
  };
  const result = simulate(config);
  assert.equal(vehicleEnergy(result, 0, "v1"), 1);
  assert.equal(vehicleEnergy(result, 2, "v1"), 1);
  assert.equal(snap(result, 0).stations[0]?.open, false);
  assert.equal(vehicleEnergy(result, 3, "v1"), 3);
  assert.equal(vehicleEnergy(result, 4, "v1"), 5);
  assert.equal(verifyReplay(result).ok, true);
});

test("充电不超过电池容量上限", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "S", energy: 1 },
      { from: "S", to: "Z", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "S", "Z"], initialEnergy: 5, batteryCapacity: 6, chargeStops: ["S"] },
    ],
    stations: [{ node: "S", capacity: 1, chargePerTick: 5, windows: [[0, 10]] }],
    maxTicks: 4,
  };
  const result = simulate(config);
  assert.equal(vehicleEnergy(result, 0, "v1"), 6);
  const charge = result.ledger.find((entry) => entry.kind === "charge");
  assert.equal(charge?.delta, 2);
  assert.equal(snap(result, 0).vehicles[0]?.status, "ready");
  assert.equal(verifyReplay(result).ok, true);
});

test("快照重放核对能量账：篡改快照或台账会被发现", () => {
  const config: SimConfig = {
    edges: [
      { from: "A", to: "S", energy: 2 },
      { from: "S", to: "Z", energy: 1 },
    ],
    vehicles: [
      { id: "v1", path: ["A", "S", "Z"], initialEnergy: 4, batteryCapacity: 10, chargeStops: ["S"], auxDrainPerTick: 1 },
      { id: "v2", path: ["A", "S", "Z"], initialEnergy: 3, batteryCapacity: 10, chargeStops: ["S"], auxDrainPerTick: 1 },
    ],
    stations: [{ node: "S", capacity: 1, chargePerTick: 3, windows: [[0, 8]] }],
    maxTicks: 8,
  };
  const result = simulate(config);
  assert.equal(verifyReplay(result).ok, true);

  const tamperedSnap: SimResult = structuredClone(result);
  const tamperedVehicle = tamperedSnap.snapshots[2]?.vehicles[0];
  assert.ok(tamperedVehicle);
  tamperedVehicle.energy += 1;
  const reportSnap = verifyReplay(tamperedSnap);
  assert.equal(reportSnap.ok, false);
  assert.ok(reportSnap.errors.some((message) => message.includes("snapshot energy")));

  const tamperedLedger: SimResult = structuredClone(result);
  const moveEntry = tamperedLedger.ledger.find((entry) => entry.kind === "move");
  assert.ok(moveEntry);
  moveEntry.delta = -99;
  moveEntry.after = moveEntry.before - 99;
  const reportLedger = verifyReplay(tamperedLedger);
  assert.equal(reportLedger.ok, false);
  assert.ok(reportLedger.errors.some((message) => message.includes("negative energy")));
});

test("非法配置被拒绝", () => {
  const base: SimConfig = {
    edges: [{ from: "A", to: "B", energy: 1 }],
    vehicles: [{ id: "v1", path: ["A", "B"], initialEnergy: 1, batteryCapacity: 2 }],
    stations: [],
    maxTicks: 2,
  };
  assert.throws(() => simulate({ ...base, maxTicks: 0 }));
  assert.throws(() => simulate({ ...base, edges: [{ from: "A", to: "B", energy: 1.5 }] }));
  assert.throws(() =>
    simulate({ ...base, vehicles: [{ id: "v1", path: ["A", "B"], initialEnergy: 5, batteryCapacity: 2 }] }),
  );
  assert.throws(() =>
    simulate({
      ...base,
      vehicles: [{ id: "v1", path: ["A", "B"], initialEnergy: 1, batteryCapacity: 2, chargeStops: ["B"] }],
    }),
  );
});
