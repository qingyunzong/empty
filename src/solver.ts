import type { Instance, Solution, ScheduleEntry, Skill, WorkerId } from "./types.js";

export const MAX_TASKS = 14;
export const MAX_HORIZON = 40;

/** 编译后的实例：全部转为数组/位掩码，便于离散状态搜索。 */
export interface Compiled {
  n: number;
  horizon: number;
  ids: string[];
  dur: number[];
  /** 1 = 单人，2 = 双人（同步占两人） */
  crew: number[];
  /** 单人任务可执行工人的位掩码（bit0=A, bit1=B）；双人任务为 3 */
  skillMask: number[];
  /** 前置任务位掩码 */
  depMask: number[];
}

function skillToMask(skill: Skill | undefined): number {
  switch (skill ?? "any") {
    case "A": return 1;
    case "B": return 2;
    case "any": return 3;
  }
}

/** 校验并编译实例；非法输入抛出 Error。 */
export function compile(inst: Instance): Compiled {
  if (!inst || !Array.isArray(inst.tasks)) throw new Error("实例缺少 tasks 数组");
  const n = inst.tasks.length;
  if (n === 0) throw new Error("任务数不能为 0");
  if (n > MAX_TASKS) throw new Error(`任务数 ${n} 超过上限 ${MAX_TASKS}`);
  const horizon = inst.horizon ?? MAX_HORIZON;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON) {
    throw new Error(`时间上限须为 1..${MAX_HORIZON} 的整数`);
  }
  const ids: string[] = [];
  const index = new Map<string, number>();
  const dur: number[] = [];
  const crew: number[] = [];
  const skillMask: number[] = [];
  for (const t of inst.tasks) {
    if (typeof t.id !== "string" || t.id === "") throw new Error("任务 id 非法");
    if (index.has(t.id)) throw new Error(`任务 id 重复: ${t.id}`);
    if (!Number.isInteger(t.duration) || t.duration < 1) {
      throw new Error(`任务 ${t.id} 时长须为正整数`);
    }
    if (t.workers !== 1 && t.workers !== 2) {
      throw new Error(`任务 ${t.id} 的 workers 须为 1 或 2`);
    }
    index.set(t.id, ids.length);
    ids.push(t.id);
    dur.push(t.duration);
    crew.push(t.workers);
    skillMask.push(t.workers === 2 ? 3 : skillToMask(t.skill));
  }
  const depMask: number[] = new Array<number>(n).fill(0);
  for (const t of inst.tasks) {
    const i = index.get(t.id)!;
    for (const d of t.deps ?? []) {
      const j = index.get(d);
      if (j === undefined) throw new Error(`任务 ${t.id} 依赖未知任务: ${d}`);
      if (j === i) throw new Error(`任务 ${t.id} 不能依赖自身`);
      depMask[i]! |= 1 << j;
    }
  }
  // 拓扑排序检测依赖环
  const indeg = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) if (depMask[i]! & (1 << j)) indeg[i]!++;
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let seen = 0;
  while (queue.length > 0) {
    const u = queue.pop()!;
    seen++;
    for (let v = 0; v < n; v++) {
      if (depMask[v]! & (1 << u)) {
        indeg[v]!--;
        if (indeg[v] === 0) queue.push(v);
      }
    }
  }
  if (seen < n) throw new Error("任务依赖存在环，无法调度");
  return { n, horizon, ids, dur, crew, skillMask, depMask };
}

interface Running {
  task: number;
  end: number;
  /** 占用工人位掩码：1=A，2=B，3=双人 */
  wmask: number;
}

interface State {
  time: number;
  done: number;
  running: Running[];
}

interface Start {
  task: number;
  start: number;
  end: number;
  wmask: number;
}

/** 二叉最小堆，按时间弹出。 */
class MinHeap {
  private keys: string[] = [];
  private prio: number[] = [];
  private seq: number[] = [];
  private counter = 0;
  get size(): number {
    return this.keys.length;
  }
  push(key: string, p: number): void {
    this.keys.push(key);
    this.prio.push(p);
    this.seq.push(this.counter++);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }
  pop(): string {
    const top = this.keys[0]!;
    const last = this.keys.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.prio.pop();
    this.seq.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.keys.length && this.less(l, m)) m = l;
      if (r < this.keys.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    const pa = this.prio[a]!;
    const pb = this.prio[b]!;
    return pa < pb || (pa === pb && this.seq[a]! < this.seq[b]!);
  }
  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
    [this.seq[a], this.seq[b]] = [this.seq[b]!, this.seq[a]!];
  }
}

