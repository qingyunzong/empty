// 规划器：交互式 apply/undo + 完备搜索（带记忆化）。
//
// 撤销与增量失效：
//   - undo() 弹出最近计划步，状态由历史栈精确恢复；
//   - 后缀搜索结果以状态为键缓存在 this._memo 中，与到达路径无关，
//     因此撤销只使被弹出的分支失效，未受影响分支的缓存继续命中，
//     重新 solve 时仅重算受影响分支（由 stats.computed / stats.cacheHits 可观测）。

import {
  validateProblem,
  initialState,
  canApply,
  transition,
  applicableActions,
  comparePlans,
  stateKey,
  domainError,
  preconditionError,
} from './domain.js';
import { buildCertificate } from './certificate.js';

function normalizeAction(problem, state, action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    throw domainError('action must be an object with a string type');
  }
  let normalized;
  if (action.type === 'changeTool' || action.type === 'calibrate') {
    normalized = { type: action.type };
  } else if (action.type === 'run') {
    if (typeof action.op !== 'string') {
      throw domainError('run action requires an op id string');
    }
    const head = problem.ops[state.opIndex];
    if (!head) throw preconditionError('run: no pending operations');
    if (action.op !== head.id) {
      throw preconditionError(`run: next pending op is "${head.id}", not "${action.op}"`);
    }
    normalized = { type: 'run', op: head.id };
  } else {
    throw domainError(`unknown action type: ${action.type}`);
  }
  const check = canApply(problem, state, normalized);
  if (!check.ok) throw preconditionError(check.reason);
  return normalized;
}

export class Planner {
  constructor(problem) {
    this.problem = validateProblem(problem);
    const start = initialState(this.problem);
    this._state = start;
    this._history = [start];
    this._path = [];
    this._memo = new Map();
  }

  get state() {
    return { ...this._state };
  }

  get pendingOps() {
    return this.problem.ops.slice(this._state.opIndex).map((op) => ({ ...op }));
  }

  get path() {
    return this._path.map((action) => ({ ...action }));
  }

  get depth() {
    return this._path.length;
  }

  apply(action) {
    const normalized = normalizeAction(this.problem, this._state, action);
    const next = transition(this.problem, this._state, normalized);
    this._state = next;
    this._history.push(next);
    this._path.push(normalized);
    return this;
  }

  // 撤销最近计划步；返回被撤销的动作，无可撤销时返回 null。
  undo() {
    if (this._path.length === 0) return null;
    const undone = this._path.pop();
    this._history.pop();
    this._state = this._history[this._history.length - 1];
    return { ...undone };
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ problem: this.problem, path: this._path }));
  }

  static restore(snapshot) {
    const planner = new Planner(snapshot.problem);
    for (const action of snapshot.path) planner.apply(action);
    return planner;
  }

  _downtimeOf(action) {
    if (action.type === 'changeTool') return this.problem.costs.changeTool.time;
    if (action.type === 'calibrate') return this.problem.costs.calibrate.time;
    return 0;
  }

  // 从 state 出发的后缀最优：{ best, plans:[{actions, downtime, budgetRemaining}] }。
  // best === Infinity 表示该状态不可行。结果按 (停机, 预算余量, 字典序) 排序并保留全部并列。
  _solveSuffix(state, stats) {
    const key = stateKey(state);
    const cached = this._memo.get(key);
    if (cached) {
      stats.cacheHits += 1;
      return cached;
    }
    stats.computed += 1;
    let result;
    if (state.opIndex === this.problem.ops.length) {
      result = { best: 0, plans: [{ actions: [], downtime: 0, budgetRemaining: state.budget }] };
    } else {
      let best = Infinity;
      let plans = [];
      for (const action of applicableActions(this.problem, state)) {
        const sub = this._solveSuffix(transition(this.problem, state, action), stats);
        if (sub.best === Infinity) continue;
        const total = sub.best + this._downtimeOf(action);
        const candidates = sub.plans.map((plan) => ({
          actions: [action, ...plan.actions],
          downtime: total,
          budgetRemaining: plan.budgetRemaining,
        }));
        if (total < best) {
          best = total;
          plans = candidates;
        } else if (total === best) {
          plans.push(...candidates);
        }
      }
      plans.sort(comparePlans);
      result = { best, plans };
    }
    this._memo.set(key, result);
    return result;
  }

  // 从当前状态求解。返回 SAT（含全部并列最优计划）或 UNSAT（含最小不可行证书）。
  // 搜索是完备的：不存在 UNKNOWN 状态，UNSAT 不会被 UNKNOWN 冒充。
  solve(options = {}) {
    const { certificate = true } = options;
    const stats = { computed: 0, cacheHits: 0 };
    const suffix = this._solveSuffix(this._state, stats);
    if (suffix.best === Infinity) {
      const result = { status: 'UNSAT', stats };
      if (certificate) {
        result.certificate = buildCertificate(this.problem, this._path);
      }
      return result;
    }
    const plans = suffix.plans.map((plan) => ({
      actions: plan.actions,
      downtime: plan.downtime,
      budgetRemaining: plan.budgetRemaining,
      totalDowntime: this._state.downtime + plan.downtime,
      full: [...this._path.map((a) => ({ ...a })), ...plan.actions],
    }));
    return {
      status: 'SAT',
      downtime: suffix.best,
      totalDowntime: this._state.downtime + suffix.best,
      plans,
      stats,
    };
  }
}
