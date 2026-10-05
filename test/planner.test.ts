import test from "node:test";
import assert from "node:assert/strict";
import {
  JourneyPlanner,
  type Itinerary,
  type Trip,
} from "../src/planner.js";
import { enumerateBest } from "../src/enumerate.js";

function trip(id: string, stops: Array<[string, number, number]>): Trip {
  return {
    id,
    stops: stops.map(([station, arrival, departure]) => ({
      station,
      arrival,
      departure,
    })),
  };
}

function legSummary(it: Itinerary | null): unknown {
  if (it === null) return null;
  return {
    arrival: it.arrival,
    transfers: it.transfers,
    legs: it.legs.map((l) => [l.tripId, l.from, l.to, l.depart, l.arrive]),
  };
}

test("基本直达查询：按绝对分钟返回最早到达", () => {
  const planner = new JourneyPlanner([
    trip("T1", [["A", 600, 600], ["B", 660, 660]]),
    trip("T2", [["A", 620, 620], ["B", 650, 650]]),
  ]);
  const result = planner.query("A", "B", 590);
  assert.deepEqual(legSummary(result), {
    arrival: 650,
    transfers: 0,
    legs: [["T2", "A", "B", 620, 650]],
  });
  // 晚于所有班次出发则不可达
  assert.equal(planner.query("A", "B", 621), null);
});

test("换乘须满足站内最低时间（全局与按站覆盖）", () => {
  const trips = [
    trip("T1", [["A", 600, 600], ["B", 660, 660]]),
    trip("T2", [["B", 664, 664], ["C", 700, 700]]), // 间隔 4 分钟
    trip("T3", [["B", 670, 670], ["C", 710, 710]]), // 间隔 10 分钟
  ];
  // 全局最低换乘 5 分钟：T2 太紧，只能接 T3
  const p1 = new JourneyPlanner(trips, { minTransfer: 5 });
  assert.deepEqual(legSummary(p1.query("A", "C", 0)), {
    arrival: 710,
    transfers: 1,
    legs: [
      ["T1", "A", "B", 600, 660],
      ["T3", "B", "C", 670, 710],
    ],
  });
  // 按站覆盖：B 站最低换乘 3 分钟，可以接 T2
  const p2 = new JourneyPlanner(trips, {
    minTransfer: 5,
    stationMinTransfer: { B: 3 },
  });
  assert.deepEqual(legSummary(p2.query("A", "C", 0)), {
    arrival: 700,
    transfers: 1,
    legs: [
      ["T1", "A", "B", 600, 660],
      ["T2", "B", "C", 664, 700],
    ],
  });
  // 出发站不收换乘时间：从 B 出发、最低换乘 99 也能坐上 664 的 T2
  const p3 = new JourneyPlanner(trips, { minTransfer: 99 });
  assert.equal(p3.query("B", "C", 660)?.arrival, 700);
});

test("边界值：出发/换乘时间恰好等于下限即允许", () => {
  const planner = new JourneyPlanner(
    [
      trip("T1", [["A", 600, 605], ["B", 660, 660]]),
      trip("T2", [["B", 665, 665], ["C", 700, 700]]),
    ],
    { minTransfer: 5 },
  );
  // departAfter 恰好等于出发时间：可上车
  assert.equal(planner.query("A", "B", 605)?.arrival, 660);
  // 到达 660 + 最低换乘 5 = 665，恰好可换乘
  assert.equal(planner.query("A", "C", 0)?.arrival, 700);
  // 起终点相同：空行程，到达即 departAfter
  assert.deepEqual(planner.query("A", "A", 123), {
    legs: [],
    arrival: 123,
    transfers: 0,
  });
});

