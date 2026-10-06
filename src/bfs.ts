/** 全状态 BFS 最短动作路径搜索。状态 = (位置, 已拾钥匙, 已开门)。 */
import { Level } from "./level";
import { ACTIONS, Action, State, StateStore, stateKey } from "./state";

export interface SolveResult {
  /** 最短动作序列 */
  actions: Action[];
  /** 到达终点时的状态版本 */
  goal: State;
  /** BFS 扩展的不同状态数 */
  explored: number;
}

/**
 * 从 level 的初始状态出发求到终点的最短动作路径；无解返回 null。
 * 可选 from 版本：从任意（分叉的）历史版本继续搜索。
 */
export function solve(level: Level, from?: State, store?: StateStore): SolveResult | null {
  const st = store ?? new StateStore(level);
  const start = from ?? st.initial();
  if (start.pos === level.goal) {
    return { actions: [], goal: start, explored: 1 };
  }

  const seen = new Set<string>([stateKey(start)]);
  let frontier: State[] = [start];
  let explored = 1;

  while (frontier.length > 0) {
    const nextFrontier: State[] = [];
    for (const cur of frontier) {
      for (const a of ACTIONS) {
        const ns = st.apply(cur, a);
        if (!ns) continue;
        const k = stateKey(ns);
        if (seen.has(k)) continue;
        seen.add(k);
        explored++;
        if (ns.pos === level.goal) {
          return { actions: st.pathTo(ns, start.version), goal: ns, explored };
        }
        nextFrontier.push(ns);
      }
    }
    frontier = nextFrontier;
  }
  return null;
}
