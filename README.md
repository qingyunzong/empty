# budget-auth — 授权预算库

层级令牌预算管理：父令牌将额度授予子令牌，子令牌消费扣减自身额度并计入父级总消费；
退款只认原消费 ID 且仅一次；撤销子令牌把未用额度退回父级；批量额度转移是原子的。
纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 运行

```sh
npm test   # tsc 编译后用 Node 内置 test runner 跑全部测试
```

## 设计

- `src/budget.ts` 导出 `BudgetSystem`：
  - `createRoot(id, quota)` 创建根令牌（支持多根森林），额度为非负安全整数。
  - `grant(parentId, childId, amount)` 父令牌划拨额度创建子令牌，父额度同步扣减。
  - `spend(tokenId, amount)` 扣减该令牌可用额度、累加其净消费，并返回唯一消费 ID；
    祖先的 `getTotalConsumed` 会汇总整棵子树的消费（即"父总消费"）。
  - `refund(spendId)` 仅接受原消费 ID，且每笔只能退一次；令牌已撤销时退到最近的
    活跃祖先（额度在撤销时流向之处）。
  - `revoke(tokenId)` 撤销子令牌：未用额度退回父级，令牌变为不可用；根不可撤销；
    已消费部分保持已消费。
  - `transfer` / `transferBatch(ops)` 额度转移；批量先在余额快照上模拟校验，
    全部通过才一次性提交——任一失败则整批不生效（原子性）。
- 金额一律为正安全整数，守恒精确无浮点误差。
- 守恒不变量：`Σ 可用额度(全部令牌) + Σ 净消费 = Σ 根初始额度`，任何操作后成立。

## 测试

- `test/budget.test.ts`：9 个单元测试，覆盖授权、消费记账、退款一次性、
  撤销返还、批量原子性、守恒不变量。
- `test/random.test.ts`：8 个种子 × 1500 步随机操作历史（授权/消费/退款/撤销/
  单笔与批量转移，并注入非法操作探针），每步之后用独立的账本模型交叉核对：
  每个令牌的净消费、每棵子树的总消费、整体守恒等式、余额非负；
  毒化批次断言抛出后所有余额不变（原子性）；最后全量审计消费记录。

## 实际测试结果（Node v22.22.1, tsc 7.0.2）

```
$ npm test
# Subtest: dist/test/budget.test.js   ok  (9/9)
# Subtest: dist/test/random.test.js   ok  (8/8)
# tests 2  # pass 2  # fail 0   (~3.0 s)
```

明细：

```
budget.test.js:  ok 1..9  — root/grant/spend/refund/revoke/transfer/batch/conservation 全部通过
random.test.js:  ok 1..8  — seed=1,2,3,7,42,99,2024,31337 随机历史守恒核对全部通过
```
