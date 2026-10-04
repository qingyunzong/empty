# sync-import

同步导入库：同时核对**源快照**与**目标基线**的三方合并导入。目标一旦发生本地改动，
默认导致**整批冲突**（不做按项目的部分覆盖）；调用方可提供**明确的字段级三方决议**
解除冲突。纯 TypeScript 实现，仅使用 Node.js 内置库，零运行时依赖。

## 数据模型

```ts
type FieldValue = string | number | boolean | null;
type Snapshot = Record<string, Record<string, FieldValue>>; // 项目 id -> 字段表
```

三方输入：

- `base`：目标基线（上次同步时目标的状态）
- `source`：待导入的源快照
- `target`：目标当前状态

## 合并语义

逐字段比较基线 `b`、源 `s`、目标 `t`（字段缺失参与比较，源删除字段会传播删除）：

| 情形 | strict（默认） | auto |
| --- | --- | --- |
| `s === t` | 采用该值（`agreed`/`unchanged`） | 同左 |
| `t === b`（目标未改动） | 采用源值（`take-source`） | 同左 |
| `s === b`（源未改动） | **需要显式决议** | 保留目标（`keep-target`） |
| 双方均改动且不一致 | **需要显式决议** | **需要显式决议** |

批级原子性：**任一字段缺少所需决议，整批不应用**（`applied=false`，`result` 为空），
绝不按项目部分覆盖。所有所需决议齐备时整批一次性应用。

显式决议（两种模式均生效，且优先于自动规则）：

```ts
{ project: "alpha", field: "status", pick: "target" }          // 保留目标值
{ project: "alpha", field: "status", pick: "source" }          // 采用源值
{ project: "alpha", field: "status", pick: "value", value: "x" } // 采用指定值
```

其他约定：

- 导入范围为源快照中的项目；源之外的目标项目原样保留（导入不删除项目）。
- 目标相对基线的任何偏离都会置 `targetDiverged=true` 并体现在逐项决议中。
- 无需决议的字段上提供的决议会列入 `unusedResolutions`。

## 输出

`syncImport` 返回 `SyncReport`：

- `applied` / `result`：批次是否应用及合并后的目标快照
- `items[]`：**每项决议**——项目状态（新增/更新/合并/未变/冲突）与逐字段决定
  （`action`、三方取值、最终值、中文说明）
- `unresolvedConflicts[]`：**未解冲突**清单（项目、字段、三方取值）
- `unusedResolutions[]`、`summary`、`targetDiverged`

`formatReport(report)` 生成人类可读的中文报告。

## 用法

```ts
import { syncImport, formatReport } from "./src/index.js";

const report = syncImport(base, source, target, {
  mode: "strict", // 或 "auto"
  resolutions: [{ project: "alpha", field: "status", pick: "target" }],
});
console.log(formatReport(report));
if (report.applied) { /* 使用 report.result */ }
```

CLI（`node:fs` / `node:util` 实现）：

```bash
npm run build
node dist/src/cli.js --base examples/base.json --source examples/source.json \
  --target examples/target.json [--resolutions examples/resolutions.json] \
  [--mode strict|auto] [--out merged.json]
# 退出码: 0=批次已应用；1=存在未解冲突；2=参数或输入错误
```

## 测试

```bash
npm test   # tsc 构建 + node --test
```

- `test/sync.test.ts`：确定性用例——干净导入、删除传播、严格模式全批冲突、
  三种显式决议、自动模式单边合并、双方改动冲突、输入校验、报告输出。
- `test/randomized.test.ts`：**随机编辑对照独立规则**——用种子化 PRNG 随机生成
  基线、源/目标编辑与决议（strict/auto 各 300 轮），与测试内独立实现的规则
  逐字段对照 `applied`、未解冲突集合、合并结果、逐项状态与终值，并校验
  源外项目保留、目标未动字段必取源值、补齐决议必然应用等不变量。
- `test/cli.test.ts`：CLI 退出码与输出（进程内调用 `runCli`）。

### 实测结果（2026-10-05，Node v22.22.1 / npm 9.2.0 / tsc 7.0.2）

```
$ npm test
> sync-import@0.1.0 test
> npm run build && node --test "dist/test/*.test.js"

ok 1 - dist/test/cli.test.js        (3 个用例)
ok 2 - dist/test/randomized.test.js (4 个用例：strict/auto 各 300 轮随机对照 + 2 个不变量)
ok 3 - dist/test/sync.test.js       (15 个用例)
# tests 3
# pass 3
# fail 0
# duration_ms 383.662155
```

CLI 实测（`examples/`）：无决议时退出码 1，报告 2 项未解冲突
（`alpha.status`、`beta.owner`），整批未应用；附带 `examples/resolutions.json`
后退出码 0，整批合并写出。

## 环境说明

- 仅使用 Node.js 内置模块（`node:test`、`node:assert`、`node:fs`、`node:util`），无任何 npm 依赖。
- 构建需要环境中可用的 `tsc`（TypeScript 5+/7）。
- `src/node-shims.d.ts` 提供所用 Node API 的最小类型声明，无需 `@types/node`。
