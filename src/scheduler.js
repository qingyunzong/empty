'use strict';

// CNC 产线离线排程:刀具更换 / 量具校准 / 运行工序。
// 状态: { toolWear, calDue, budget, time, ops: [{index, wear, duration}] }
// 目标: 最小化停机; 并列按 (停机, 预算消耗, 动作数) 字典序保留全部。

function domainError(message) {
  const err = new Error(message);
  err.code = 'ERR_DOMAIN';
  return err;
}

function checkFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw domainError(`${name} must be a finite number, got ${String(value)}`);
  }
}

function checkNonNegative(value, name) {
  checkFinite(value, name);
  if (value < 0) throw domainError(`${name} must be >= 0, got ${value}`);
}

function normalizeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw domainError('config must be an object');
  }
  const config = {
    toolLife: raw.toolLife,
    toolWear: raw.toolWear,
    calInterval: raw.calInterval,
    calDue: raw.calDue,
    budget: raw.budget,
    costs: {
      changeTool: { time: 0, money: 0, ...(raw.costs && raw.costs.changeTool) },
      calibrate: { time: 0, money: 0, ...(raw.costs && raw.costs.calibrate) },
    },
    ops: raw.ops,
    exemptOps: Array.isArray(raw.exemptOps) ? [...raw.exemptOps] : [],
  };
  checkNonNegative(config.toolLife, 'toolLife');
  checkNonNegative(config.toolWear, 'toolWear'); // NaN 寿命 -> ERR_DOMAIN
  checkNonNegative(config.calInterval, 'calInterval');
  checkNonNegative(config.calDue, 'calDue');
  checkNonNegative(config.budget, 'budget'); // 负预算 -> ERR_DOMAIN
  for (const [action, cost] of Object.entries(config.costs)) {
    checkNonNegative(cost.time, `costs.${action}.time`);
    checkNonNegative(cost.money, `costs.${action}.money`);
  }
  if (!Array.isArray(config.ops)) throw domainError('ops must be an array');
  config.ops = config.ops.map((op, i) => {
    if (op === null || typeof op !== 'object') throw domainError(`ops[${i}] must be an object`);
    checkNonNegative(op.wear, `ops[${i}].wear`);
    checkNonNegative(op.duration, `ops[${i}].duration`);
    return { index: i, wear: op.wear, duration: op.duration };
  });
  for (const idx of config.exemptOps) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= config.ops.length) {
      throw domainError(`exemptOps contains invalid op index ${String(idx)}`);
    }
  }
  return config;
}

function initialState(config) {
  return {
    toolWear: config.toolWear,
    calDue: config.calDue,
    budget: config.budget,
    time: 0,
    ops: config.ops.map((op) => ({ ...op })),
  };
}

function stateKey(state) {
  return JSON.stringify([
    state.toolWear, state.calDue, state.budget, state.time,
    state.ops.map((op) => [op.index, op.wear, op.duration]),
  ]);
}

// 动作前后条件: 返回当前状态下可执行的动作列表。
function applicableActions(state, config) {
  const actions = [];
  const op = state.ops[0];
  if (op) {
    const exempt = config.exemptOps.includes(op.index);
    const wearOk = op.wear <= state.toolWear;
    const calOk = exempt || state.time + op.duration <= state.calDue;
    if (wearOk && calOk) actions.push({ type: 'run' });
  }
  const toolCost = config.costs.changeTool;
  if (state.budget >= toolCost.money && state.toolWear < config.toolLife) {
    actions.push({ type: 'changeTool' });
  }
  const calCost = config.costs.calibrate;
  if (state.budget >= calCost.money && state.calDue < state.time + config.calInterval) {
    actions.push({ type: 'calibrate' });
  }
  return actions;
}

function applyAction(state, action, config) {
  switch (action.type) {
    case 'run': {
      const op = state.ops[0];
      return {
        ...state,
        toolWear: state.toolWear - op.wear,
        time: state.time + op.duration,
        ops: state.ops.slice(1),
      };
    }
    case 'changeTool':
      return {
        ...state,
        toolWear: config.toolLife,
        time: state.time + config.costs.changeTool.time,
        budget: state.budget - config.costs.changeTool.money,
      };
    case 'calibrate':
      return {
        ...state,
        calDue: state.time + config.calInterval,
        time: state.time + config.costs.calibrate.time,
        budget: state.budget - config.costs.calibrate.money,
      };
    default:
      throw domainError(`unknown action type ${String(action.type)}`);
  }
}

// 动作成本: [停机, 预算消耗, 动作数]
function actionCost(action, config) {
  switch (action.type) {
    case 'run': return [0, 0, 1];
    case 'changeTool': return [config.costs.changeTool.time, config.costs.changeTool.money, 1];
    case 'calibrate': return [config.costs.calibrate.time, config.costs.calibrate.money, 1];
    default: throw domainError(`unknown action type ${String(action.type)}`);
  }
}

