# 产线库作业（原料/设备占用 + 事件溯源 + 状态证书）

TypeScript + Node.js 内置库（`node:test` / `node:assert` / `node:crypto`），无第三方依赖。

## 业务规则

- **占用**：`startStage` 为当前阶段占用原料（在库→占用）与设备产能；库存不足或设备占满即拒绝。
- **失败按阶段回收**：`failStage` 按阶段定义 `recovery` 拆分在制料——可回收部分转入作业**保留料**（`MaterialsRetained`），其余记损耗（`MaterialsScrapped`），设备释放。
- **重试不重复消耗**：`retry` 先用保留料抵扣需求，只为缺口新增库存占用（事件 `MaterialsReserved` 中 `reserved` 与 `fromRetained` 分列）。
- **整单取消逆向补料**：`cancelOrder` 取消未完成作业，在制料与保留料全部退回库存（`MaterialsReturned`, reason=`order-cancel`），释放设备；已完工作业不受影响。
- **显式事件顺序**：所有状态变更由携带连续 `seq` 的事件驱动（`src/events.ts`），归约器 `src/apply.ts` 为线上执行与重放共用的纯逻辑。
- **物料账与状态证书**：`src/ledger.ts` 从事件流推导逐笔物料账；`src/certificate.ts` 对终态做键序规范化后取 SHA-256 作为状态证书；`src/replay.ts` 从空状态重放（乱序即拒绝）并比对证书。

## 命令

```sh
npm test    # tsc 编译 + node --test
npm run demo  # 打印事件流、物料账、状态证书与重放对照
```

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test`（TAP 汇总）：

```
# Subtest: dist/test/production.test.js
ok 1 - dist/test/production.test.js
# Subtest: dist/test/replay.test.js
ok 2 - dist/test/replay.test.js
# pass 2
# fail 0
```

逐条执行（`node dist/test/*.test.js`）共 11 个用例全部通过：

```
ok 1 - 作业占用原料与设备，阶段完成后消耗并释放
ok 2 - 库存不足或设备占满时拒绝占用
ok 3 - 失败按阶段决定可回收原料：可回收保留，其余记损耗
ok 4 - 重试不再消耗已保留料，只为缺口新增占用
ok 5 - 整单取消产生逆向补料：在制与保留料退回，设备释放，已完工作业不受影响
ok 6 - 全部阶段完成后作业与订单完工
ok 7 - 状态证书与从头重放一致
ok 8 - 事件顺序显式：乱序重放被拒绝
ok 9 - 篡改事件载荷导致证书不一致
ok 10 - 物料账与终态库存对账一致
ok 11 - 确定性：同一事件流两次重放证书相同
```

`npm run demo` 状态证书对照（live 与从头重放一致）：

```
live   : 64c63b832c9dd0c2936564e7745bf50b17e1ca4e91dc4fc6781cf995d20b8e1f
replay : 64c63b832c9dd0c2936564e7745bf50b17e1ca4e91dc4fc6781cf995d20b8e1f
match  : true
```
