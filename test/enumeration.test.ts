import { test } from "node:test";
import assert from "node:assert";
import { planDeliveries, DeliveryEvent, DeliveryPlan } from "../src/scheduler";

/**
 * 小 DAG 枚举核对:
 * 枚举 n<=4 个节点上的全部 DAG(每对节点: 无边/两个方向, 过滤有环图),
 * 乘以全部 {1,2} 优先级向量(外加一个全异优先级向量)与全部取消子集,
 * 用测试内独立的参考实现逐步核对调度结果与全部不变量。
 */

interface RefInput {
  ids: string[];
  deps: Map<string, string[]>;
  priority: Map<string, number>;
  cancelled: Set<string>;
}

/** 独立参考实现: 直接按规则定义逐步模拟。 */
function referenceSchedule(input: RefInput): { order: string[]; blocked: Set<string> } {
  const dependents = new Map<string, string[]>();
  for (const id of input.ids) dependents.set(id, []);
  for (const [id, deps] of input.deps) {
    for (const d of deps) dependents.get(d)!.push(id);
  }
  // 阻塞 = 从被取消节点沿 dependents 可达。
  const blocked = new Set<string>();
  const stack = [...input.cancelled];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const nxt of dependents.get(cur)!) {
      if (!blocked.has(nxt) && !input.cancelled.has(nxt)) {
        blocked.add(nxt);
        stack.push(nxt);
      }
    }
  }
  const delivered = new Set<string>();
  const order: string[] = [];
  for (;;) {
    let best: string | null = null;
    for (const id of input.ids) {
      if (input.cancelled.has(id) || blocked.has(id) || delivered.has(id)) continue;
      const deps = input.deps.get(id)!;
      if (!deps.every((d) => delivered.has(d))) continue;
      if (
        best === null ||
        input.priority.get(id)! > input.priority.get(best)! ||
        (input.priority.get(id)! === input.priority.get(best)! && id < best)
      ) {
        best = id;
      }
    }
    if (best === null) break;
    delivered.add(best);
    order.push(best);
  }
  return { order, blocked };
}

function checkPlan(
  events: DeliveryEvent[],
  cancelledIds: string[],
  plan: DeliveryPlan,
  input: RefInput,
): void {
  const ref = referenceSchedule(input);
  const deliveredIds = plan.deliveries.map((d) => d.eventId);
  const label = `events=${JSON.stringify(events.map((e) => [e.id, e.priority, e.deps]))} cancelled=${JSON.stringify(cancelledIds)}`;

  // 1) 交付序列与独立参考实现完全一致(含贪心选择规则)。
  assert.deepStrictEqual(deliveredIds, ref.order, label);

  // 2) 因果性: 每个已交付事件的依赖都排在它之前。
  const position = new Map<string, number>();
  plan.deliveries.forEach((d, i) => position.set(d.eventId, i));
  for (const d of plan.deliveries) {
    for (const s of d.satisfiedDeps) {
      assert.ok(position.get(s.depId)! < position.get(d.eventId)!, label);
      assert.strictEqual(s.deliveredAt, position.get(s.depId), label);
    }
  }

  // 3) 证书序号从 0 连续编号。
  assert.deepStrictEqual(
    plan.deliveries.map((d) => d.sequence),
    plan.deliveries.map((_, i) => i),
    label,
  );

  // 4) 阻塞集合与参考实现一致。
  assert.deepStrictEqual(
    new Set(plan.blocked.map((b) => b.eventId)),
    ref.blocked,
    label,
  );

  // 5) 交付/阻塞/取消三者互斥且覆盖全部事件。
  const all = new Set(input.ids);
  const seen = new Set<string>();
  for (const id of [...deliveredIds, ...plan.blocked.map((b) => b.eventId), ...plan.cancelled.map((c) => c.eventId)]) {
    assert.ok(!seen.has(id), `overlap: ${id} ${label}`);
    seen.add(id);
  }
  assert.deepStrictEqual(seen, all, label);

  // 6) 取消事件元数据保留。
  const metaById = new Map(events.map((e) => [e.id, e.metadata ?? {}]));
  assert.deepStrictEqual(
    new Set(plan.cancelled.map((c) => c.eventId)),
    new Set(cancelledIds),
    label,
  );
  for (const c of plan.cancelled) {
    assert.deepStrictEqual(c.metadata, metaById.get(c.eventId), label);
  }

  // 7) 阻塞链良构: 起点是被取消事件, 终点是被阻塞事件, 相邻边为依赖关系。
  const cancelledSet = new Set(cancelledIds);
  for (const b of plan.blocked) {
    assert.ok(b.chains.length >= 1, label);
    for (const chain of b.chains) {
      const path = chain.path;
      assert.ok(cancelledSet.has(path[0]!), label);
      assert.strictEqual(path[path.length - 1], b.eventId, label);
      for (let i = 0; i + 1 < path.length; i++) {
        assert.ok(input.deps.get(path[i + 1]!)!.includes(path[i]!), label);
      }
    }
  }
}

