import { test } from "node:test";
import assert from "node:assert";
import { Network } from "../src/network.js";

// 同 tick 顺序：先完成 -> 再移动 -> 再开工。
// A customer finishing at A in tick t must be movable to B in tick t and
// must be able to start service at B in the same tick t.
test("same tick: complete -> move -> start", () => {
  const net = new Network({
    seed: 1,
    stations: [
      { id: "A", queueCapacity: 4, servers: 1, serviceMin: 1, serviceMax: 1 },
      { id: "B", queueCapacity: 4, servers: 1, serviceMin: 1, serviceMax: 1 },
    ],
  });

  const id = net.inject(["A", "B"]);
  assert.equal(id, 1);

  const e1 = net.step();
  assert.deepEqual(e1.completed, []);
  assert.deepEqual(e1.moved, []);
  assert.deepEqual(e1.started, [{ customerId: 1, stationId: "A", duration: 1 }]);

  const e2 = net.step();
  // all three phases observed within tick 2, in the documented order
  assert.deepEqual(e2.completed, [{ customerId: 1, stationId: "A" }]);
  assert.deepEqual(e2.moved, [{ customerId: 1, from: "A", to: "B" }]);
  assert.deepEqual(e2.started, [{ customerId: 1, stationId: "B", duration: 1 }]);

  const log = net.getServiceLog();
  assert.equal(log.length, 2);
  // end of service at A and start of service at B share the same tick
  assert.deepEqual(log[0], {
    customerId: 1,
    stationId: "A",
    duration: 1,
    startTick: 1,
    endTick: 2,
  });
  assert.deepEqual(log[1], {
    customerId: 1,
    stationId: "B",
    duration: 1,
    startTick: 2,
    endTick: null,
  });

  const e3 = net.step();
  assert.deepEqual(e3.completed, [{ customerId: 1, stationId: "B" }]);
  assert.deepEqual(e3.departed, [{ customerId: 1, stationId: "B" }]);
  assert.equal(net.customerCount(), 0);
  assert.equal(net.departed, 1);
});
