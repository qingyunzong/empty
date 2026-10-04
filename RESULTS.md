# 实际测试结果

## 环境

- Node.js v22.22.1(仅使用内置库:`node:test`、`node:assert`)
- TypeScript 编译器 tsc 7.0.2(全局安装,项目零运行时依赖)
- 平台:Linux x86_64

## `npm test` 输出(2026-10-05 实跑记录)

```
> coupon-library@1.0.0 test
> tsc -p tsconfig.json && node --test 'dist/test/*.test.js'

ok 1 - dist/test/allocator.test.js
ok 2 - dist/test/session.test.js
ok 3 - dist/test/singleOrder.test.js
ok 4 - dist/test/verify.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 606.44943
```

## 用例明细(逐文件统计,共 34 个用例全部通过)

| 测试文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `test/singleOrder.test.ts` | 10 | 百分比向下取整、整数分、输入序作用、有向前置、互斥组、平手(券数少/ID 序小)、合法子集枚举验证、18 券上限与非法券库拒绝 |
| `test/allocator.test.ts` | 13 | 共享券归属、限定订单券、零收益闲置、所有权向量平手、互斥跨单拆分、前置同单、锁定实付冻结、锁定校验、搜索预算(feasible/optimal)、零预算贪心兜底、18 券证最优、18 券/8 订单上限 |
| `test/session.test.ts` | 7 | 每券所有权与逐单金额输出、结算锁定后退款重算(锁定实付不变)、退已结算订单撤销券、自动优化、未知订单报错、会话层规模上限 |
| `test/verify.test.ts` | 4 | 60 组随机小分配与独立穷举完全一致、穷举器手算对照、超规模拒绝、非最优状态不参与核对 |

## 验证方式说明

- 单订单金额由 `verifySingleOrderPayment` 枚举全部合法子集复核。
- 多订单分配由 `src/verify.ts` 的独立穷举实现(与优化器分离的全空间枚举)
  在 60 组确定性随机用例(1–6 券、1–3 订单,含前置/互斥/限单)上逐字段核对:
  总实付、用券数、逐单金额、每券所有权全部一致。
