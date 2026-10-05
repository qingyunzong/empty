/**
 * 行程查询库。
 *
 * 数据模型：
 * - 班次（Trip）由有序停靠点组成，时间一律为整数「绝对分钟」，
 *   例如 23:55 = 1435，次日 00:30 = 1470，天然支持跨午夜。
 * - 换乘：在同一车站下班次后，须满足该站最低换乘时间方可登上后续班次
 *   （出发站不收取换乘时间）。
 * - 最多换乘 maxTransfers 次（默认 3，即最多乘坐 4 段班次）。
 *
 * 选路优先级：到达时间早 → 换乘次数少 → 班次 ID 序列字典序小。
 * （若前三项仍并列，再按各段的 出发站/到达站/出发/到达时间 字典序确定唯一结果，
 *   仅作为确定性兜底，枚举对照器使用同一比较器。）
 */

export interface StopTime {
  station: string;
  arrival: number;    // 绝对分钟，整数
  departure: number;  // 绝对分钟，整数
}

export interface Trip {
  id: string;
  stops: StopTime[];  // 至少 2 个停靠点，时间沿行程单调不减
}

export interface Leg {
  tripId: string;
  from: string;
  to: string;
  depart: number;  // 绝对分钟
  arrive: number;  // 绝对分钟
}

export interface Itinerary {
  legs: Leg[];
  arrival: number;    // 到达目的地的绝对分钟
  transfers: number;  // 换乘次数 = legs.length - 1（空行程为 0）
}

export interface PlannerOptions {
  maxTransfers?: number;                     // 默认 3
  minTransfer?: number;                      // 默认 0，全局最低换乘分钟
  stationMinTransfer?: Record<string, number>; // 按车站覆盖最低换乘分钟
}

interface ResolvedOptions {
  maxTransfers: number;
  minTransfer: number;
  stationMinTransfer: Record<string, number>;
}

function assertNonNegativeInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} 必须是非负整数分钟，收到: ${value}`);
  }
}

/** 比较班次 ID 序列的字典序。 */
function compareTripIds(a: Leg[], b: Leg[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]!.tripId < b[i]!.tripId) return -1;
    if (a[i]!.tripId > b[i]!.tripId) return 1;
  }
  return a.length - b.length;
}

/**
 * 行程段序列的完整确定性比较：
 * 先比班次 ID 序列，再逐段比 (from, to, depart, arrive)。
 * 主算法与全路径枚举共用，保证两者在并列时选出同一条路线。
 */
export function compareLegSequences(a: Leg[], b: Leg[]): number {
  const byTrips = compareTripIds(a, b);
  if (byTrips !== 0) return byTrips;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.from !== y.from) return x.from < y.from ? -1 : 1;
    if (x.to !== y.to) return x.to < y.to ? -1 : 1;
    if (x.depart !== y.depart) return x.depart - y.depart;
    if (x.arrive !== y.arrive) return x.arrive - y.arrive;
  }
  return 0;
}

/** 选路优先级比较（直接作用于段序列）：到达早 → 换乘少 → 班次 ID 序 → 段细节。 */
export function compareRoutes(a: Leg[], b: Leg[]): number {
  const arrivalA = a.length === 0 ? 0 : a[a.length - 1]!.arrive;
  const arrivalB = b.length === 0 ? 0 : b[b.length - 1]!.arrive;
  if (arrivalA !== arrivalB) return arrivalA - arrivalB;
  if (a.length !== b.length) return a.length - b.length;
  return compareLegSequences(a, b);
}

/** 选路优先级比较：到达早 → 换乘少 → 班次 ID 序 → 段细节。 */
export function compareItineraries(a: Itinerary, b: Itinerary): number {
  if (a.arrival !== b.arrival) return a.arrival - b.arrival;
  if (a.transfers !== b.transfers) return a.transfers - b.transfers;
  return compareLegSequences(a.legs, b.legs);
}

export function buildItinerary(legs: Leg[]): Itinerary {
  return {
    legs,
    arrival: legs.length === 0 ? 0 : legs[legs.length - 1]!.arrive,
    transfers: Math.max(0, legs.length - 1),
  };
}

/** 查询状态：位于某车站、当前时间、已乘段数与已乘段明细。 */
interface State {
  station: string;
  time: number;
  boardings: number;
  legs: Leg[];
}

/** 状态优先队列键：时间早 → 已乘段数少 → 段序列字典序小。 */
function compareStates(a: State, b: State): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.boardings !== b.boardings) return a.boardings - b.boardings;
  return compareLegSequences(a.legs, b.legs);
}

/** 小二叉堆。 */
class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!) < 0) {
        [items[i], items[parent]] = [items[parent]!, items[i]!];
        i = parent;
      } else {
        break;
      }
    }
  }
  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.less(items[left]!, items[smallest]!) < 0) smallest = left;
        if (right < items.length && this.less(items[right]!, items[smallest]!) < 0) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

interface TripStopRef {
  trip: Trip;
  stopIndex: number;
}

export class JourneyPlanner {
  private readonly options: ResolvedOptions;
  private readonly trips = new Map<string, Trip>();
  private readonly cancelled = new Set<string>();
  private readonly stopsByStation = new Map<string, TripStopRef[]>();

  constructor(trips: Trip[], options: PlannerOptions = {}) {
    this.options = {
      maxTransfers: options.maxTransfers ?? 3,
      minTransfer: options.minTransfer ?? 0,
      stationMinTransfer: options.stationMinTransfer ?? {},
    };
    assertNonNegativeInteger(this.options.maxTransfers, "maxTransfers");
    assertNonNegativeInteger(this.options.minTransfer, "minTransfer");
    for (const [station, minutes] of Object.entries(this.options.stationMinTransfer)) {
      assertNonNegativeInteger(minutes, `车站 ${station} 的最低换乘时间`);
    }
    for (const trip of trips) {
      this.validateTrip(trip);
      if (this.trips.has(trip.id)) {
        throw new Error(`班次 ID 重复: ${trip.id}`);
      }
      this.trips.set(trip.id, trip);
    }
    for (const trip of trips) {
      trip.stops.forEach((stop, stopIndex) => {
        let list = this.stopsByStation.get(stop.station);
        if (!list) {
          list = [];
          this.stopsByStation.set(stop.station, list);
        }
        list.push({ trip, stopIndex });
      });
    }
  }

  private validateTrip(trip: Trip): void {
    if (trip.id.length === 0) throw new Error("班次 ID 不能为空");
    if (trip.stops.length < 2) throw new Error(`班次 ${trip.id} 至少需要 2 个停靠点`);
    for (let i = 0; i < trip.stops.length; i++) {
      const stop = trip.stops[i]!;
      assertNonNegativeInteger(stop.arrival, `班次 ${trip.id} 停靠点 ${i} 的到达时间`);
      assertNonNegativeInteger(stop.departure, `班次 ${trip.id} 停靠点 ${i} 的出发时间`);
      if (stop.departure < stop.arrival) {
        throw new Error(`班次 ${trip.id} 停靠点 ${i} 出发时间早于到达时间`);
      }
      if (i > 0 && stop.arrival < trip.stops[i - 1]!.departure) {
        throw new Error(`班次 ${trip.id} 的停靠时间未按绝对分钟单调不减`);
      }
    }
  }

  /** 取消班次；返回该班次是否存在且此前未取消。 */
  cancelTrip(tripId: string): boolean {
    if (!this.trips.has(tripId) || this.cancelled.has(tripId)) return false;
    this.cancelled.add(tripId);
    return true;
  }

  /** 恢复已取消的班次。 */
  restoreTrip(tripId: string): boolean {
    return this.cancelled.delete(tripId);
  }

  cancelledTripIds(): string[] {
    return [...this.cancelled].sort();
  }

  /** 当前生效（未取消）的班次列表。 */
  activeTrips(): Trip[] {
    return [...this.trips.values()].filter((trip) => !this.cancelled.has(trip.id));
  }

  private minTransferAt(station: string): number {
    return this.options.stationMinTransfer[station] ?? this.options.minTransfer;
  }

  /**
   * 查询从 from 到 to、不早于 departAfter（绝对分钟）出发的最优行程。
   * 标签设定式 Dijkstra：按 (时间, 已乘段数, 段序列) 出堆，
   * 首次弹出目的地即为按选路优先级最优的行程。
   */
  query(from: string, to: string, departAfter: number): Itinerary | null {
    assertNonNegativeInteger(departAfter, "departAfter");
    if (from === to) {
      return { legs: [], arrival: departAfter, transfers: 0 };
    }
    const maxBoardings = this.options.maxTransfers + 1;
    const heap = new MinHeap<State>(compareStates);
    heap.push({ station: from, time: departAfter, boardings: 0, legs: [] });

    // 每个车站已弹出的标签。标签 L 占优当前状态 S 可安全剪枝，当且仅当：
    //   L.time <= S.time（同站不更晚，L 可模仿 S 的任何后续），且
    //   L.boardings < S.boardings（模仿路线换乘严格更少，必然更优），或
    //   L.boardings == S.boardings 且 L 段序列 <= S 段序列
    //   （到达与换乘并列时，班次 ID 序决胜，前缀更小者胜）。
    // 注意：仅时间更早不能剪枝——并列时段序列字典序更大的前缀会输掉决胜。
    const settled = new Map<
      string,
      Array<{ time: number; boardings: number; legs: Leg[] }>
    >();

    while (heap.size > 0) {
      const state = heap.pop()!;
      if (state.station === to) {
        return buildItinerary(state.legs);
      }
      const labels = settled.get(state.station);
      if (
        labels?.some(
          (l) =>
            l.time <= state.time &&
            (l.boardings < state.boardings ||
              (l.boardings === state.boardings &&
                compareLegSequences(l.legs, state.legs) <= 0)),
        )
      ) {
        continue;
      }
      const kept = labels ?? [];
      kept.push({ time: state.time, boardings: state.boardings, legs: state.legs });
      settled.set(state.station, kept);

      if (state.boardings >= maxBoardings) continue;
      const refs = this.stopsByStation.get(state.station);
      if (!refs) continue;
      const earliestBoard =
        state.legs.length === 0
          ? departAfter
          : state.time + this.minTransferAt(state.station);
      for (const { trip, stopIndex } of refs) {
        if (this.cancelled.has(trip.id)) continue;
        const lastLeg = state.legs[state.legs.length - 1];
        if (lastLeg && lastLeg.tripId === trip.id) continue; // 不下车再上一同班次
        const stop = trip.stops[stopIndex]!;
        if (stop.departure < earliestBoard) continue;
        for (let j = stopIndex + 1; j < trip.stops.length; j++) {
          const down = trip.stops[j]!;
          heap.push({
            station: down.station,
            time: down.arrival,
            boardings: state.boardings + 1,
            legs: [
              ...state.legs,
              {
                tripId: trip.id,
                from: state.station,
                to: down.station,
                depart: stop.departure,
                arrive: down.arrival,
              },
            ],
          });
        }
      }
    }
    return null;
  }
}
