# 投放规划 CLI（ad-placement-planner）

至多 16 个广告组、每组整数投放量 0–10，满足**分渠道预算**与**总曝光下限**，
按**非线性收益表**求**总收益最大**；收益并列时取**总成本最低**。全部数值为整数。
求解输出**预算证书**（SHA-256 哈希 + 最优性证据），小规模实例自动做**穷举对照**。

仅使用 Node.js 内置库（`node:crypto` / `node:fs` / `node:test` 等），无任何第三方依赖。

## 构建与测试

```bash
npm run build   # tsc 编译 TypeScript 到 dist/
npm test        # 编译并运行全部测试（node:test）
```

## 使用

```bash
node dist/src/cli.js sample [--out configs/sample.json]  # 生成确定性样例（16 组 / 3 渠道）
node dist/src/cli.js solve <config.json> [--cert out.json] [--json]
node dist/src/cli.js verify <config.json> <cert.json>    # 独立复核预算证书
node dist/src/cli.js brute <config.json>                 # 小量穷举（11^n ≤ 2,000,000）
```

也可使用 `npm run sample`、`npm run cli -- solve configs/sample.json`。

## 输入格式

```json
{
  "channels": [{ "id": "search", "budget": 60 }],
  "exposureLowerBound": 40,
  "groups": [
    {
      "id": "g01",
      "channel": "search",
      "unitCost": 3,
      "unitExposure": 2,
      "revenue": [0, 9, 15, 20, 24, 27, 29, 30, 31, 32, 33]
    }
  ]
}
```

- `revenue` 长度必须为 11（投放量 0–10 的收益），整数、非负、`revenue[0] = 0`，允许任意非线性（含非单调）。
- `budget` / `unitCost` / `unitExposure` / `exposureLowerBound` 均为非负整数；广告组至多 16 个。

## 求解方法（精确最优）

1. **渠道内 DP**：状态 `(花费, 截断到下限的曝光) → 最大收益`，逐组转移（量 0–10），
   提取帕累托前沿（剔除被 `成本≤、曝光≥、收益≥` 支配的点）。
2. **跨渠道合并**：状态 `(总成本, 截断曝光) → 最大收益`，逐渠道合并前沿并再次裁剪。
3. **终选**：曝光达标（截断后等于下限）的状态中取收益最大，并列取成本最低。

曝光在 DP 中截断到下限，因此状态数上界为 `Π(渠道预算+1) × (下限+1)`，全部整数运算。

## 预算证书

`solve --cert` 输出 JSON 证书，包含：

- `inputHash`：规范化输入的 SHA-256；
- `channels[]`：各渠道 `花费 / 预算 / 余量` 核销；
- `allocations[]`：逐组投放量、成本、曝光、收益；
- `proof`：DP 状态数、最终前沿哈希、穷举对照结果（小规模自动执行）；
- `certificateHash`：以上全部内容规范化后的 SHA-256，篡改即失效。

`verify` 命令独立复核：证书哈希、输入指纹、逐组明细与合计、渠道预算、曝光下限，
并**重新精确求解**确认收益最大且并列成本最低。

## 项目结构

- `src/model.ts` — 数据模型与输入校验
- `src/solve.ts` — 两级整数 DP 精确求解器
- `src/brute.ts` — 小量穷举对照
- `src/certificate.ts` — 预算证书生成与复核
- `src/sample.ts` — 确定性样例生成
- `src/cli.ts` — 命令行入口
- `test/solver.test.ts` — 测试（随机实例 DP vs 穷举、并列取低成本、约束、证书、流水线）
- `configs/sample.json` / `configs/small.json` — 样例配置
- `TEST-RESULTS.md` — 实际测试与运行实录
