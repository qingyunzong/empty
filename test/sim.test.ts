import test from "node:test";
import * as assert from "node:assert/strict";
import { Simulation, type SimConfig } from "../src/sim.js";

function makeSim(overrides?: Partial<SimConfig>): Simulation {
  return new Simulation({
    buffers: [
      { id: "raw", capacity: 100, initial: { iron: 10 } },
      { id: "product", capacity: 3 },
    ],
    machines: [
      {
        id: "press",
        recipe: { inputs: { iron: 2 }, outputs: { plate: 1 }, duration: 2 },
        inputBuffer: "raw",
        outputBuffer: "product",
      },
    ],
    ...overrides,
  });
}

test("机器消耗输入并按工期产出", () => {
  const sim = makeSim();
  const r1 = sim.step(); // tick1: 开工，消耗 2 iron
  assert.deepEqual(r1.events.map((e) => e.type), ["start"]);
  assert.equal(r1.snapshot.buffers["raw"]!.stock["iron"], 8);
  assert.deepEqual(r1.snapshot.machines[0]!.wip, { iron: 2 });

  const r2 = sim.step(); // tick2: 进度 1/2，无事件
  assert.equal(r2.events.length, 0);

  const r3 = sim.step(); // tick3: 完工 -> 入库 -> 再开工
  assert.deepEqual(r3.events.map((e) => e.type), ["complete", "store", "start"]);
  assert.equal(r3.snapshot.buffers["product"]!.stock["plate"], 1);
  assert.equal(r3.snapshot.buffers["raw"]!.stock["iron"], 6);
});

test("同 tick 顺序为完工 -> 入库 -> 开工", () => {
  const sim = makeSim();
  sim.run(3);
  // duration=2：奇数 tick 开工，偶数 tick 无事件，第3 tick 完工+入库+开工
  const types = sim.eventLog.map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(types, ["1:start", "3:complete", "3:store", "3:start"]);
});

test("输出仓满则持成品阻塞，机器不释放、不提前开工", () => {
  const sim = makeSim({
    buffers: [
      { id: "raw", capacity: 100, initial: { iron: 10 } },
      { id: "product", capacity: 1 }, // 只能放 1 件
    ],
  });
  sim.run(3); // 产出第 1 件 plate 并入库，仓库已满
  assert.equal(sim.snapshot().buffers["product"]!.used, 1);

  const r = sim.run(3); // 第 2 件完工时仓库满 -> blocked
  const blocked = r.flatMap((x) => x.events).filter((e) => e.type === "blocked");
  assert.ok(blocked.length >= 1, "应出现 blocked 事件");

  const snap = sim.snapshot();
  const machine = snap.machines[0]!;
  assert.equal(machine.state, "holding"); // 机器持成品阻塞
  assert.deepEqual(machine.held, { plate: 1 }); // 成品仍在机器上
  assert.equal(snap.buffers["product"]!.stock["plate"], 1); // 未入库
  // 阻塞期间不能再开工消耗原料
  assert.equal(snap.buffers["raw"]!.stock["iron"], 6);

  // 腾出空间后，下一 tick 入库并恢复开工
  sim.removeStock("product", { plate: 1 });
  const after = sim.step();
  assert.deepEqual(after.events.map((e) => e.type), ["store", "start"]);
  assert.equal(after.snapshot.buffers["product"]!.stock["plate"], 1);
});

test("故障在加工中暂停，修复后续行，进度不丢失", () => {
  const sim = makeSim();
  sim.step(); // tick1: 开工
  sim.step(); // tick2: 进度 1/2
  sim.injectFault("press", 2); // 停机 2 tick
  const r3 = sim.step(); // tick3: 故障中，进度冻结
  assert.equal(r3.snapshot.machines[0]!.progress, 1);
  assert.equal(r3.snapshot.machines[0]!.faultRemaining, 1);
  const r4 = sim.step(); // tick4: 修复完成，但本 tick 仍处于停机
  assert.equal(r4.events.filter((e) => e.type === "repaired").length, 1);
  assert.equal(r4.snapshot.machines[0]!.progress, 1);
  const r5 = sim.step(); // tick5: 续行，进度 2/2 完工并入库
  assert.deepEqual(r5.events.map((e) => e.type), ["complete", "store", "start"]);
  assert.equal(r5.snapshot.buffers["product"]!.stock["plate"], 1);
});

