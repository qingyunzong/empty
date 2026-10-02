// 增量会话：加载 DSL、命名保存点、增量 add-task、回滚（回滚同时清理 VM 缓存）
import { parseSite, parseFragment } from './parser.js';
import { check } from './types.js';
import { solve, CMP_EPS } from './solver.js';
import { VM } from './vm.js';

export function applyBudget(spec, result) {
  if (result.status !== 'FEASIBLE') return result;
  const exceeded = [];
  if (spec.budgets.cost != null && result.cost > spec.budgets.cost + CMP_EPS) exceeded.push('cost');
  if (spec.budgets.carbon != null && result.carbon > spec.budgets.carbon + CMP_EPS) exceeded.push('carbon');
  if (exceeded.length > 0) return { ...result, status: 'OVER_BUDGET', exceeded };
  return result;
}

export class Session {
  constructor() {
    this.vm = new VM();
    this.site = null;
    this.spec = null;
    this.savepoints = new Map();
    this.filename = '<session>';
  }

  load(text, filename = '<input>') {
    this.filename = filename;
    this.site = parseSite(text);
    this.spec = check(this.site);
    this.vm = new VM();
    this.savepoints.clear();
  }

  requireLoaded() {
    if (!this.site) throw new Error('尚未加载 DSL');
  }

  savepoint(name) {
    this.requireLoaded();
    this.savepoints.set(name, {
      tasks: this.site.tasks.length,
      orders: this.site.orders.length,
      cache: this.vm.snapshot(),
    });
  }

  addTaskDsl(text) {
    this.requireLoaded();
    const frag = parseFragment(text);
    this.site.tasks.push(...frag.tasks);
    this.site.orders.push(...frag.orders);
    this.spec = check(this.site);
  }

  rollback(name) {
    this.requireLoaded();
    const sp = this.savepoints.get(name);
    if (!sp) throw new Error(`保存点 "${name}" 不存在`);
    this.site.tasks.length = sp.tasks;
    this.site.orders.length = sp.orders;
    this.vm.rollbackTo(sp.cache);
    this.spec = check(this.site);
  }

  solve() {
    this.requireLoaded();
    return applyBudget(this.spec, solve(this.spec, this.vm));
  }
}