function stateKey(done: number, running: Running[]): string {
  const parts = running
    .map((r) => `${r.task}:${r.end}:${r.wmask}`)
    .sort()
    .join(",");
  return `${done}|${parts}`;
}

/**
 * 精确求解：事件驱动的离散状态搜索（Dijkstra，代价=时间）。
 * 状态 = (已完成集合, 进行中任务及其结束时刻/占用工人)。
 * 决策点 = 有任务完成的时刻（或 t=0）；每个空闲工人可开始一个就绪的
 * 单人任务、两人同步开始一个双人任务，或选择空闲到下一事件。
 * 返回最优时间轴；在时间上限内不可行时返回 null。
 */
export function solve(inst: Instance): Solution | null {
  const c = compile(inst);
  const { n, horizon, ids, dur, crew, skillMask, depMask } = c;
  const FULL = (1 << n) - 1;

  const states = new Map<string, State>();
  const dist = new Map<string, number>();
  const parent = new Map<string, { prev: string; starts: Start[] }>();
  const heap = new MinHeap();

  const initial: State = { time: 0, done: 0, running: [] };
  const initKey = stateKey(0, []);
  states.set(initKey, initial);
  dist.set(initKey, 0);
  heap.push(initKey, 0);

  while (heap.size > 0) {
    const key = heap.pop();
    const st = states.get(key);
    if (!st) continue; // 已定型状态被删除后的过期堆项
    const best = dist.get(key)!;
    if (st.time !== best) continue; // 过期堆项
    if (st.done === FULL) return reconstruct(st, key, parent, ids);
    states.delete(key); // 已定型，释放内存

    const usedMask = st.running.reduce((m, r) => m | r.wmask, 0);
    const freeWorkers: number[] = [];
    for (const w of [0, 1]) if ((usedMask & (1 << w)) === 0) freeWorkers.push(w);

    const runningMask = st.running.reduce((m, r) => m | (1 << r.task), 0);
    const ready: number[] = [];
    for (let i = 0; i < n; i++) {
      if (st.done & (1 << i)) continue;
      if (runningMask & (1 << i)) continue;
      if ((depMask[i]! & ~st.done) !== 0) continue;
      ready.push(i);
    }

    // 枚举本决策点的所有开工组合（含“空闲到下一事件”的选择）
    const combos: { task: number; wmask: number }[][] = [];
    const singles = (w: number): { task: number; wmask: number }[] =>
      ready
        .filter((i) => crew[i] === 1 && (skillMask[i]! & (1 << w)) !== 0)
        .map((i) => ({ task: i, wmask: 1 << w }));
    if (freeWorkers.length === 2) {
      const sa = singles(0);
      const sb = singles(1);
      const aOpts: ({ task: number; wmask: number } | null)[] = [null, ...sa];
      const bOpts: ({ task: number; wmask: number } | null)[] = [null, ...sb];
      for (const a of aOpts) {
        for (const b of bOpts) {
          if (a && b && a.task === b.task) continue;
          const combo = [a, b].filter((x): x is { task: number; wmask: number } => x !== null);
          if (combo.length > 0 || st.running.length > 0) combos.push(combo);
        }
      }
      for (const i of ready) {
        if (crew[i] === 2) combos.push([{ task: i, wmask: 3 }]);
      }
    } else if (freeWorkers.length === 1) {
      const w = freeWorkers[0]!;
      for (const opt of [null, ...singles(w)]) {
        const combo = opt ? [opt] : [];
        if (combo.length > 0 || st.running.length > 0) combos.push(combo);
      }
    } else {
      combos.push([]); // 两人都在忙：只能推进到下一完成事件
    }

    for (const combo of combos) {
      const nr = st.running.slice();
      const starts: Start[] = [];
      for (const s of combo) {
        const end = st.time + dur[s.task]!;
        nr.push({ task: s.task, end, wmask: s.wmask });
        starts.push({ task: s.task, start: st.time, end, wmask: s.wmask });
      }
      let nextT = Infinity;
      for (const r of nr) nextT = Math.min(nextT, r.end);
      if (nextT > horizon) continue; // 超出整数时间上限
      let nd = st.done;
      const rest: Running[] = [];
      for (const r of nr) {
        if (r.end === nextT) nd |= 1 << r.task;
        else rest.push(r);
      }
      const nKey = stateKey(nd, rest);
      const prev = dist.get(nKey);
      if (prev !== undefined && prev <= nextT) continue;
      dist.set(nKey, nextT);
      states.set(nKey, { time: nextT, done: nd, running: rest });
      parent.set(nKey, { prev: key, starts });
      heap.push(nKey, nextT);
    }
  }
  return null; // 时间上限内不可行
}