test("故障发生在持成品阻塞期间，修复后才能入库", () => {
  const sim = makeSim({
    buffers: [
      { id: "raw", capacity: 100, initial: { iron: 10 } },
      { id: "product", capacity: 1 },
    ],
  });
  sim.run(6); // 进入 blocked 状态
  assert.equal(sim.snapshot().machines[0]!.state, "holding");
  sim.removeStock("product", { plate: 1 });
  sim.injectFault("press", 1); // 阻塞中故障：本可入库也被暂停
  const r = sim.step();
  assert.equal(r.events.filter((e) => e.type === "store").length, 0);
  const r2 = sim.step(); // 修复后入库
  assert.deepEqual(r2.events.map((e) => e.type), ["store", "start"]);
});

test("逐 tick 物料守恒：多机产线含投料、取料、故障、阻塞", () => {
  const sim = new Simulation({
    buffers: [
      { id: "raw", capacity: 50, initial: { iron: 20, coal: 10 } },
      { id: "mid", capacity: 4 },
      { id: "final", capacity: 2 },
    ],
    machines: [
      {
        id: "smelter",
        recipe: { inputs: { iron: 2, coal: 1 }, outputs: { steel: 1 }, duration: 3 },
        inputBuffer: "raw",
        outputBuffer: "mid",
      },
      {
        id: "roller",
        recipe: { inputs: { steel: 1 }, outputs: { sheet: 1 }, duration: 2 },
        inputBuffer: "mid",
        outputBuffer: "final",
      },
    ],
  });

  const reports = [];
  for (let i = 0; i < 30; i++) {
    if (i === 5) sim.addStock("raw", { iron: 6, coal: 3 });
    if (i === 8) sim.injectFault("smelter", 3);
    if (i === 12) sim.injectFault("roller", 2);
    if (i === 15) sim.removeStock("final", { sheet: 1 });
    if (i === 20) sim.addStock("raw", { iron: 4 });
    reports.push(sim.step());
  }

  for (const r of reports) {
    assert.ok(r.conservation.ok, `tick ${r.tick} 物料不守恒: ${JSON.stringify(r.conservation)}`);
  }
  // 确认场景确实覆盖了阻塞与故障
  const types = new Set(sim.eventLog.map((e) => e.type));
  for (const t of ["start", "complete", "store", "blocked", "fault", "repaired", "add", "remove"]) {
    assert.ok(types.has(t as never), `事件日志缺少 ${t}`);
  }
});

test("事件快照可还原每 tick 的库存与机器状态", () => {
  const sim = makeSim();
  const reports = sim.run(6);
  // 每个 report 的快照 tick 与编号一致，且总量守恒
  reports.forEach((r, i) => {
    assert.equal(r.snapshot.tick, i + 1);
    assert.ok(r.conservation.ok);
  });
  // 末态：3 次开工共消耗 6 iron（buffer 剩 4，其中 2 为在制），产出 plate 2 件
  const snap = reports[5]!.snapshot;
  assert.equal(snap.buffers["raw"]!.stock["iron"], 4);
  assert.equal(snap.buffers["product"]!.stock["plate"], 2);
  assert.deepEqual(snap.totals, { iron: 6, plate: 2 });
});

test("输入不足时机器保持空闲", () => {
  const sim = makeSim({
    buffers: [
      { id: "raw", capacity: 100, initial: { iron: 1 } }, // 不够一份
      { id: "product", capacity: 3 },
    ],
  });
  const r = sim.step();
  assert.equal(r.events.length, 0);
  assert.equal(r.snapshot.machines[0]!.state, "idle");
});