test("跨午夜使用绝对分钟：1435 -> 1470，不会被次日凌晨 30 分混淆", () => {
  const planner = new JourneyPlanner([
    trip("NIGHT", [["A", 1435, 1435], ["B", 1470, 1470]]), // 23:55 -> 次日 00:30
    trip("EARLY", [["A", 30, 30], ["B", 65, 65]]),          // 当日 00:30，绝对更早
  ]);
  // 出发时刻 1430：可坐上 1435 的 NIGHT；30 分的 EARLY 绝对时间已过，不可选
  const result = planner.query("A", "B", 1430);
  assert.deepEqual(legSummary(result), {
    arrival: 1470,
    transfers: 0,
    legs: [["NIGHT", "A", "B", 1435, 1470]],
  });
  // 出发时刻 20：当日 00:30 的 EARLY 绝对时间更早，先于昨夜班次到达
  assert.equal(planner.query("A", "B", 20)?.arrival, 65);
  // 跨午夜换乘：到达 1470，接 1480 的班次
  const p2 = new JourneyPlanner([
    trip("NIGHT", [["A", 1435, 1435], ["B", 1470, 1470]]),
    trip("AFTER", [["B", 1480, 1480], ["C", 1520, 1520]]),
  ], { minTransfer: 5 });
  assert.equal(p2.query("A", "C", 1430)?.arrival, 1520);
});

test("最多换乘 3 次：恰好 3 次可达，需要 4 次则不可达", () => {
  // 链式网络 A->B->C->D->E，每段一个班次
  const chain = [
    trip("L1", [["A", 100, 100], ["B", 200, 200]]),
    trip("L2", [["B", 210, 210], ["C", 300, 300]]),
    trip("L3", [["C", 310, 310], ["D", 400, 400]]),
    trip("L4", [["D", 410, 410], ["E", 500, 500]]),
  ];
  const planner = new JourneyPlanner(chain, { minTransfer: 5 });
  // A->D 需换乘 2 次，可达
  assert.equal(planner.query("A", "D", 0)?.transfers, 2);
  // A->E 需换乘 3 次，恰好在上限内
  const ok = planner.query("A", "E", 0);
  assert.equal(ok?.transfers, 3);
  assert.equal(ok?.arrival, 500);
  // 再接一段需 4 次换乘，超出上限
  const longer = new JourneyPlanner(
    [...chain, trip("L5", [["E", 510, 510], ["F", 600, 600]])],
    { minTransfer: 5 },
  );
  assert.equal(longer.query("A", "F", 0), null);
  // 放宽到 4 次则可达
  const relaxed = new JourneyPlanner(
    [...chain, trip("L5", [["E", 510, 510], ["F", 600, 600]])],
    { minTransfer: 5, maxTransfers: 4 },
  );
  assert.equal(relaxed.query("A", "F", 0)?.arrival, 600);
});

test("选路优先级：到达早 > 换乘少 > 班次 ID 序", () => {
  // 到达早优先于换乘少：1 次换乘 700 到，胜过直达 750 到
  const p1 = new JourneyPlanner([
    trip("SLOW", [["A", 600, 600], ["C", 750, 750]]),
    trip("F1", [["A", 600, 600], ["B", 650, 650]]),
    trip("F2", [["B", 655, 655], ["C", 700, 700]]),
  ]);
  assert.equal(p1.query("A", "C", 0)?.transfers, 1);
  assert.equal(p1.query("A", "C", 0)?.arrival, 700);

  // 换乘少优先于班次 ID 序：同到达 700，直达胜过换乘（即使换乘班次 ID 更小）
  const p2 = new JourneyPlanner([
    trip("Z9", [["A", 600, 600], ["C", 700, 700]]),
    trip("A1", [["A", 600, 600], ["B", 640, 640]]),
    trip("A2", [["B", 645, 645], ["C", 700, 700]]),
  ]);
  assert.deepEqual(p2.query("A", "C", 0)?.legs.map((l) => l.tripId), ["Z9"]);

  // 班次 ID 序决胜：两条同为 1 次换乘、同到达 700 的路线，选 ID 序列更小者
  const p3 = new JourneyPlanner([
    trip("M2", [["A", 600, 600], ["B", 650, 650]]),
    trip("M1", [["A", 600, 600], ["B", 650, 650]]),
    trip("N1", [["B", 660, 660], ["C", 700, 700]]),
  ]);
  assert.deepEqual(p3.query("A", "C", 0)?.legs.map((l) => l.tripId), ["M1", "N1"]);
});

