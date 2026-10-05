import { BoolExpr, conjuncts, conjoin, isNullRejecting, renderBool, uniqueCols } from './expr';
import { Plan, renderPlan, schemaOf } from './plan';

/** 一条公开可核查的前置条件。 */
export interface Precondition {
  name: string;
  holds: boolean;
  detail: string;
}

/** 重写证书：记录规则、前置条件核查结果、重写前后计划与合法性依据。 */
export interface Certificate {
  rule: string;
  applied: boolean;
  preconditions: Precondition[];
  before: string;
  after: string;
  justification: string;
}

export interface RewriteOutcome {
  plan: Plan;
  cert: Certificate;
}

function outcome(rule: string, before: Plan, after: Plan, pre: Precondition[], justification: string): RewriteOutcome {
  const applied = pre.every((p) => p.holds);
  return {
    plan: applied ? after : before,
    cert: {
      rule,
      applied,
      preconditions: pre,
      before: renderPlan(before),
      after: applied ? renderPlan(after) : '(unchanged)',
      justification: applied ? justification : '前置条件不满足，规则未执行',
    },
  };
}

const subset = (cols: string[], universe: string[]): boolean => cols.every((c) => universe.includes(c));

/** R1: 过滤下推穿过投影。前置：谓词引用的列全部被投影保留。 */
export function filterPushdownThroughProject(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'filter' || p.child.kind !== 'project') return null;
  const proj = p.child;
  const used = uniqueCols(p.pred);
  const pre: Precondition[] = [{
    name: 'pred-columns-preserved',
    holds: subset(used, proj.cols),
    detail: `谓词列 {${used.join(', ')}} ⊆ 投影列 {${proj.cols.join(', ')}}`,
  }];
  return outcome('filter-pushdown-through-project', p,
    { kind: 'project', cols: proj.cols, child: { kind: 'filter', pred: p.pred, child: proj.child } },
    pre, '投影不改写被保留列的值，先过滤再投影与先投影再过滤产生相同行多重集');
}

/** R2: 过滤下推入内连接两侧（按合取项拆分）。前置：被下推合取项只引用单侧列。 */
export function filterPushdownIntoInnerJoin(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'filter' || p.child.kind !== 'innerJoin') return null;
  const join = p.child;
  const ls = schemaOf(join.left);
  const rs = schemaOf(join.right);
  const leftItems: BoolExpr[] = [];
  const rightItems: BoolExpr[] = [];
  const rest: BoolExpr[] = [];
  for (const c of conjuncts(p.pred)) {
    const used = uniqueCols(c);
    if (subset(used, ls)) leftItems.push(c);
    else if (subset(used, rs)) rightItems.push(c);
    else rest.push(c);
  }
  const pre: Precondition[] = [{
    name: 'has-pushable-conjunct',
    holds: leftItems.length + rightItems.length > 0,
    detail: `可下推合取项: 左侧 ${leftItems.length} 个, 右侧 ${rightItems.length} 个`,
  }];
  const newLeft = leftItems.length ? { kind: 'filter', pred: conjoin(leftItems), child: join.left } as Plan : join.left;
  const newRight = rightItems.length ? { kind: 'filter', pred: conjoin(rightItems), child: join.right } as Plan : join.right;
  const newJoin: Plan = { kind: 'innerJoin', pred: join.pred, left: newLeft, right: newRight };
  const after: Plan = rest.length ? { kind: 'filter', pred: conjoin(rest), child: newJoin } : newJoin;
  return outcome('filter-pushdown-into-inner-join', p, after, pre,
    '内连接仅保留连接谓词为 TRUE 的行对；单侧过滤提前执行不改变可配对行集合（3VL 下 AND 为 TRUE 当且仅当各项均为 TRUE）');
}

/** R3: 过滤下推入左外连接的保留侧（左侧）。前置：合取项只引用左侧列。 */
export function filterPushdownIntoLeftJoin(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'filter' || p.child.kind !== 'leftJoin') return null;
  const join = p.child;
  const ls = schemaOf(join.left);
  const pushable: BoolExpr[] = [];
  const rest: BoolExpr[] = [];
  for (const c of conjuncts(p.pred)) {
    if (subset(uniqueCols(c), ls)) pushable.push(c);
    else rest.push(c);
  }
  const pre: Precondition[] = [{
    name: 'has-preserved-side-conjunct',
    holds: pushable.length > 0,
    detail: `仅引用保留侧列的合取项 ${pushable.length} 个`,
  }];
  const newLeft: Plan = pushable.length ? { kind: 'filter', pred: conjoin(pushable), child: join.left } : join.left;
  const newJoin: Plan = { kind: 'leftJoin', pred: join.pred, left: newLeft, right: join.right };
  const after: Plan = rest.length ? { kind: 'filter', pred: conjoin(rest), child: newJoin } : newJoin;
  return outcome('filter-pushdown-into-left-join-preserved-side', p, after, pre,
    '左外连接保留全部左行；对左行的过滤无论先于或后于连接执行，保留的行对及补 NULL 行完全一致');
}

