/** 物料数量表：物料名 -> 数量 */
export type Items = Record<string, number>;

/** 配方：开工时消耗 inputs，完工时产出 outputs，加工耗时 duration 个 tick */
export interface Recipe {
  inputs: Items;
  outputs: Items;
  duration: number;
}

export interface BufferConfig {
  id: string;
  capacity: number;
  initial?: Items;
}

export interface MachineConfig {
  id: string;
  recipe: Recipe;
  inputBuffer: string;
  outputBuffer: string;
}

export interface SimConfig {
  buffers: BufferConfig[];
  machines: MachineConfig[];
}

export type MachineState = "idle" | "running" | "holding";

export type EventType =
  | "start"    // 开工：消耗输入
  | "complete" // 完工：产出已就绪，由机器持有
  | "store"    // 入库：成品进入输出仓
  | "blocked"  // 阻塞：输出仓满，机器持成品等待
  | "fault"    // 故障：加工暂停
  | "repaired" // 修复：从暂停处续行
  | "add"      // 外部投料
  | "remove";  // 外部取料

export interface SimEvent {
  tick: number;
  type: EventType;
  machine?: string;
  buffer?: string;
  items?: Items;
  detail?: string;
}

export interface MachineSnapshot {
  id: string;
  state: MachineState;
  progress: number;
  faultRemaining: number;
  wip: Items;   // 已消耗、尚在机内的在制品
  held: Items;  // 已完工、由机器持有的成品
}

export interface Snapshot {
  tick: number;
  buffers: Record<string, { capacity: number; used: number; stock: Items }>;
  machines: MachineSnapshot[];
  totals: Items;
}

export interface ConservationReport {
  ok: boolean;
  expected: Items;
  actual: Items;
}

export interface TickReport {
  tick: number;
  events: SimEvent[];
  snapshot: Snapshot;
  conservation: ConservationReport;
}

interface BufferState {
  id: string;
  capacity: number;
  stock: Map<string, number>;
}

interface MachineStateInternal {
  id: string;
  recipe: Recipe;
  inputBuffer: string;
  outputBuffer: string;
  state: MachineState;
  progress: number;
  faultRemaining: number;
  wip: Map<string, number>;
  held: Map<string, number>;
}

function addInto(target: Map<string, number>, items: Items, sign: 1 | -1): void {
  for (const [item, qty] of Object.entries(items)) {
    const next = (target.get(item) ?? 0) + sign * qty;
    if (next < 0) throw new Error(`物料不足: ${item}`);
    if (next === 0) target.delete(item);
    else target.set(item, next);
  }
}

function sumOf(items: Items): number {
  let total = 0;
  for (const qty of Object.values(items)) total += qty;
  return total;
}