test("取消班次后重查：结果同步更新，可恢复", () => {
  const planner = new JourneyPlanner([
    trip("T1", [["A", 600, 600], ["B", 660, 660]]),
    trip("T2", [["A", 610, 610], ["B", 680, 680]]),
    trip("T3", [["A", 600, 600], ["C", 630, 630]]),
    trip("T4", [["C", 640, 640], ["B", 690, 690]]),
  ]);
  assert.equal(planner.query("A", "B", 0)?.legs[0]?.tripId, "T1");
  // 取消最优班次后重查，落到次优直达 T2
  assert.equal(planner.cancelTrip("T1"), true);
  assert.equal(planner.cancelTrip("T1"), false); // 重复取消返回 false
  assert.equal(planner.query("A", "B", 0)?.legs[0]?.tripId, "T2");
  // 再取消 T2，只剩换乘路线 T3->T4
  planner.cancelTrip("T2");
  const viaC = planner.query("A", "B", 0);
  assert.deepEqual(viaC?.legs.map((l) => l.tripId), ["T3", "T4"]);
  assert.equal(viaC?.transfers, 1);
  // 全部取消后不可达
  planner.cancelTrip("T3");
  planner.cancelTrip("T4");
  assert.equal(planner.query("A", "B", 0), null);
  assert.deepEqual(planner.cancelledTripIds(), ["T1", "T2", "T3", "T4"]);
  // 恢复后重新可达
  assert.equal(planner.restoreTrip("T1"), true);
  assert.equal(planner.query("A", "B", 0)?.legs[0]?.tripId, "T1");
});

test("输入校验：非整数分钟、时间不单调、重复 ID 均报错", () => {
  assert.throws(
    () => new JourneyPlanner([trip("X", [["A", 600.5, 600.5], ["B", 660, 660]])]),
    /非负整数/,
  );
  assert.throws(
    () => new JourneyPlanner([trip("X", [["A", 600, 600], ["B", 590, 590]])]),
    /单调不减/,
  );
  assert.throws(
    () =>
      new JourneyPlanner([
        trip("X", [["A", 1, 1], ["B", 2, 2]]),
        trip("X", [["A", 3, 3], ["B", 4, 4]]),
      ]),
    /重复/,
  );
  const planner = new JourneyPlanner([trip("X", [["A", 1, 1], ["B", 2, 2]])]);
  assert.throws(() => planner.query("A", "B", -1), /非负整数/);
});

// ---- 随机化对照：主算法 vs 全路径枚举（含取消班次后重查） ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNetwork(rand: () => number): {
  trips: Trip[];
  stations: string[];
  minTransfer: number;
  stationMinTransfer: Record<string, number>;
} {
  const stationCount = 4 + Math.floor(rand() * 3); // 4..6 个车站
  const stations = Array.from({ length: stationCount }, (_, i) => `S${i}`);
  const tripCount = 6 + Math.floor(rand() * 9); // 6..14 个班次
  const trips: Trip[] = [];
  for (let i = 0; i < tripCount; i++) {
    const stopCount = 2 + Math.floor(rand() * 4); // 2..5 个停靠点
    const shuffled = [...stations].sort(() => rand() - 0.5).slice(0, stopCount);
    let clock = Math.floor(rand() * 1800); // 覆盖跨午夜区间
    const stops = shuffled.map((station) => {
      const arrival = clock;
      const departure = arrival + Math.floor(rand() * 6); // 停站 0..5 分钟
      clock = departure + 5 + Math.floor(rand() * 56); // 区间运行 5..60 分钟
      return { station, arrival, departure };
    });
    trips.push({ id: `T${String(i).padStart(2, "0")}`, stops });
  }
  const minTransfer = Math.floor(rand() * 11); // 0..10 分钟
  const stationMinTransfer: Record<string, number> = {};
  for (const station of stations) {
    if (rand() < 0.3) stationMinTransfer[station] = Math.floor(rand() * 16);
  }
  return { trips, stations, minTransfer, stationMinTransfer };
}

