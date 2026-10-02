// 领域层：问题校验（ERR_DOMAIN）、状态转移、动作空间、排序键。
//
// 状态: { toolWear, calDue, budget, opIndex, downtime }
//   - toolWear: 当前刀具已累积磨损（剩余寿命 = toolLife - toolWear）
//   - calDue:   距离量具校准到期的剩余加工时间
//   - budget:   本周维护预算余额
//   - pendingOps = ops.slice(opIndex)（派生量，不重复存储）

export function domainError(message) {
  const err = new Error(message);
  err.code = 'ERR_DOMAIN';
  return err;
}

export function preconditionError(message) {
  const err = new Error(message);
  err.code = 'ERR_PRECONDITION';
  return err;
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function validateProblem(problem) {
  if (problem === null || typeof problem !== 'object' || Array.isArray(problem)) {
    throw domainError('problem must be an object');
  }
  const { toolLife, calInterval, budget, costs, ops } = problem;
  if (!isNum(toolLife) || toolLife <= 0) {
    throw domainError('toolLife must be a positive finite number');
  }
  if (!isNum(calInterval) || calInterval <= 0) {
    throw domainError('calInterval must be a positive finite number');
  }
  if (!isNum(budget) || budget < 0) {
    throw domainError('budget must be a non-negative finite number');
  }
  for (const name of ['changeTool', 'calibrate']) {
    const c = costs?.[name];
    if (!c || !isNum(c.time) || c.time < 0 || !isNum(c.cost) || c.cost < 0) {
      throw domainError(`costs.${name} must have non-negative finite time and cost`);
    }
  }
  const initial = problem.initial ?? {};
  const toolWear = initial.toolWear ?? 0;
  const calDue = initial.calDue ?? calInterval;
  if (!isNum(toolWear) || toolWear < 0 || toolWear > toolLife) {
    throw domainError('initial.toolWear must be a finite number in [0, toolLife]');
  }
  if (!isNum(calDue) || calDue < 0 || calDue > calInterval) {
    throw domainError('initial.calDue must be a finite number in [0, calInterval]');
  }
  if (!Array.isArray(ops)) {
    throw domainError('ops must be an array');
  }
  const ids = new Set();
  ops.forEach((op, i) => {
    if (!op || typeof op.id !== 'string' || op.id.length === 0) {
      throw domainError(`ops[${i}].id must be a non-empty string`);
    }
    if (ids.has(op.id)) {
      throw domainError(`duplicate op id: ${op.id}`);
    }
    ids.add(op.id);
    if (!isNum(op.duration) || op.duration < 0) {
      throw domainError(`ops[${i}].duration must be a non-negative finite number`);
    }
    if (!isNum(op.wear) || op.wear < 0) {
      throw domainError(`ops[${i}].wear must be a non-negative finite number`);
    }
  });
  const relax = problem.relax ?? {};
  const skipCalDueOpIds = relax.skipCalDueOpIds ?? [];
  const extraBudget = relax.extraBudget ?? 0;
  if (!Array.isArray(skipCalDueOpIds) || skipCalDueOpIds.some((id) => !ids.has(id))) {
    throw domainError('relax.skipCalDueOpIds must be an array of existing op ids');
  }
  if (!isNum(extraBudget) || extraBudget < 0) {
    throw domainError('relax.extraBudget must be a non-negative finite number');
  }
  return {
    toolLife,
    calInterval,
    budget,
    costs: {
      changeTool: { time: costs.changeTool.time, cost: costs.changeTool.cost },
      calibrate: { time: costs.calibrate.time, cost: costs.calibrate.cost },
    },
    initial: { toolWear, calDue },
    ops: ops.map((op) => ({ id: op.id, duration: op.duration, wear: op.wear })),
    relax: { skipCalDueOpIds: [...skipCalDueOpIds], extraBudget },
  };
}

export function initialState(problem) {
  return {
    toolWear: problem.initial.toolWear,
    calDue: problem.initial.calDue,
    budget: problem.budget + problem.relax.extraBudget,
    opIndex: 0,
    downtime: 0,
  };
}

// 动作前置条件检查；返回 { ok, reason? }。
export function canApply(problem, state, action) {
  if (action.type === 'changeTool') {
    return state.budget >= problem.costs.changeTool.cost
      ? { ok: true }
      : { ok: false, reason: 'changeTool: insufficient budget' };
  }
  if (action.type === 'calibrate') {
    return state.budget >= problem.costs.calibrate.cost
      ? { ok: true }
      : { ok: false, reason: 'calibrate: insufficient budget' };
  }
  if (action.type === 'run') {
    const op = problem.ops[state.opIndex];
    if (!op) return { ok: false, reason: 'run: no pending operations' };
    if (state.toolWear + op.wear > problem.toolLife) {
      return { ok: false, reason: `run ${op.id}: tool life exceeded` };
    }
    if (!problem.relax.skipCalDueOpIds.includes(op.id) && op.duration > state.calDue) {
      return { ok: false, reason: `run ${op.id}: calibration due` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unknown action type: ${action.type}` };
}

// 状态转移（假定前置条件已满足）。
export function transition(problem, state, action) {
  if (action.type === 'changeTool') {
    return {
      ...state,
      toolWear: 0,
      budget: state.budget - problem.costs.changeTool.cost,
      downtime: state.downtime + problem.costs.changeTool.time,
    };
  }
  if (action.type === 'calibrate') {
    return {
      ...state,
      calDue: problem.calInterval,
      budget: state.budget - problem.costs.calibrate.cost,
      downtime: state.downtime + problem.costs.calibrate.time,
    };
  }
  const op = problem.ops[state.opIndex];
  return {
    ...state,
    toolWear: state.toolWear + op.wear,
    calDue: state.calDue - op.duration,
    opIndex: state.opIndex + 1,
  };
}

// 搜索动作空间。无效果维护动作（磨损为 0 时换刀 / 校准时 calDue 已满）
// 只增加停机与预算消耗，被任何包含它的计划严格支配，故从动作空间剔除；
// 这保证动作空间有限且最优并列解集不变。
export function applicableActions(problem, state) {
  const actions = [];
  const op = problem.ops[state.opIndex];
  if (op) {
    const run = { type: 'run', op: op.id };
    if (canApply(problem, state, run).ok) actions.push(run);
  }
  if (state.toolWear > 0 && state.budget >= problem.costs.changeTool.cost) {
    actions.push({ type: 'changeTool' });
  }
  if (state.calDue < problem.calInterval && state.budget >= problem.costs.calibrate.cost) {
    actions.push({ type: 'calibrate' });
  }
  return actions;
}

export function actionToString(action) {
  return action.type === 'run' ? `run:${action.op}` : action.type;
}

export function compareActionSeqs(seqA, seqB) {
  const n = Math.min(seqA.length, seqB.length);
  for (let i = 0; i < n; i += 1) {
    const a = actionToString(seqA[i]);
    const b = actionToString(seqB[i]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return seqA.length - seqB.length;
}

// 并列最优排序键：停机升序 → 预算余量降序 → 动作序列字典序。
export function comparePlans(planA, planB) {
  if (planA.downtime !== planB.downtime) return planA.downtime - planB.downtime;
  if (planA.budgetRemaining !== planB.budgetRemaining) {
    return planB.budgetRemaining - planA.budgetRemaining;
  }
  return compareActionSeqs(planA.actions, planB.actions);
}

export function stateKey(state) {
  return `${state.toolWear}|${state.calDue}|${state.budget}|${state.opIndex}`;
}