/** R4: 左外连接 + 拒绝 NULL 的过滤 => 内连接。前置：过滤谓词对右侧列拒绝 NULL。 */
export function leftJoinToInnerJoin(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'filter' || p.child.kind !== 'leftJoin') return null;
  const join = p.child;
  const rs = schemaOf(join.right);
  const rejecting = isNullRejecting(p.pred, new Set(rs));
  const pre: Precondition[] = [{
    name: 'null-rejecting-on-nullable-side',
    holds: rejecting,
    detail: `谓词 ${renderBool(p.pred)} 在右侧列 {${rs.join(', ')}} 全为 NULL 时保证不为 TRUE`,
  }];
  const after: Plan = { kind: 'filter', pred: p.pred, child: { kind: 'innerJoin', pred: join.pred, left: join.left, right: join.right } };
  return outcome('left-join-to-inner-join', p, after, pre,
    '补 NULL 的行必被过滤（谓词不为 TRUE），故外连接与内连接结果相同');
}

/** R5: 内连接交换律（输出列序用投影恢复）。 */
export function innerJoinCommute(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'innerJoin') return null;
  const originalSchema = schemaOf(p);
  const swapped: Plan = { kind: 'innerJoin', pred: p.pred, left: p.right, right: p.left };
  const after: Plan = { kind: 'project', cols: originalSchema, child: swapped };
  return outcome('inner-join-commute', p, after, [],
    '内连接结果与两侧顺序无关（行对集合相同）；投影恢复原列序');
}

/** R6: 恒等投影消除。前置：投影列与子计划输出模式完全一致（含顺序）。 */
export function projectElimination(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'project') return null;
  const childSchema = schemaOf(p.child);
  const same = p.cols.length === childSchema.length && p.cols.every((c, i) => c === childSchema[i]);
  const pre: Precondition[] = [{
    name: 'identity-projection',
    holds: same,
    detail: `投影列 [${p.cols.join(', ')}] === 子模式 [${childSchema.join(', ')}]`,
  }];
  return outcome('project-elimination', p, p.child, pre,
    '投影列与子计划输出完全一致，投影为恒等映射');
}

/** R7: 级联投影合并。前置：外层投影列 ⊆ 内层投影列。 */
export function projectCollapse(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'project' || p.child.kind !== 'project') return null;
  const inner = p.child;
  const pre: Precondition[] = [{
    name: 'outer-subset-of-inner',
    holds: subset(p.cols, inner.cols),
    detail: `外层列 {${p.cols.join(', ')}} ⊆ 内层列 {${inner.cols.join(', ')}}`,
  }];
  return outcome('project-collapse', p, { kind: 'project', cols: p.cols, child: inner.child }, pre,
    '连续两次投影等价于直接投影到最终列集');
}

/** R8: 级联过滤合并为合取。 */
export function filterMerge(p: Plan): RewriteOutcome | null {
  if (p.kind !== 'filter' || p.child.kind !== 'filter') return null;
  const inner = p.child;
  const after: Plan = { kind: 'filter', pred: conjoin([...conjuncts(p.pred), ...conjuncts(inner.pred)]), child: inner.child };
  return outcome('filter-merge', p, after, [],
    '行同时通过两个过滤当且仅当合取为 TRUE（3VL 下 AND 的 TRUE 语义）');
}

/** 优化器自动使用的规则（均朝规范化方向，保证终止）。交换律不自动应用。 */
export const NORMALIZING_RULES = [
  filterPushdownThroughProject,
  filterPushdownIntoInnerJoin,
  filterPushdownIntoLeftJoin,
  leftJoinToInnerJoin,
  projectElimination,
  projectCollapse,
  filterMerge,
] as const;

/** 全部已公开规则（含按需使用的交换律）。 */
export const ALL_RULES = [...NORMALIZING_RULES, innerJoinCommute] as const;