function assertFeasible(
  it: Itinerary,
  activeTrips: Trip[],
  options: { maxTransfers: number; minTransfer: number; stationMinTransfer: Record<string, number> },
  from: string,
  to: string,
  departAfter: number,
): void {
  const byId = new Map(activeTrips.map((t) => [t.id, t]));
  let prevArrive = -1;
  let prevStation = from;
  it.legs.forEach((leg, i) => {
    const t = byId.get(leg.tripId);
    assert.ok(t, `行程使用了已取消或不存在的班次 ${leg.tripId}`);
    const boardIdx = t.stops.findIndex(
      (s) => s.station === leg.from && s.departure === leg.depart,
    );
    assert.ok(boardIdx >= 0, `班次 ${leg.tripId} 在 ${leg.from} 无 ${leg.depart} 的出发`);
    const alightIdx = t.stops.findIndex(
      (s, idx) => idx > boardIdx && s.station === leg.to && s.arrival === leg.arrive,
    );
    assert.ok(alightIdx > boardIdx, `班次 ${leg.tripId} 无法在 ${leg.arrive} 到达 ${leg.to}`);
    assert.equal(leg.from, prevStation, "行程段不连续");
    if (i === 0) {
      assert.ok(leg.depart >= departAfter, "首段出发早于 departAfter");
    } else {
      const min = options.stationMinTransfer[leg.from] ?? options.minTransfer;
      assert.ok(leg.depart >= prevArrive + min, `在 ${leg.from} 换乘时间不足 ${min} 分钟`);
    }
    prevArrive = leg.arrive;
    prevStation = leg.to;
  });
  assert.equal(prevStation, to, "行程未到达目的地");
  assert.equal(it.arrival, prevArrive);
  assert.equal(it.transfers, it.legs.length - 1);
  assert.ok(it.transfers <= options.maxTransfers, "超出换乘次数上限");
}

test("随机网络与全路径枚举对照：取消班次前后多轮查询", () => {
  const SCENARIOS = 500;
  const QUERIES_PER_ROUND = 3;
  let checked = 0;
  let reachable = 0;

  const checkQuery = (
    planner: JourneyPlanner,
    active: Trip[],
    options: { maxTransfers: number; minTransfer: number; stationMinTransfer: Record<string, number> },
    stations: string[],
    rand: () => number,
    tag: string,
  ): void => {
    const from = stations[Math.floor(rand() * stations.length)]!;
    let to = stations[Math.floor(rand() * stations.length)]!;
    if (to === from) to = stations[(stations.indexOf(from) + 1) % stations.length]!;
    const departAfter = Math.floor(rand() * 1500);

    const expected = enumerateBest(active, options, from, to, departAfter);
    const actual = planner.query(from, to, departAfter);
    assert.deepEqual(
      legSummary(actual),
      legSummary(expected),
      `${tag} 主算法与枚举不一致 (from=${from} to=${to} departAfter=${departAfter})`,
    );
    if (actual !== null) {
      reachable++;
      assertFeasible(actual, active, options, from, to, departAfter);
    }
    checked++;
  };

  for (let scenario = 0; scenario < SCENARIOS; scenario++) {
    const rand = mulberry32(20261006 + scenario);
    const { trips, stations, minTransfer, stationMinTransfer } = randomNetwork(rand);
    const options = {
      maxTransfers: 2 + Math.floor(rand() * 3), // 2..4，覆盖默认上限 3 的邻域
      minTransfer,
      stationMinTransfer,
    };
    const planner = new JourneyPlanner(trips, options);

    // 取消前：多轮查询对照
    for (let q = 0; q < QUERIES_PER_ROUND; q++) {
      checkQuery(planner, trips, options, stations, rand, `场景 ${scenario}（取消前）`);
    }

    // 随机取消 0..3 个班次后重查，与枚举对照（枚举作用于生效班次）
    const cancelCount = Math.floor(rand() * 4);
    const cancelled: string[] = [];
    for (let k = 0; k < cancelCount; k++) {
      const victim = trips[Math.floor(rand() * trips.length)]!;
      if (planner.cancelTrip(victim.id)) cancelled.push(victim.id);
    }
    const active = trips.filter((t) => !cancelled.includes(t.id));
    for (let q = 0; q < QUERIES_PER_ROUND; q++) {
      checkQuery(
        planner,
        active,
        options,
        stations,
        rand,
        `场景 ${scenario}（取消 ${cancelled.join(",") || "无"} 后）`,
      );
    }
  }
  assert.equal(checked, SCENARIOS * QUERIES_PER_ROUND * 2);
  assert.ok(reachable > 0, "随机场景应至少产生一条可达行程");
  console.log(`随机对照完成：${checked} 次查询全部一致，其中 ${reachable} 次可达`);
});
