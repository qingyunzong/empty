# 可嵌入增量视图维护组件

一个零运行时依赖的 TypeScript 物化视图组件。源表上的
`insert` / `update` / `delete` 会以行级增量传播到投影、连接、分组聚合
以及由视图继续派生的级联视图。

## 构建与测试

```bash
npm run build
npm test
```

`npm test` 会先编译到 `build/`，再运行 `node:test`。测试包含四千余条穷举
变更序列、长随机序列、事务回滚/保存点交错、自连接和菱形依赖场景；每一步
都将所有物化视图与独立实现的朴素全量重算逐行比较。

## 快速开始

```ts
import {
  Database,
  avg,
  count,
  max,
  min,
  sum,
} from "./build/index.js";

interface Employee {
  id: string;
  departmentId: string;
  salary: number;
  active: boolean;
}

interface Department {
  id: string;
  name: string;
}

const db = new Database();
const employees = db.table<Employee>("employees", { key: "id" });
const departments = db.table<Department>("departments", { key: "id" });

// 1. 连接视图：from 为元组时，回调参数按元组展开。
const enriched = db.view("enriched_employees", {
  from: [employees, departments] as const,
  where: (employee, department) =>
    employee.active && employee.departmentId === department.id,
  key: (employee) => employee.id,
  select: (employee, department) => ({
    id: employee.id,
    department: department.name,
    salary: employee.salary,
  }),
});

// 2. 聚合视图：只维护受影响的分组。
const departmentStats = db.view("department_stats", {
  from: enriched,
  groupBy: (employee) => employee.department,
  aggregates: {
    headcount: count(),
    payroll: sum((employee) => employee.salary),
    average: avg((employee) => employee.salary),
    lowest: min((employee) => employee.salary),
    highest: max((employee) => employee.salary),
  },
  select: (department, values) => ({ department, ...values }),
});

// 3. 级联聚合：依赖 departmentStats，自动排在它之后更新。
const totals = db.view("company_totals", {
  from: departmentStats,
  groupBy: () => "all",
  aggregates: {
    departments: count(),
    employees: sum((row) => row.headcount),
    payroll: sum((row) => row.payroll),
  },
  select: (scope, values) => ({ scope, ...values }),
});

departments.insert({ id: "eng", name: "Engineering" });
employees.insert({
  id: "e1",
  departmentId: "eng",
  salary: 100,
  active: true,
});

console.log(departmentStats.get("Engineering"));
// { department: "Engineering", headcount: 1, payroll: 100, ... }
```

## 输入形态

`from` 支持三种形态，分别对应三种回调调用方式：

| `from` | 回调参数 |
| --- | --- |
| `table` / `view` | `select: (row) => ...` |
| `[left, right] as const` | `select: (left, right) => ...`，多个源按位置展开 |
| `{ e: employees, d: departments }` | `select: ({ e, d }) => ...` |

连接谓词写在 `where` 中。例如：

```ts
const named = db.view("named_orders", {
  from: { order: orders, customer: customers },
  where: ({ order, customer }) => order.customerId === customer.id,
  key: ({ order }) => order.id,
  select: ({ order, customer }) => ({
    id: order.id,
    customer: customer.name,
    amount: order.amount,
  }),
});
```

扁平视图的输出键由 `key` 指定。单输入视图省略 `key` 时沿用输入行的键；
多输入视图省略时使用各输入行键的组合。输出键必须唯一。

## 聚合

聚合视图使用 `groupBy` + `aggregates` + `select`：

```ts
const byCustomer = db.view("customer_totals", {
  from: orders,
  groupBy: (order) => order.customerId,
  aggregates: {
    orders: count("*"),
    revenue: sum((order) => order.amount),
    average: avg((order) => order.amount),
    smallest: min((order) => order.amount),
    largest: max((order) => order.amount),
    products: distinctCount((order) => order.productId),
  },
  having: (_customerId, values) => values.orders >= 2,
  select: (customerId, values) => ({ customerId, ...values }),
});
```

内置聚合：

