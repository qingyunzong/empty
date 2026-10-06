/** 路径重放核验：从初始状态逐步重放动作序列，验证合法性与到达终点。 */
import { Level } from "./level";
import { Action, State, StateStore } from "./state";

export interface ReplayResult {
  /** 所有动作均合法 */
  ok: boolean;
  /** 第一个非法动作的下标；全部合法时为 -1 */
  failedAt: number;
  /** 重放结束时的状态（失败时为失败前的状态） */
  final: State;
  /** 重放结束后是否位于终点 */
  reachedGoal: boolean;
  /** 重放产生的完整版本轨迹（含初始版本） */
  trajectory: State[];
}

export function replayPath(level: Level, actions: Action[]): ReplayResult {
  const store = new StateStore(level);
  let cur = store.initial();
  const trajectory: State[] = [cur];
  for (let i = 0; i < actions.length; i++) {
    const ns = store.apply(cur, actions[i]);
    if (!ns) {
      return { ok: false, failedAt: i, final: cur, reachedGoal: false, trajectory };
    }
    cur = ns;
    trajectory.push(cur);
  }
  return {
    ok: true,
    failedAt: -1,
    final: cur,
    reachedGoal: cur.pos === level.goal,
    trajectory,
  };
}

/** 便捷核验：路径全部合法且最终到达终点 */
export function verifyPath(level: Level, actions: Action[]): boolean {
  const r = replayPath(level, actions);
  return r.ok && r.reachedGoal;
}