function reconstruct(
  finalState: State,
  finalKey: string,
  parent: Map<string, { prev: string; starts: Start[] }>,
  ids: string[],
): Solution {
  const entries: ScheduleEntry[] = [];
  let key = finalKey;
  while (parent.has(key)) {
    const p = parent.get(key)!;
    for (const s of p.starts) {
      const workers: WorkerId[] =
        s.wmask === 3 ? [0, 1] : s.wmask === 1 ? [0] : [1];
      entries.push({ taskId: ids[s.task]!, start: s.start, end: s.end, workers });
    }
    key = p.prev;
  }
  entries.sort((a, b) => a.start - b.start || a.taskId.localeCompare(b.taskId));
  return { makespan: finalState.time, entries };
}

/** 校验一条时间轴是否满足全部约束；返回错误信息列表（空 = 合法）。 */
export function checkSchedule(inst: Instance, sol: Solution): string[] {
  const c = compile(inst);
  const errors: string[] = [];
  const byTask = new Map<string, ScheduleEntry>();
  for (const e of sol.entries) {
    if (byTask.has(e.taskId)) errors.push(`任务 ${e.taskId} 被安排了多次`);
    byTask.set(e.taskId, e);
  }
  for (const id of c.ids) {
    if (!byTask.has(id)) errors.push(`任务 ${id} 未被安排`);
  }
  const idx = new Map(c.ids.map((id, i) => [id, i]));
  for (const e of sol.entries) {
    const i = idx.get(e.taskId);
    if (i === undefined) {
      errors.push(`未知任务 ${e.taskId}`);
      continue;
    }
    if (e.end - e.start !== c.dur[i]!) {
      errors.push(`任务 ${e.taskId} 时长不符: ${e.start}-${e.end}`);
    }
    if (e.end > c.horizon) errors.push(`任务 ${e.taskId} 超出时间上限`);
    if (c.crew[i] === 2) {
      if (e.workers.length !== 2) errors.push(`双人任务 ${e.taskId} 未同步占用两名工人`);
    } else {
      if (e.workers.length !== 1) errors.push(`单人任务 ${e.taskId} 占用了多名工人`);
      else if ((c.skillMask[i]! & (1 << e.workers[0]!)) === 0) {
        errors.push(`任务 ${e.taskId} 的工人不满足技能要求`);
      }
    }
  }
  // 依赖：前置结束 <= 后续开始
  for (const t of inst.tasks) {
    const se = byTask.get(t.id);
    if (!se) continue;
    for (const d of t.deps ?? []) {
      const pe = byTask.get(d);
      if (pe && pe.end > se.start) {
        errors.push(`依赖违反: ${d} 结束于 ${pe.end}，但 ${t.id} 开始于 ${se.start}`);
      }
    }
  }
  // 工人占用不重叠
  for (const w of [0, 1] as WorkerId[]) {
    const lane = sol.entries
      .filter((e) => e.workers.includes(w))
      .sort((a, b) => a.start - b.start);
    for (let k = 1; k < lane.length; k++) {
      if (lane[k]!.start < lane[k - 1]!.end) {
        errors.push(`工人 ${w === 0 ? "A" : "B"} 时间冲突: ${lane[k - 1]!.taskId} 与 ${lane[k]!.taskId}`);
      }
    }
  }
  const maxEnd = sol.entries.reduce((m, e) => Math.max(m, e.end), 0);
  if (maxEnd !== sol.makespan) errors.push(`makespan ${sol.makespan} 与实际最晚结束 ${maxEnd} 不符`);
  return errors;
}