function mapToItems(map: Map<string, number>): Items {
  const out: Items = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

function cloneItems(items: Items): Items {
  return { ...items };
}

export class Simulation {
  tick = 0;
  private buffers = new Map<string, BufferState>();
  private machines: MachineStateInternal[] = [];
  private events: SimEvent[] = [];
  private externalIn = new Map<string, number>();
  private externalOut = new Map<string, number>();
  private initialTotals = new Map<string, number>();
  private transformedIn = new Map<string, number>();
  private transformedOut = new Map<string, number>();

  constructor(config: SimConfig) {
    for (const b of config.buffers) {
      if (this.buffers.has(b.id)) throw new Error(`仓库重复: ${b.id}`);
      const stock = new Map<string, number>();
      addInto(stock, b.initial ?? {}, 1);
      const used = sumOf(b.initial ?? {});
      if (used > b.capacity) throw new Error(`初始库存超出容量: ${b.id}`);
      this.buffers.set(b.id, { id: b.id, capacity: b.capacity, stock });
    }
    for (const m of config.machines) {
      if (!this.buffers.has(m.inputBuffer)) throw new Error(`未知输入仓: ${m.inputBuffer}`);
      if (!this.buffers.has(m.outputBuffer)) throw new Error(`未知输出仓: ${m.outputBuffer}`);
      if (m.recipe.duration < 1) throw new Error(`加工时长至少为 1: ${m.id}`);
      this.machines.push({
        id: m.id,
        recipe: m.recipe,
        inputBuffer: m.inputBuffer,
        outputBuffer: m.outputBuffer,
        state: "idle",
        progress: 0,
        faultRemaining: 0,
        wip: new Map(),
        held: new Map(),
      });
    }
    this.initialTotals = new Map(Object.entries(this.totals()));
  }

  /** 外部投料（计入守恒基线） */
  addStock(bufferId: string, items: Items): void {
    const buf = this.getBuffer(bufferId);
    const used = sumOf(mapToItems(buf.stock));
    if (used + sumOf(items) > buf.capacity) throw new Error(`仓库容量不足: ${bufferId}`);
    addInto(buf.stock, items, 1);
    addInto(this.externalIn, items, 1);
    this.emit({ tick: this.tick, type: "add", buffer: bufferId, items: cloneItems(items) });
  }

  /** 外部取料（计入守恒基线） */
  removeStock(bufferId: string, items: Items): void {
    const buf = this.getBuffer(bufferId);
    addInto(buf.stock, items, -1);
    addInto(this.externalOut, items, 1);
    this.emit({ tick: this.tick, type: "remove", buffer: bufferId, items: cloneItems(items) });
  }

  /** 注入故障：机器暂停 repairTicks 个 tick，之后从暂停处续行 */
  injectFault(machineId: string, repairTicks: number): void {
    const m = this.getMachine(machineId);
    if (repairTicks < 1) throw new Error("故障时长至少为 1");
    m.faultRemaining += repairTicks;
    this.emit({
      tick: this.tick,
      type: "fault",
      machine: machineId,
      detail: `停机 ${repairTicks} tick（累计 ${m.faultRemaining}）`,
    });
  }

  /** 推进一个 tick：故障恢复 -> 完工 -> 入库 -> 开工 */
  step(): TickReport {
    this.tick += 1;
    const start = this.events.length;

    // 阶段 0：故障倒计时。本 tick 开始时仍停机的机器，整 tick 不参与任何阶段；
    // 倒计时归零发出 repaired，下一 tick 起从暂停处续行。
    const down = new Set<MachineStateInternal>();
    for (const m of this.machines) {
      if (m.faultRemaining > 0) {
        down.add(m);
        m.faultRemaining -= 1;
        if (m.faultRemaining === 0) {
          this.emit({ tick: this.tick, type: "repaired", machine: m.id });
        }
      }
    }

    // 阶段 1：完工（加工进度推进，满时长即完工，成品由机器持有）
    for (const m of this.machines) {
      if (m.state === "running" && !down.has(m)) {
        m.progress += 1;
        if (m.progress >= m.recipe.duration) {
          m.state = "holding";
          addInto(m.held, m.recipe.outputs, 1);
          m.wip.clear();
          addInto(this.transformedIn, m.recipe.inputs, 1);
          addInto(this.transformedOut, m.recipe.outputs, 1);
          this.emit({ tick: this.tick, type: "complete", machine: m.id, items: cloneItems(m.recipe.outputs) });
        }
      }
    }

    // 阶段 2：入库（输出仓放得下才放行；否则持成品阻塞，机器不释放）
    for (const m of this.machines) {
      if (m.state === "holding" && !down.has(m)) {
        const buf = this.getBuffer(m.outputBuffer);
        const held = mapToItems(m.held);
        const used = sumOf(mapToItems(buf.stock));
        if (used + sumOf(held) <= buf.capacity) {
          addInto(buf.stock, held, 1);
          m.held.clear();
          m.state = "idle";
          m.progress = 0;
          this.emit({ tick: this.tick, type: "store", machine: m.id, buffer: buf.id, items: held });
        } else {
          this.emit({ tick: this.tick, type: "blocked", machine: m.id, buffer: buf.id, items: held });
        }
      }
    }

    // 阶段 3：开工（空闲机器从输入仓领料）
    for (const m of this.machines) {
      if (m.state === "idle" && !down.has(m)) {
        const buf = this.getBuffer(m.inputBuffer);
        const hasAll = Object.entries(m.recipe.inputs).every(
          ([item, qty]) => (buf.stock.get(item) ?? 0) >= qty,
        );
        if (hasAll) {
          addInto(buf.stock, m.recipe.inputs, -1);
          addInto(m.wip, m.recipe.inputs, 1);
          m.state = "running";
          m.progress = 0;
          this.emit({ tick: this.tick, type: "start", machine: m.id, items: cloneItems(m.recipe.inputs) });
        }
      }
    }

    const snapshot = this.snapshot();
    const conservation = this.checkConservation();
    return {
      tick: this.tick,
      events: this.events.slice(start),
      snapshot,
      conservation,
    };
  }

  run(ticks: number): TickReport[] {
    const reports: TickReport[] = [];
    for (let i = 0; i < ticks; i++) reports.push(this.step());
    return reports;
  }

  /** 全量事件日志 */
  get eventLog(): readonly SimEvent[] {
    return this.events;
  }

  /** 当前状态快照（含各物料总量，用于守恒核对） */
  snapshot(): Snapshot {
    const buffers: Snapshot["buffers"] = {};
    for (const buf of this.buffers.values()) {
      const stock = mapToItems(buf.stock);
      buffers[buf.id] = { capacity: buf.capacity, used: sumOf(stock), stock };
    }
    return {
      tick: this.tick,
      buffers,
      machines: this.machines.map((m) => ({
        id: m.id,
        state: m.state,
        progress: m.progress,
        faultRemaining: m.faultRemaining,
        wip: mapToItems(m.wip),
        held: mapToItems(m.held),
      })),
      totals: this.totals(),
    };
  }

  /** 全系统各物料总量：仓库库存 + 机在制品 + 机器持有成品 */
  totals(): Items {
    const totals = new Map<string, number>();
    for (const buf of this.buffers.values()) {
      addInto(totals, mapToItems(buf.stock), 1);
    }
    for (const m of this.machines) {
      addInto(totals, mapToItems(m.wip), 1);
      addInto(totals, mapToItems(m.held), 1);
    }
    return mapToItems(totals);
  }

  /**
   * 物料守恒核对（分物料台账）：
   * 当前物理总量 == 初始库存 + 外部投入 - 外部取出 - 已完工消耗的输入 + 已完工产出的成品。
   * 在制品与机器持有的成品都计入物理总量，因此任何丢失或凭空产生都会破坏等式。
   */
  checkConservation(): ConservationReport {
    const expected: Items = {};
    const accumulate = (source: Map<string, number>, sign: 1 | -1): void => {
      for (const [item, qty] of source) {
        expected[item] = (expected[item] ?? 0) + sign * qty;
      }
    };
    accumulate(this.initialTotals, 1);
    accumulate(this.externalIn, 1);
    accumulate(this.externalOut, -1);
    accumulate(this.transformedIn, -1);
    accumulate(this.transformedOut, 1);
    const actual = this.totals();
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    let ok = true;
    for (const k of keys) {
      if ((expected[k] ?? 0) !== (actual[k] ?? 0)) ok = false;
    }
    return { ok, expected, actual };
  }

  private getBuffer(id: string): BufferState {
    const buf = this.buffers.get(id);
    if (!buf) throw new Error(`未知仓库: ${id}`);
    return buf;
  }

  private getMachine(id: string): MachineStateInternal {
    const m = this.machines.find((x) => x.id === id);
    if (!m) throw new Error(`未知机器: ${id}`);
    return m;
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }
}
