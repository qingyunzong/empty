# diagnostic-merge

诊断合并库：TypeScript 编写，仅依赖 Node.js 内置模块（`node:test`、`node:assert`），无第三方依赖。

## 合并规则

- **诊断身份** = `(range.start, range.end, reason)`：三者完全一致才合并；范围相邻（如前一个 `end` 等于后一个 `start`）或相同但 `reason` 不同的诊断绝不合并。
- **证据去重** = `(sourceId, phase, message)`：同一来源重复上报同一错误只保留一份证据；同一错误被多个阶段引用时，每份证据各自保留。
- **来源撤回**：`withdraw(sourceId)` 只移除该来源的引用；诊断仍有其他来源证据时保留，证据清空后诊断才移除；撤回后该来源重新上报视为新证据。
- **稳定排序**：`list()` 输出与插入顺序无关——诊断按 `(start, end, reason)` 排序，证据按 `(sourceId, phase, message)` 排序。

## API

```ts
import { DiagnosticStore } from "./src/diagnostics.js";

const store = new DiagnosticStore();
store.report({ sourceId, phase, range: { start, end }, reason, message });
store.withdraw(sourceId);
const diagnostics = store.list(); // 稳定排序的 Diagnostic[]
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

测试包括 8 个规则单元测试，以及 1 个随机化模型核对测试：用种子化 PRNG（mulberry32，种子 1–50）生成随机上报/撤回序列，每步都与"全量集合模型"（维护存活事件日志、撤回时剔除该来源事件后从零重建）的输出做 `deepEqual` 比对。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2，2026-10-06 运行。

```
ok 1 - 同一来源重复上报同一错误按来源ID合并为一份证据
ok 2 - 范围相邻但原因不同的诊断不能合并
ok 3 - 范围相同但原因不同的诊断不能合并
ok 4 - 同一错误被多个阶段引用时保留每份证据
ok 5 - 撤回来源只移除该来源的引用，其他来源证据保留
ok 6 - 所有来源都撤回后诊断消失
ok 7 - 撤回不存在的来源不影响现有诊断
ok 8 - 输出稳定排序，与插入顺序无关
ok 9 - 随机上报与撤回序列与全量集合模型一致
# tests 9
# pass 9
# fail 0
```

## 文件结构

- `src/diagnostics.ts` — 库实现
- `test/diagnostics.test.ts` — 单元测试 + 随机模型核对
- `types/node.d.ts` — `node:test`/`node:assert` 最小类型声明（环境无 `@types/node`）