function isAcyclic(ids: string[], deps: Map<string, string[]>): boolean {
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const [, ds] of deps) for (const d of ds) indegree.set(d, 0);
  for (const [id, ds] of deps) indegree.set(id, ds.length);
  const queue = ids.filter((id) => indegree.get(id) === 0);
  let count = 0;
  const dependents = new Map<string, string[]>();
  for (const id of ids) dependents.set(id, []);
  for (const [id, ds] of deps) for (const d of ds) dependents.get(d)!.push(id);
  while (queue.length > 0) {
    const cur = queue.pop()!;
    count++;
    for (const nxt of dependents.get(cur)!) {
      indegree.set(nxt, indegree.get(nxt)! - 1);
      if (indegree.get(nxt) === 0) queue.push(nxt);
    }
  }
  return count === ids.length;
}

test("小 DAG 枚举核对 (n<=4, 全部 DAG x 优先级 x 取消子集)", () => {
  let cases = 0;
  let dagCount = 0;
  for (let n = 1; n <= 4; n++) {
    const ids = ["a", "b", "c", "d"].slice(0, n);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) pairs.push([ids[i]!, ids[j]!]);
    }
    const graphCount = 3 ** pairs.length;
    const priorityVectors = 2 ** n;
    const cancelSubsets = 2 ** n;

    for (let g = 0; g < graphCount; g++) {
      // 每对节点三种选择: 无边 / i 依赖 j / j 依赖 i。
      const deps = new Map<string, string[]>();
      for (const id of ids) deps.set(id, []);
      let rem = g;
      for (const [u, v] of pairs) {
        const choice = rem % 3;
        rem = Math.floor(rem / 3);
        if (choice === 1) deps.get(u)!.push(v);
        if (choice === 2) deps.get(v)!.push(u);
      }
      if (!isAcyclic(ids, deps)) continue;
      dagCount++;

      for (let pv = 0; pv <= priorityVectors; pv++) {
        // pv < 2^n: {1,2} 优先级向量; pv == 2^n: 全异优先级(按下标)。
        const priority = new Map<string, number>();
        ids.forEach((id, idx) => {
          priority.set(id, pv === priorityVectors ? idx + 1 : ((pv >> idx) & 1) + 1);
        });

        for (let cs = 0; cs < cancelSubsets; cs++) {
          const cancelledIds = ids.filter((_, idx) => (cs >> idx) & 1);
          const events: DeliveryEvent[] = ids.map((id) => ({
            id,
            priority: priority.get(id)!,
            deps: deps.get(id)!,
            metadata: { tag: `meta-${id}` },
          }));
          const plan = planDeliveries(events, cancelledIds);
          checkPlan(events, cancelledIds, plan, {
            ids,
            deps,
            priority,
            cancelled: new Set(cancelledIds),
          });
          cases++;
        }
      }
    }
  }
  console.log(`enumerated ${dagCount} DAGs, verified ${cases} scheduling cases`);
  assert.ok(cases > 100000, `expected exhaustive coverage, got ${cases}`);
});