- `count()` / `count("*")`：贡献行数。
- `count(fn)`：`fn` 结果非 `null` / `undefined` 的行数。
- `sum(fn)`：可加数值和，空集合为 `0`。
- `avg(fn)`：由维护的 `sum` 与 `count` 计算，空集合为 `undefined`。
- `min(fn)` / `max(fn)`：维护值频次，删除当前极值时只重算该分组。
- `distinctCount(fn)`：维护去重值的频次。
- `defineAggregate({ initial, add, remove, value })`：自定义可逆聚合。

分组键默认为聚合视图的输出键；需要不同输出键时传入
`key: (groupKey, values) => ...`。

## 变更 API

```ts
// 单行操作；每次操作自动成为一个原子传播单元。
employees.insert({ id: "e2", departmentId: "eng", salary: 120, active: true });
employees.update("e2", { salary: 130 });
employees.delete("e2");

// 批量变更序列；任一步失败则整批回滚。
db.applyChanges([
  { type: "insert", table: "departments", row: { id: "ops", name: "Ops" } },
  { type: "insert", table: employees, row: { id: "e3", departmentId: "ops", salary: 90, active: true } },
  { type: "update", table: "employees", key: "e3", patch: { salary: 95 } },
  { type: "delete", table: "departments", key: "ops" },
]);
```

`update` 支持部分字段补丁或更新函数：

```ts
employees.update("e3", (row) => ({ ...row, salary: row.salary + 10 }));
```

## 事务与回滚

```ts
const tx = db.begin();
try {
  tx.update(employees, "e1", { salary: 500 });
  tx.insert(departments, { id: "tmp", name: "Temporary" });
  tx.commit();
} catch (error) {
  if (tx.active) tx.rollback();
  throw error;
}

// 回调返回值也可以是 Promise；异常或 reject 会自动回滚。
await db.transaction(async (tx) => {
  tx.update(employees, "e1", { salary: 200 });
});
```

`db.begin()` 可嵌套形成保存点：内层回滚只撤销内层变更，外层仍可提交或
回滚。回滚会恢复源表日志并重建物化视图，因此此前已经传播的聚合增减不会
留下重复计数。

## 一致性与诊断

```ts
departmentStats.toArray();
departmentStats.get("Engineering");
departmentStats.snapshot();      // 当前物化结果的 Map 副本
departmentStats.compute();       // 从当前输入朴素重算，不修改物化状态
departmentStats.verify();        // 不一致时抛错
db.verifyAll();
db.recomputeAll();
db.topologicalOrder();           // 视图名按依赖拓扑排序
```

`view.dependencies` 返回直接上游名称。`db.onChange(listener)` 会在每次视图
行级变化后通知，级联场景中事件顺序与拓扑顺序一致。

`view.stats` / `db.stats` 提供维护诊断：

- `affectedInputRows`：本次传播涉及的输入行数（前后状态分别计数）。
- `tuplesExamined`：实际检查的连接元组数。
- `groupsUpdated`：实际重新渲染的聚合分组数。
- `aggregateAdds` / `aggregateRemoves`：聚合累加器的增减次数。
- `recomputes`：显式全量重算次数。

普通源表变更不会触发全量重算：连接只枚举变更行涉及的组合，聚合只更新
受影响分组，级联视图按依赖顺序接收行级差值。

## 关键不变量

1. 每个源变更产生唯一的前后行差值，视图输出只根据受影响键更新。
2. 连接维护枚举“变更行 × 其他输入当前/变更前状态”，对重复路径按
   元组签名去重，因此菱形依赖和自连接不会重复增减。
3. `count` / `sum` / `avg` 使用可逆累加器；删除和更新严格对称地减少。
4. 分组输出只在 `having` 可见性、分组键或聚合值实际变化时传播到下游。
5. 视图只能引用已注册的数据源，更新严格按拓扑顺序执行。
6. 事务回滚恢复源表后重建物化结果，不保留任何已回滚的计数。

## 目录

- `src/core.ts`：表、视图、拓扑调度、事务与增量维护。
- `src/aggregates.ts`：可逆聚合累加器。
- `src/canonical.ts`：稳定键与结构比较。
- `test/view-maintenance.test.ts`：穷举、随机、回滚与级联一致性测试。
