# fir-decimate-chain

串联整数 FIR 滤波器与抽取器的流式信号处理库。TypeScript 编写，运行时仅使用
Node.js 内置模块（`node:test` / `node:assert` 用于测试），零第三方依赖。

## 运行

```sh
npm test   # = tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```

需要 Node.js（开发环境为 v22）与 `tsc`（开发环境为 TypeScript 7.0.2）。
`types/node-shim.d.ts` 内置了测试用到的最小 Node 类型声明，无需安装 `@types/node`。

## 语义（公开约定）

### 块边界不重置状态

`Chain.push(block)` 以任意大小的块喂入整数样本。所有级的状态（FIR 延迟线、
抽取器相位计数器）都跨 `push` 调用保持，因此对同一段输入无论怎么分块，
输出逐样本完全一致（测试 1、2 覆盖）。

### 各级延迟映射到原时间

FIR 必须是奇数长、对称（线性相位）的整数系数，群延迟 `D = (M-1)/2` 为整数，
因此每个输出都能精确对齐到原始输入样本号。每个输出样本携带：

- `center`：该输出对齐的原始输入样本号（各级延迟已折算回原时间基）；
- `first` / `last`：贡献该输出的原始输入样本号范围（输出来源范围）。

`chain.timing()` 返回 `{ outPeriod, latency }`：从 0 号样本开始的均匀输入流，
第 `m` 个链输出满足 `center === latency + m * outPeriod`（测试 3、4 覆盖）。

### 配置切换只在明确样本号生效

`chain.reconfigure(newConfig, atSample)` 要求 `atSample` 恰好等于已消费的输入
样本数；新配置对样本号 `>= atSample` 的输入生效，且以全新状态启动。
任何其他样本号（过去或未来）都会抛错（测试 7、8 覆盖）。

### 旧尾处理（公开）

M 抽头 FIR 采用 "valid" 卷积：窗口填满才输出，因此流末尾总有 M-1 个
待发的尾样本。抽取器没有尾：不足一个完整抽取周期的输入一律丢弃。
`tailPolicy` 决定配置切换（`reconfigure`）和流结束（`finish`）时旧尾的去向：

- `'drop'`：旧尾直接丢弃，最后 M-1 个输出永不产生；
- `'flush'`：用 M-1 个零样本把旧尾冲刷出来，**仍使用旧系数**并沿旧链传播。
  零填充不贡献 `first`/`last`（来源范围只覆盖真实样本）；冲刷输出的
  `center` 按最后观测到的步长外推，可能越过最后一个输入样本号。

## 独立逐样本模型核对

`src/reference.ts` 是一个独立的逐样本参考模型：整段数组、直接按定义做卷积 /
抽样，不使用任何流式状态，与 `src/stages.ts` 不共享代码。测试 1 用确定性
伪随机配置（随机 FIR/抽取级、随机分块、随机多段配置切换、两种尾策略，
共 400 组）断言流式链的输出（值 + 来源范围 + 对齐样本号）与参考模型
逐样本深度相等。

## 实测结果

环境：Node.js v22.22.1，TypeScript 7.0.2（tsc），2026-10-05 执行 `npm test`：

```
ok 1 - block boundaries never reset state; output matches the independent per-sample model
ok 2 - same input with many different blockings yields identical output
ok 3 - stage delays map to original time: center === latency + m * outPeriod
ok 4 - impulse stays aligned to its original-time index through the chain
ok 5 - flush tail: zero-padded old tail, extrapolated centers, ranges cover real samples only
ok 6 - drop tail: the last M-1 outputs are simply never emitted
ok 7 - config switch takes effect only at the explicit sample number
ok 8 - invalid configurations and misuse are rejected
# tests 8
# pass 8
# fail 0
```

## 文件

- `src/sample.ts` — `Sample`（值 + 来源范围 + 原时间对齐）、`TailPolicy`、级配置类型
- `src/stages.ts` — 流式 `FirStage` / `DecimateStage`（状态跨块保持）
- `src/chain.ts` — `Chain`：块处理、配置切换、尾处理、`timing()` 延迟映射
- `src/reference.ts` — 独立逐样本参考模型
- `test/chain.test.ts` — 上述 8 项测试
