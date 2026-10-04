/**
 * 插件能力规划库。
 *
 * 模型：
 * - 每个插件声明 requires（启用前必须具备的能力）与 provides（启用后提供的能力）及 cost。
 * - 起始能力由外部显式给出；插件只有在 requires 全部被当前已具能力覆盖时才能启用。
 * - 因此插件无法用自身（或循环互相）提供的能力自举：循环依赖的插件组
 *   若没有任何一个的 requires 被起始能力满足，则整组都无法启用。
 * - 插件数至多 18，状态空间 2^18 = 262144，可逐状态精确求解。
 */

export const MAX_PLUGINS = 18;

export interface Plugin {
  id: string;
  requires: string[];
  provides: string[];
  cost: number;
}

export interface PlanStep {
  /** 本步启用的插件 */
  plugin: string;
  /** 该插件的成本 */
  cost: number;
  /** 启用该插件后已具备的能力（含起始能力，按获得顺序排列） */
  capabilities: string[];
}

export interface Plan {
  /** 是否存在可达目标的启用序列 */
  feasible: boolean;
  /** 最低总成本（不可行时为 Infinity） */
  totalCost: number;
  /** 启用序列，每步附带启用后已具能力 */
  steps: PlanStep[];
  /** 最终已具能力 */
  finalCapabilities: string[];
}

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

interface Compiled {
  plugins: Plugin[];
  initial: string[];
  targets: string[];
  capIndex: Map<string, number>;
  capNames: string[];
  requiresMask: bigint[];
  providesMask: bigint[];
  initialMask: bigint;
  targetMask: bigint;
}

function compile(initial: string[], plugins: Plugin[], targets: string[]): Compiled {
  if (plugins.length > MAX_PLUGINS) {
    throw new PlanningError(`插件数 ${plugins.length} 超过上限 ${MAX_PLUGINS}`);
  }
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.id)) throw new PlanningError(`插件 id 重复: ${p.id}`);
    seen.add(p.id);
    if (!Number.isFinite(p.cost) || p.cost < 0) {
      throw new PlanningError(`插件 ${p.id} 成本非法: ${p.cost}`);
    }
  }

  const capIndex = new Map<string, number>();
  const capNames: string[] = [];
  const intern = (name: string): number => {
    let idx = capIndex.get(name);
    if (idx === undefined) {
      idx = capNames.length;
      capIndex.set(name, idx);
      capNames.push(name);
    }
    return idx;
  };
  for (const c of initial) intern(c);
  for (const p of plugins) {
    for (const c of p.requires) intern(c);
    for (const c of p.provides) intern(c);
  }
  for (const c of targets) intern(c);

  const maskOf = (names: string[]): bigint => {
    let m = 0n;
    for (const n of names) m |= 1n << BigInt(capIndex.get(n)!);
    return m;
  };

  return {
    plugins,
    initial,
    targets,
    capIndex,
    capNames,
    requiresMask: plugins.map((p) => maskOf(p.requires)),
    providesMask: plugins.map((p) => maskOf(p.provides)),
    initialMask: maskOf(initial),
    targetMask: maskOf(targets),
  };
}

/** caps[mask]：启用 mask 中全部插件后具备的能力位集（含起始能力）。 */
function capabilityTable(c: Compiled, size: number): bigint[] {
  const caps = new Array<bigint>(size);
  caps[0] = c.initialMask;
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    caps[mask] = caps[mask ^ low]! | c.providesMask[i]!;
  }
  return caps;
}

function capList(c: Compiled, mask: bigint): string[] {
  const out: string[] = [];
  for (let i = 0; i < c.capNames.length; i++) {
    if (mask & (1n << BigInt(i))) out.push(c.capNames[i]!);
  }
  return out;
}

/**
 * 主求解器：在状态图上做动态规划（边只增不删，按掩码数值升序即拓扑序），
 * 求覆盖全部目标能力的最低成本启用序列。
 */
