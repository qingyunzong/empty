# dag-test-orchestrator

基于 DAG 的测试阶段编排库。仅使用 TypeScript + Node.js 内置模块，零 npm 依赖。

## 核心语义

- **阶段 DAG**：每个 `Stage` 声明 `deps`（依赖）、`files`（输入文件）、`version` 与 `run`。
  编排器校验唯一 id、未知依赖与环，并按拓扑序调度（独立分支并行）。
- **输入摘要缓存**：阶段摘要 = SHA-256( id + version + 输入文件内容哈希 + 各依赖的*输出哈希* )。
  摘要匹配的成功记录直接复用，不调用 `run`。
- **失败仅重跑后继**：失败阶段不写入缓存；依赖失败者的阶段标记 `skipped`。
  下次运行时只有失败阶段及其后继重新执行，无关分支保持缓存。
- **文件变化失效**：输入文件内容进入摘要，文件变化使该阶段失效，并经依赖输出哈希
  传递失效到后继；若依赖重跑后输出不变，后继的内容寻址缓存仍然有效。
- **结果发布原子**：缓存记录与运行报告均按「写 tmp → fsync → rename → fsync 目录」
  提交；记录含校验和，篡改/截断/半成品一律视为未命中并清除。
- **可控执行器**：`Executor` 接口可注入。`ImmediateExecutor`（默认，限并发）与
  `ManualExecutor`（队列式，`step()`/`drain()` 逐步驱动，用于确定性测试与断电模拟）。
- **断电点验证**：故障注入钩子（`afterTmpWrite` / `afterRename`）模拟提交途中断电；
  重启后已提交成功被复用、部分写入绝不复用、输入已变的过期成功绝不复用。

## 使用

```ts
import { orchestrate } from "./src/index.js";

const report = await orchestrate(
  [
    { id: "compile", files: ["src.txt"], run: () => "obj" },
    { id: "link", deps: ["compile"], run: (ctx) => `linked:${ctx.inputs.compile}` },
  ],
  { workdir: ".", cacheDir: ".orch-cache", reportPath: "report.json" },
);
```

## 测试

```sh
npm test   # tsc 构建 + node --test
```

实际测试结果见 [RESULTS.md](RESULTS.md)。
