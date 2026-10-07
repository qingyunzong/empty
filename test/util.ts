import type { PublishedOrder, WarehouseInput } from "../src/types.js";
import { solveWarehouse } from "../src/solver.js";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export interface RandOpts {
  horizon: number;
  maxCap: number;
  maxDemand: number;
  maxLead: number;
  twoChannels: boolean;
}

export function randomWarehouse(rng: () => number, o: RandOpts): WarehouseInput {
  const capacity = randInt(rng, 2, o.maxCap);
  const stdLead = randInt(rng, 0, o.maxLead);
  const stdFixed = randInt(rng, 2, 25);
  const channels = [{ name: "standard", leadTime: stdLead, fixedCost: stdFixed }];
  if (o.twoChannels && rng() < 0.7) {
    const expLead = randInt(rng, 0, stdLead);
    channels.push({
      name: "expedited",
      leadTime: expLead,
      fixedCost: stdFixed + randInt(rng, 3, 30),
    });
  }
  return {
    id: "RND",
    capacity,
    initialInventory: randInt(rng, 0, capacity),
    holdingCost: randInt(rng, 0, 3),
    demand: Array.from({ length: o.horizon }, () => randInt(rng, 0, o.maxDemand)),
    channels,
  };
}

/**
 * 构造重规划场景：先按原需求求新计划并公布其订单（随机锁定部分），
 * 再扰动需求。可选追加一个在途订单（到货日 < 提前期）。
 */
export function makeReplanCase(
  rng: () => number,
  o: RandOpts,
): { wh: WarehouseInput; horizon: number } {
  const base = randomWarehouse(rng, o);
  const plan = solveWarehouse(base, o.horizon, false);
  const published: PublishedOrder[] = [];
  if (plan) {
    for (const ord of plan.orders) {
      if (rng() < 0.8) {
        published.push({
          day: ord.day,
          channel: ord.channel,
          qty: ord.qty,
          locked: randInt(rng, 0, ord.qty),
        });
      }
    }
  }
  // 偶发在途订单：到货日小于渠道提前期，只能撤不能增
  if (rng() < 0.5 && base.channels.length > 0) {
    const ci = randInt(rng, 0, base.channels.length - 1);
    const ch = base.channels[ci]!;
    if (ch.leadTime > 0) {
      const day = randInt(rng, 0, Math.min(ch.leadTime - 1, o.horizon - 1));
      const qty = randInt(rng, 1, Math.max(1, Math.floor(base.capacity / 2)));
      published.push({ day, channel: ch.name, qty, locked: randInt(rng, 0, qty) });
    }
  }
  const demand = base.demand.map((d) =>
    Math.max(0, Math.min(o.maxDemand + 2, d + randInt(rng, -2, 2))),
  );
  return { wh: { ...base, demand, published }, horizon: o.horizon };
}
