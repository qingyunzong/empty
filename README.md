# 树形整数拨款优化器

从拨款库向树叶分配**整数**额度, 最大化总收益; 收益并列时取**总拨款更小**、
再并列时取**叶拨款向量字典序更小**(叶按先序编号)的解。

## 问题模型

- 每个节点(内部或叶)带有汇总上下界 `[min, max]`, 约束其子树拨款之和。
- 叶收益由输入离散表 `payoff[x]` 给出, **不保证凹性**, 因此按精确 DP/枚举处理,
  不依赖任何凸性/边际递减假设。
- 总预算 `totalBudget ≤ 80`, 覆盖拨款与启动费。
- 扩展耦合(见下)最多 **10 条跨子树差值约束** + 每叶**固定启动费**。

```jsonc
{
  "totalBudget": 8,
  "root": { "kind": "internal", "id": "R", "min": 0, "max": 80, "children": [
    { "kind": "leaf", "id": "a", "min": 0, "max": 4, "payoff": [0,1,2,3,20], "startupFee": 2 }
  ]},
  "cross": [{ "leafA": "a", "leafB": "d", "maxDiff": 1 }]   // |x_a - x_d| <= 1
}
```

## 求解路径

- **无耦合**(无 `cross`、无 `startupFee`): 树 DP(`src/dp.ts`)。
  每节点维护「子树汇总恰为 s 的最优(收益, 叶向量)」表, 自底向上背包卷积,
  每节点应用其汇总上下界; 一次闭合, 直接标 `optimal`。
- **有耦合**: 跨子树约束与启动费使子树**不能独立优化后拼接**,
  改用全树分支限界(`src/search.ts`): 以后缀背包 DP 作收益上界,
  节点汇总界做部分赋值可行性剪枝, 输出全树额度与**跨边证书**
  (`crossCertificates`, 逐条记录两端取值、差值、界与是否满足)。

## 工作预算与续算

耦合求解接受 `workBudget`(搜索节点访问量上限)。预算耗尽即暂停,
返回的 `state` 可 JSON 序列化、可续算(`solve(problem, { state, workBudget })`)。
**未闭合(`closed: false`)时 `status` 只为 `feasible`/`unknown`, 绝不标 `optimal`**;
枚举空间耗尽后 `closed: true`, 方可标 `optimal`/`infeasible`。

## 核验

`src/bruteforce.ts` 提供叶向量全枚举核验器(检查全部约束、同一优胜序),
`solutionMatchesEnumeration` 比对 DP/搜索解与枚举最优是否一致;
随机化测试在 60 个随机实例(含非凹收益、启动费、跨约束)上保持一致。

## 使用

```bash
npm test                                  # 编译并运行全部测试
npm run solve -- examples/plain.json --verify
npm run solve -- examples/coupled.json --budget 100
```

输出含: `status`/`closed`、总收益、各叶拨款 `allocation`、
**各节点汇总** `nodeSums`、跨边证书 `crossCertificates`、已探索节点数。