function cmpKey(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// 记忆化 DFS: 返回 { key, plans } 或 null(不可行)。穷举完备, 不存在 UNKNOWN。
function solveState(state, config, memo) {
  const key = stateKey(state);
  if (memo.has(key)) return memo.get(key);
  let result;
  if (state.ops.length === 0) {
    result = { key: [0, 0, 0], plans: [[]] };
  } else {
    let best = null;
    for (const action of applicableActions(state, config)) {
      const child = solveState(applyAction(state, action, config), config, memo);
      if (!child) continue;
      const cost = actionCost(action, config);
      const combined = [child.key[0] + cost[0], child.key[1] + cost[1], child.key[2] + 1];
      if (!best || cmpKey(combined, best.key) < 0) {
        best = { key: combined, plans: child.plans.map((p) => [action, ...p]) };
      } else if (cmpKey(combined, best.key) === 0) {
        for (const p of child.plans) best.plans.push([action, ...p]);
      }
    }
    result = best;
  }
  memo.set(key, result);
  return result;
}

// 增量搜索器: 维护路径栈, 支持撤销最近计划步并继续探索。
// memo 以状态为键, 撤销只放弃被撤销子树的未共享节点,
// 未受影响分支的缓存结果直接复用, 无需失效重算。
class Searcher {
  constructor(rawConfig, snapshotState) {
    this.config = normalizeConfig(rawConfig);
    this.states = [snapshotState ? JSON.parse(JSON.stringify(snapshotState)) : initialState(this.config)];
    this.path = [];
    this.memo = new Map();
  }

  static from(rawConfig, snapshot) {
    return new Searcher(rawConfig, JSON.parse(snapshot));
  }

  get state() {
    return this.states[this.states.length - 1];
  }

  applicable() {
    return applicableActions(this.state, this.config);
  }

  apply(action) {
    const legal = this.applicable().some((a) => a.type === action.type);
    if (!legal) throw domainError(`action ${String(action && action.type)} not applicable in current state`);
    this.states.push(applyAction(this.state, action, this.config));
    this.path.push({ type: action.type });
    return this.state;
  }

  undo() {
    if (this.path.length === 0) return false;
    this.path.pop();
    this.states.pop();
    return true;
  }

  snapshot() {
    return JSON.stringify(this.state);
  }

  solve() {
    return solveState(this.state, this.config, this.memo);
  }
}

// 独立全枚举(无 memo), 用于对照验证。
function enumerateOptimal(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const plans = [];
  const walk = (state, prefix) => {
    if (state.ops.length === 0) {
      plans.push(prefix);
      return;
    }
    for (const action of applicableActions(state, config)) {
      walk(applyAction(state, action, config), [...prefix, action]);
    }
  };
  walk(initialState(config), []);
  let best = null;
  for (const plan of plans) {
    const key = [0, 0, 0];
    for (const action of plan) {
      const cost = actionCost(action, config);
      key[0] += cost[0]; key[1] += cost[1]; key[2] += 1;
    }
    if (!best || cmpKey(key, best.key) < 0) best = { key, plans: [plan] };
    else if (cmpKey(key, best.key) === 0) best.plans.push(plan);
  }
  return best;
}

function objectiveOf(key) {
  return { downtime: key[0], budgetSpent: key[1], actions: key[2] };
}

// UNSAT 证书: 穷举完备(complete: true, 绝不以 UNKNOWN 冒充),
// 并列出经重新求解验证的单点松弛: 豁免一个工序的到期约束, 或预算 +1。
function buildCertificate(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const searcher = new Searcher(config);
  if (searcher.solve()) return null;
  const relaxations = [];
  for (const op of config.ops) {
    const relaxed = new Searcher({ ...config, exemptOps: [op.index] });
    const res = relaxed.solve();
    if (res) {
      relaxations.push({
        kind: 'removeCalDueConstraint',
        opIndex: op.index,
        feasible: true,
        objective: objectiveOf(res.key),
        plan: res.plans[0],
      });
    }
  }
  {
    const relaxed = new Searcher({ ...config, budget: config.budget + 1 });
    const res = relaxed.solve();
    if (res) {
      relaxations.push({
        kind: 'addBudget',
        amount: 1,
        feasible: true,
        objective: objectiveOf(res.key),
        plan: res.plans[0],
      });
    }
  }
  return {
    status: 'UNSAT',
    complete: true,
    statesExplored: searcher.memo.size,
    relaxations,
  };
}

// 复验证书: 原问题必须确实不可行; 每条松弛必须确实可行且目标值一致。
function verifyCertificate(rawConfig, cert) {
  if (!cert || cert.status !== 'UNSAT' || cert.complete !== true) return false;
  const config = normalizeConfig(rawConfig);
  if (new Searcher(config).solve()) return false;
  if (!Array.isArray(cert.relaxations) || cert.relaxations.length === 0) return false;
  for (const rel of cert.relaxations) {
    let relaxedConfig;
    if (rel.kind === 'removeCalDueConstraint') {
      relaxedConfig = { ...config, exemptOps: [rel.opIndex] };
    } else if (rel.kind === 'addBudget') {
      relaxedConfig = { ...config, budget: config.budget + rel.amount };
    } else {
      return false;
    }
    const res = new Searcher(relaxedConfig).solve();
    if (!res) return false;
    if (JSON.stringify(objectiveOf(res.key)) !== JSON.stringify(rel.objective)) return false;
  }
  return true;
}

module.exports = {
  Searcher,
  normalizeConfig,
  initialState,
  applicableActions,
  applyAction,
  enumerateOptimal,
  buildCertificate,
  verifyCertificate,
  objectiveOf,
};
