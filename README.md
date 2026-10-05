# billing-core 账单库

TypeScript + Node.js 内置库实现，零外部依赖（离线环境，`tsc` 编译 + `node --test` 运行）。

## 计费模型

1. **区间求交**：上线区间（半开区间 `[start, end)`，整数秒）先求并集
   （重叠及相邻区间合并），再与非重叠的费率区间求交，得到**来源段**
   （`buildSegments`，src/billing.ts）。
2. **向上计分钟**：每段 `ceil(秒数 / 60)` 分钟 × 费率（分/分钟）= 段费用。
3. **网格计时模型对照**：`gridSegmentFeeCents` 用逐秒刻度模拟的独立代码路径
   重算同一笔费用，随机用例与更正后的账单都与公式法逐段核对一致。
4. **比例分账**：段费用按各用户在该段内的占用秒数比例分配
   （`splitBySeconds`，src/settlement.ts）。每份向下取分，余分按
   **精确余数降序、userId 升序**逐个补 1 分；内部用 BigInt 取精确余数。
5. **历史更正**：已发布账目不可修改。更正时对原账单逐笔发**冲正账**
   （金额取反、`type="reversal"`），再按更正后数据入新账
   （`correctBill`，src/engine.ts）。
6. **守恒**：每段 Σ 分账 = 段费用；整单 Σ 分录 = 总费用（`computeBill` 内置断言）。
7. **断点重放幂等**：每笔分录带确定性幂等键，`Ledger.post` 同键去重、
   同键异值报错；`BillingPipeline` 支持 `checkpoint()` 快照与
   `restore()` 后重放，重复重放账本指纹（SHA-256）不变。

## 目录

- `src/interval.ts` — 区间并集/交集
- `src/billing.ts` — 来源段、向上计分钟、网格计时模型
- `src/settlement.ts` — 比例分账（最大余数法）
- `src/ledger.ts` — 幂等账本（只追加，不可改）
- `src/engine.ts` — 账单计算、发布、冲正更正
- `src/pipeline.ts` — 命令流水、断点与重放
- `src/demo.ts` — 示例：输出来源段及费用、更正前后与网格模型对照
- `test/` — node:test 测试

## 使用

```sh
npm test    # 编译并运行全部测试
npm run demo  # 打印示例账单（来源段、费用、分账、冲正分录）
```

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
ok 1 - dist/test/billing.test.js     # 求交/并集/向上计分钟/网格模型 200 轮随机对照/更正后对照
ok 2 - dist/test/interval.test.js    # 并集、交集、覆盖秒数、非法区间
ok 3 - dist/test/ledger.test.js      # 逐段与整单守恒、幂等入账、冲正不改已发布账
ok 4 - dist/test/pipeline.test.js    # 5 个断点位置重放 + 重复重放，账本指纹一致
ok 5 - dist/test/settlement.test.js  # 分账规则 + 小分账枚举核对（114,636 个组合全通过）
# tests 5
# pass 5
# fail 0
```

小分账枚举核对覆盖：总额 0..40 分 × 1..4 个用户 × 每人 0..6 秒的全部组合，
逐一验证金额守恒与“向下取分 + 余分按精确余数、ID 分配”规则。
