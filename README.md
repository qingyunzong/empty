# execution-diagnosis

结构化执行事件诊断库（TypeScript + Node.js 内置库，零运行时依赖）。

## 诊断规则

- 输入为结构化 `ExecutionEvent` 流，分类只依据结构化字段 `kind` / `terminatesRun` / `causeIds`，**不解析 `summary` 等自由文本**（不从文字猜身份）。
- 分类由有限表 `TERMINATION_TABLE`（`src/events.ts`）查得，覆盖全部 `EventKind`，测试逐条穷举核对：
  - `prerequisite_missing` → 前置缺失 `prerequisite_missing`
  - `communication_lost` → 通信中断 `communication_interrupted`
  - `assertion_failed` → 断言失败 `assertion_failed`
  - 其余种类（`run_started` / `step_started` / `step_completed`）→ 非终止事件
- 仅 `terminatesRun === true` 且种类可分类的事件是直接终止候选；**多原因时取 `at` 最早的候选**（时间戳相同取输入顺序靠前者）。
- 没有任何终止候选（含空事件流）→ `unknown`（没有执行证据）。
- 输出完整因果链：从终止事件沿 `causeIds` 回溯全部传递原因，按因果序排列，终止事件在末尾；缺失的原因 id 记入 `missingCauseIds`，循环引用安全。

## 使用

```ts
import { diagnose } from './src/index.js';

const result = diagnose([
  { id: 'a', kind: 'run_started', at: 1 },
  { id: 'b', kind: 'prerequisite_missing', at: 2, terminatesRun: true, causeIds: ['a'] },
]);
// result.category === 'prerequisite_missing'
// result.causalChain 末尾为事件 b
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test（Node 内置测试运行器）
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0；`node --test-reporter=spec dist/test/diagnose.test.js` 输出：

```
✔ 有限表穷举核对：每个事件种类都有显式表项
✔ 有限表穷举核对：非空表项均为合法终止类别，且每个类别可达
✔ 无执行证据：空事件流 -> unknown
✔ 无执行证据：有事件但无终止证据 -> unknown
✔ 无执行证据：终止种类事件但未标记 terminatesRun -> unknown
✔ 无执行证据：terminatesRun 标记在不可分类种类上 -> unknown
✔ 前置缺失分类
✔ 通信中断分类
✔ 断言失败分类
✔ 多原因：按最早直接致终止事件定类
✔ 多原因：时间戳相同按输入顺序取先者
✔ 不从文字猜身份：summary 含误导词汇仍按 kind 分类
✔ 完整因果链：传递原因按因果序排列，终止事件在末尾
✔ 因果链：缺失的原因 id 被记录，循环引用安全
ℹ tests 14  ℹ pass 14  ℹ fail 0
```

## 结构

- `src/events.ts` — 事件模型与有限分类表 `TERMINATION_TABLE`
- `src/diagnose.ts` — 终止事件选取、因果链回溯、`diagnose()`
- `src/index.ts` — 公共导出
- `test/diagnose.test.ts` — 14 个测试（含有限表穷举核对）
- `test/node-shims.d.ts` — 离线环境下 `node:assert/strict` / `node:test` 的最小类型声明