export function solve(initial: string[], plugins: Plugin[], targets: string[]): Plan {
  const c = compile(initial, plugins, targets);
  const n = plugins.length;
  const size = 1 << n;
  const caps = capabilityTable(c, size);

  const dist = new Float64Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const choice = new Int32Array(size).fill(-1);
  dist[0] = 0;

  for (let mask = 0; mask < size; mask++) {
    const d = dist[mask]!;
    if (d === Infinity) continue;
    const held = caps[mask]!;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit) continue;
      // requires 必须全部由“启用该插件之前”已具能力满足：杜绝循环自供启动。
      if ((c.requiresMask[i]! & ~held) !== 0n) continue;
      const next = mask | bit;
      const nd = d + c.plugins[i]!.cost;
      if (nd < dist[next]!) {
        dist[next] = nd;
        parent[next] = mask;
        choice[next] = i;
      }
    }
  }

  let best = -1;
  for (let mask = 0; mask < size; mask++) {
    if ((caps[mask]! & c.targetMask) !== c.targetMask) continue;
    if (dist[mask]! < (best === -1 ? Infinity : dist[best]!)) best = mask;
  }

  if (best === -1) {
    return { feasible: false, totalCost: Infinity, steps: [], finalCapabilities: [] };
  }

  const order: number[] = [];
  for (let m = best; m !== 0; m = parent[m]!) order.push(choice[m]!);
  order.reverse();

  const steps: PlanStep[] = [];
  let held = c.initialMask;
  for (const i of order) {
    held |= c.providesMask[i]!;
    steps.push({ plugin: c.plugins[i]!.id, cost: c.plugins[i]!.cost, capabilities: capList(c, held) });
  }

  return {
    feasible: true,
    totalCost: dist[best]!,
    steps,
    finalCapabilities: capList(c, held),
  };
}

export interface ExhaustiveResult {
  feasible: boolean;
  minCost: number;
  /** 达到最低成本的可行状态（插件子集）数量 */
  optimalStates: number;
  /** 被枚举检查过的状态总数（恒为 2^n） */
  statesExplored: number;
}

/**
 * 核对用穷举状态搜索：逐一枚举全部 2^n 个插件子集，
 * 对每个子集独立判定“是否存在合法启用顺序”，再取覆盖目标的最小成本。
 * 与 solve() 的最短路 DP 相互独立，用于交叉核对。
 */
export function solveExhaustive(
  initial: string[],
  plugins: Plugin[],
  targets: string[],
): ExhaustiveResult {
  const c = compile(initial, plugins, targets);
  const n = plugins.length;
  const size = 1 << n;
  const caps = capabilityTable(c, size);

  // orderable[mask]：mask 中全部插件可以按某个合法顺序逐一启用。
  const orderable = new Uint8Array(size);
  orderable[0] = 1;
  for (let mask = 1; mask < size; mask++) {
    let m = mask;
    while (m !== 0) {
      const low = m & -m;
      const i = 31 - Math.clz32(low);
      const prev = mask ^ low;
      // i 作为最后启用的插件：前序子集须可排序，且其能力满足 i 的 requires。
      if (orderable[prev] === 1 && (c.requiresMask[i]! & ~caps[prev]!) === 0n) {
        orderable[mask] = 1;
        break;
      }
      m ^= low;
    }
  }

  let minCost = Infinity;
  let optimalStates = 0;
  for (let mask = 0; mask < size; mask++) {
    if (orderable[mask] !== 1) continue;
    if ((caps[mask]! & c.targetMask) !== c.targetMask) continue;
    let cost = 0;
    let m = mask;
    while (m !== 0) {
      const low = m & -m;
      cost += c.plugins[31 - Math.clz32(low)]!.cost;
      m ^= low;
    }
    if (cost < minCost) {
      minCost = cost;
      optimalStates = 1;
    } else if (cost === minCost) {
      optimalStates++;
    }
  }

  return { feasible: minCost !== Infinity, minCost, optimalStates, statesExplored: size };
}

/**
 * 校验一个规划结果：逐步重放，确认每步 requires 均被此前已具能力满足、
 * 成本累计正确、最终能力覆盖目标。
 */
export function validatePlan(
  initial: string[],
  plugins: Plugin[],
  targets: string[],
  plan: Plan,
): void {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const held = new Set(initial);
  let cost = 0;
  for (const step of plan.steps) {
    const p = byId.get(step.plugin);
    if (!p) throw new PlanningError(`计划引用了未知插件: ${step.plugin}`);
    for (const req of p.requires) {
      if (!held.has(req)) {
        throw new PlanningError(`启用 ${p.id} 时缺少能力: ${req}`);
      }
    }
    cost += p.cost;
    if (step.cost !== p.cost) throw new PlanningError(`步骤成本记录不符: ${p.id}`);
    for (const prov of p.provides) held.add(prov);
    const expect = [...held].sort();
    const actual = [...step.capabilities].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expect)) {
      throw new PlanningError(`步骤能力快照不符: ${p.id}`);
    }
  }
  if (cost !== plan.totalCost) throw new PlanningError("总成本与步骤累计不符");
  for (const t of targets) {
    if (!held.has(t)) throw new PlanningError(`最终能力未覆盖目标: ${t}`);
  }
}
