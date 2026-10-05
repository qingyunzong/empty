# execution-diagnosis

诊断结构化执行事件，输出失败分类与完整因果链。仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 诊断规则

- 分类只依据事件的结构化字段 `kind` / `status`（有限枚举表穷举核对），
  绝不从 `name` / `message` 等文字猜测身份；
- 多个候选原因时，取 `seq` 最小（最早）的直接致终止事件；
- 没有任何事件（无执行证据）或没有致终止事件时，诊断为 `unknown`。

## 有限分类表（kind × status）

| kind                | failed                      | timeout                       | interrupted                   | ok / skipped |
|---------------------|-----------------------------|-------------------------------|-------------------------------|--------------|
| `precondition_check`| `missing_precondition`      | —                             | —                             | —            |
| `communication`     | `communication_interruption`| `communication_interruption`  | `communication_interruption`  | —            |
| `assertion`         | `assertion_failure`         | —                             | —                             | —            |
| `lifecycle`         | —                           | —                             | —                             | —            |

未列出的组合一律不是致终止原因。测试对全部 4 × 5 组合逐一核对（`test/diagnose.test.ts`）。

## 事件模型

```ts
interface ExecutionEvent {
  seq: number;          // 单调执行序号，"最早"判定的唯一依据
  kind: EventKind;      // precondition_check | communication | assertion | lifecycle
  status: EventStatus;  // ok | failed | timeout | interrupted | skipped
  name: string;         // 仅展示，不参与分类
  message?: string;     // 仅展示，不参与分类
  causedBy?: number[];  // 指向前驱事件 seq 的结构化因果引用
}
```

## 诊断输出

```ts
interface Diagnosis {
  category: "missing_precondition" | "communication_interruption" | "assertion_failure" | "unknown";
  reason: "no_execution_evidence" | "no_terminating_event" | "earliest_terminating_event";
  rootCause: ExecutionEvent | null;  // 最早直接致终止事件
  causalChain: ChainLink[];          // 起源 → 致终止事件的完整因果链
}
```

因果链重建：事件带 `causedBy` 引用时沿引用回溯全部祖先并按 `seq` 排序；
否则退化为致终止事件之前（含）的时序记录。

## 用法

```ts
import { diagnose } from "./src/index.js";

const d = diagnose([
  { seq: 1, kind: "lifecycle", status: "ok", name: "start" },
  { seq: 2, kind: "communication", status: "timeout", name: "rpc", causedBy: [1] },
]);
// d.category === "communication_interruption"
```

非法输入（非数组、缺字段、枚举越界、seq 重复）抛出 `EventValidationError`，不做任何猜测性修补。

## 命令

- `npm run build`：tsc 编译到 `build/`
- `npm test`：编译并用 `node --test` 运行全部测试（实际结果见 `TEST_RESULTS.md`）

环境说明：本机 Node v22.22.1 未编译 TypeScript 类型擦除支持，故测试经 `tsc`（全局 v7.0.2）编译后运行；
`types/node-shim.d.ts` 为离线环境下 `node:test` / `node:assert/strict` 的最小类型声明。
