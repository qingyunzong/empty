# rolelib

Go 标准库实现的角色库：角色继承、授予与激活，静态/动态禁则分离检查。

## 模型

- **继承**：`AddInheritance(child, parent)` 表示 child 继承 parent，持有 child
  即（传递地）持有 parent。成环的继承边被拒绝（`CycleError`，含环路径）。
- **授予**：`Grant` / `GrantBatch` 授予用户角色；`EffectiveRoles` 返回直接授予
  沿继承闭包展开后的有效角色集。
- **激活**：`OpenSession` 开启会话，`Activate` 只能激活用户有效持有的角色；
  `Revoke` / `RemoveInheritance` 会自动失活不再持有的已激活角色。
- **SSD（静态禁同持）**：`AddSSD(a, b)`，两个角色不得被同一用户同时（含经继承
  间接）持有，在授予、新增约束、新增继承边时检查。
- **DSD（动态禁同激活）**：`AddDSD(a, b)`，两个角色不得在同一会话中同时（含经
  继承间接）激活，在激活、新增约束、新增继承边时检查。SSD 与 DSD 分别检查，
  互不影响（DSD 角色可同时持有，SSD 角色可在不同时刻分别激活）。

## 原子性与冲突报告

- `GrantBatch` 原子执行：批次与既有授予冲突、或批次内部冲突时，整批不生效。
- 继承带来的间接冲突同样被拒绝：授予、激活、新增继承边、新增约束都会沿继承
  闭包检查。
- 冲突以 `ConflictError` 返回，携带 `Conflict{Kind, RoleA, RoleB, ChainA,
  ChainB}`：`ChainA`/`ChainB` 是从授予（SSD）或激活（DSD）角色到冲突端点的
  **最短继承链**（多源 BFS 求得；多对约束同时违反时取总链长最短者）。

## 全闭包模型对照

`naive.go` 中的 `Naive` 是同一语义的独立参照实现：只存原始事实，每次操作
从完整继承闭包重算并穷举所有约束对校验。`differential_test.go` 用随机操作
序列（60 个种子 × 400 步，覆盖继承增删、SSD/DSD、授予/批授予/撤销、会话
开关与激活/失活）对两个实现做差分对照：接受/拒绝决定、错误类型、冲突链
总长、用户有效角色集、会话激活角色集必须完全一致。

## 测试

```sh
go test ./...
```

实际运行结果见 `RESULTS.md`。
