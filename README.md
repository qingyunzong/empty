# quote-invert-cli

报价反推工具：给定**舍入后的最终金额**，反推所有可能得到该金额的**整数原价范围**。

## 模型

每一步对当前价格 `x` 应用一个有理数折扣并做**最近偶数舍入**（round-half-even）：

```
x -> roundHalfEven(p * x / q)        p, q 为正整数
```

- 最多可串联 **8 步**（`--steps 9/10,4/5,...` 按顺序应用）。
- 原价限定在闭区间 **[0, 10^12]**（可用 `--cap` 调整）。
- 由于每步关于 `x` 单调不减，单点金额的逆像仍是闭区间；输出为**互不交叠的闭区间** `[lo, hi]`，无解时输出 `EMPTY`。
- 全部使用 BigInt 精确运算，无浮点误差。

## 使用

```bash
npm run build
node dist/src/cli.js 899 --steps 9/10,4/5          # => [1249, 1249]
node dist/src/cli.js 899 --steps 9/10,4/5 --verify # 附前向核验
node dist/src/cli.js 3 --steps 2/1                 # => EMPTY（奇数不可达）
node dist/src/cli.js 72 --steps 9/10,4/5 --json
```

选项：`--cap <n>` 原价上界（默认 10^12）、`--verify` 前向核验、`--json` 机器可读输出、`-h/--help`。

## 核验（--verify）

对逆推结果做前向计算核验：

- **低价格域**（区间上界 ≤ 10^6）：区间内**逐值**前向计算，并检查区间外相邻两个值确实不命中；
- 高价格域：边界与中点采样核验。

## 测试

```bash
npm test
```

测试先 `tsc` 编译再跑 `node --test`，包括：

- 舍入平局取偶、区间端点开闭的单元测试；
- 随机 1–8 步有理数链 × 低价格域 `[0, 3000]` 的**暴力枚举对照**（逐值前向计算真值表 vs 逆推区间，含 8 步链）；
- CLI 参数解析、JSON 输出、错误路径。

## 结构

- `src/core.ts` — BigInt 舍入/正向求值/单步与链式逆推/区间合并/前向核验
- `src/app.ts` — 纯函数式 CLI 逻辑（`runCli(argv)`，便于进程内测试）
- `src/cli.ts` — 可执行入口
- `test/` — node:test 测试
- `types/node-shim.d.ts` — 沙箱无网络时的最小 Node 类型声明（有网可换装 `@types/node`）
