import { ProblemInput } from "../src/index";

/** mulberry32 确定性伪随机数发生器 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInput(
  seed: number,
  orderCount: number,
  vehicleCount: number,
): ProblemInput {
  const rand = rng(seed);
  const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const points = ri(4, 8);
  const travelTime: number[][] = [];
  for (let i = 0; i < points; i++) {
    const row: number[] = [];
    for (let j = 0; j < points; j++) row.push(i === j ? 0 : ri(1, 15));
    travelTime.push(row);
  }
  const vehicles = Array.from({ length: vehicleCount }, (_, k) => ({
    id: `V${k}`,
    startPoint: ri(0, points - 1),
    availableTime: ri(0, 10),
  }));
  const orders = Array.from({ length: orderCount }, (_, k) => {
    const pickup = ri(0, points - 1);
    let delivery = ri(0, points - 1);
    if (delivery === pickup) delivery = (delivery + 1) % points;
    const readyTime = ri(0, 30);
    const serviceTime = ri(0, 5);
    // 截止时间：部分订单宽裕、部分紧张、部分可能不可行
    const slack = ri(0, 3) === 0 ? ri(0, 4) : ri(10, 60);
    const deadline = readyTime + serviceTime + travelTime[pickup][delivery] + slack;
    return { id: `O${k}`, pickup, delivery, readyTime, deadline, serviceTime, revenue: ri(5, 40) };
  });
  return {
    points,
    travelTime,
    emptyCostPerUnitTime: ri(0, 3),
    vehicles,
    orders,
  };
}
