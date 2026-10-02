# batch-alloc

离线库存批分配库与 CLI。Node.js 22 标准库实现，无第三方依赖，测试使用 `node:test`。

## 模型

- **批次**：`{ id, material, quantity, allocated, expiryDate, qualityStatus, location }`
- **订单**：`{ id, material, quantity, location, date, minRemainingShelfLifeDays?, transferCostPerUnit? }`
- **分配规则**：同物料、非隔离（`qualityStatus !== 'quarantined'`）、同库位或支付给定移库成本
  （`order.transferCostPerUnit`，缺省取 `state.config.transferCostPerUnit`），近效期优先（FEFO）。

## 求解器（`src/solver.js`）

有限域 CSP + 回溯（branch-and-bound）：

- 每个候选批一个整数变量，域为 `[0, min(可用量, 需求)]`；
- 传播：质量状态/物料/效期/库位过滤剪枝；数量上下界传播——批的强制下界 =
  需求 − 其余批上界之和，上界后缀和不足以达到需求时剪枝，域清空即回溯；
- 目标（字典序）：1) 最小化总移库成本；2) 并列时最小化已用批的最大剩余效期；
- `--budget N` 限制搜索节点数，耗尽返回 `unknown`（保留当前 incumbent）；
- 不可行返回订单/批次冲突列表（物料不符、隔离、效期不足、库位不可达、总量不足）。

## 事务与持久化（`src/allocator.js`、`src/store.js`）

一次订单为事务：先求解，再应用到内存状态，再原子落盘（写 `state.json.tmp-<pid>` →
fsync → rename）。任一步失败均不产生部分占用：

- 求解不可行/unknown：内存与磁盘均不变；
- rename 前故障（或 `--fail-before-rename` 注入）：删除临时文件、原 `state.json`
  字节不变、内存分配回滚，CLI 退出码 3；重试可得到完整结果。

## CLI

```
node bin/alloc.js allocate --state state.json --order order.json [--budget N] [--fail-before-rename]
```

退出码：`0` 已分配并落盘；`1` 不可行（stdout 输出冲突）；`2` 预算耗尽 unknown；
`3` 持久化失败（原文件保留、已回滚）；`64` 用法错误。

## 测试

```
node --test
```

- `test/solver.test.js`：小库存上与暴力枚举（所有批组合 × 数量拆分）逐一比对最优
  移库成本与最大剩余效期，并核对数量守恒、域界、质量状态；
- `test/expiry.test.js`：效期边界——全部过期不可行；边界当天恰好合格（含）；严格一天即出局；
- `test/crash.test.js`：注入写故障后退出码 3、`state.json` 哈希不变、无临时文件残留、
  内存回滚，重试后退出码 0 且数量完整落账。
