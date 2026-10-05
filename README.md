# 产线库作业：事件溯源物料账与状态证书

TypeScript + Node.js 内置库（`node:test` / `node:assert` / `node:crypto`），零第三方依赖。

## 领域规则

- **作业占用**：阶段开工（`StageStarted`）把原料从 `onHand` 划入 `held`，并独占设备；
  设备被占用或库存不足时拒绝开工。
- **失败按阶段回收**：`StageFailed` 按阶段计划中的 `recovery` 回收率把 `held` 拆成
  `retained`（可回收、为该订单保留）与 `lost`（损耗），并释放设备。
- **重试不重复消耗**：`StageRetried` 先把 `retained` 划回 `held`，只从库房补差量
  （`retry-consume-shortfall`），已保留料不会再次扣减库存。
- **整单取消逆向补料**：`OrderCancelled` 把该单全部 `held`/`retained` 以
  `reverse-replenishment` 分录退回 `onHand`，并释放设备。
- **显式事件顺序**：`append` 赋予连续序号 `seq`（1 起、步进 1，失败回滚序号）；
  `replay` 校验序号无断裂后在空白状态上逐条重放。
- **物料账**：每次桶间移动记一条 `LedgerEntry`（from/to/qty/reason/order/stage），
  账户守恒：`onHand + held + retained + consumed + lost = 累计收货`。
- **状态证书**：`certify` 对规范化（键序稳定）状态做 SHA-256；增量状态与从头重放
  状态的证书哈希必须一致（`src/main.ts` 与测试均做对照）。

## 命令

```sh
npm test    # tsc 编译 + node --test（13 个用例）
npm run demo  # 运行演示场景，打印物料账、状态证书与重放对照
```

## 实际运行结果（2026-10-05，Node v22.22.1）

`npm test`：

```
ok 1 - dist/test/certificate.test.js   (4 个断言用例)
ok 2 - dist/test/engine.test.js        (9 个断言用例)
# tests 2  # pass 2  # fail 0
```

`npm run demo`（18 个事件）关键输出：

```
steel:   {"onHand":71,"held":0,"retained":0,"consumed":24,"lost":5,"reversed":0}
copper:  {"onHand":56,"held":0,"retained":0,"consumed":4,"lost":0,"reversed":0}
plastic: {"onHand":78,"held":0,"retained":0,"consumed":0,"lost":2,"reversed":3}
增量证书 sha256 == 重放证书 sha256 → 对照结果: 一致 [OK]
```

## 结构

- `src/model.ts` — 桶/账户/订单/设备/分录等状态类型
- `src/events.ts` — 事件类型（显式序号 `SequencedEvent`）
- `src/engine.ts` — reducer（`apply`）、`append`、`replay`、领域校验
- `src/certificate.ts` — 规范化序列化 + SHA-256 状态证书
- `src/scenario.ts` / `src/main.ts` — 演示场景与对照输出
- `test/` — `node:test` 用例（回收率、重试不重复消耗、逆向补料、顺序断裂、重放一致等）
