# 页面采集的稳定等待

可导入的 TypeScript 页面等待组件：在浏览器采集场景中，等待纯谓词在同一份文档版本上
连续成立满指定时长后，返回该版本的不可变节点快照。

## 用法

```ts
import { waitForStable, createSystemClock } from "./index.ts";

const result = await waitForStable({
  adapter,                 // PageAdapter<S>：read() + subscribe(afterVersion, cb)
  predicate: (snapshot) => snapshot.querySelectorAll(".item").length >= 10,
  stableForMs: 500,        // 谓词需连续成立的正时长
  timeoutMs: 10_000,       // 可选总超时，省略或 Infinity 表示不限制
  clock: createSystemClock(),
  signal: abortController.signal, // 可选取消信号
});

// result.status: "satisfied" | "timeout" | "cancelled"
// result.version / result.snapshot 为终态时的最新版本与不可变快照
```

## 契约

- 适配器版本号严格递增；`read()` 返回当前版本与该版本不可变快照；
  `subscribe(afterVersion, cb)` 从指定版本之后按版本顺序重放变化，每个变化携带对应版本
  的不可变快照。组件先 `read` 再 `subscribe(read.version)`，两次调用之间的变化由重放补齐。
- 每次文档变化都用其携带的快照重新求值谓词并重新计时；谓词翻假立即清除稳定计时器。
- 稳定计时器触发时，仅当最新版本仍是计时开始时的版本且当前时刻已达期限才成功；
  若总超时已到则超时优先。
- 变化、取消（`AbortSignal`）、计时器触发按调用方提供的串行顺序同步处理。
- 终态产生后解除订阅并移除全部监听；任何迟到回调（包括未被真正清除的僵尸计时器）
  都无法再次完成，Promise 最多产生一个终态。

## 文件

- `src/types.ts`：适配器、时钟、选项与终态类型。
- `src/wait.ts`：`waitForStable` 状态机。
- `src/clocks.ts`：`SystemClock`（生产）与 `VirtualClock` / `LeakyVirtualClock`（测试）。
- `test/wait.test.ts`：虚拟时钟驱动的确定性测试。

## 测试与类型检查

```sh
npm run typecheck   # tsc 严格模式类型检查
npm test            # 编译到 dist/ 后用 node:test 运行
```

当前 Node 二进制未内置 Amaro（不支持 `--experimental-strip-types`），因此测试脚本先通过
`tsc -p tsconfig.build.json` 编译为 JS（`.ts` 相对导入自动重写为 `.js`），再运行
`node --test dist/test/wait.test.js`。
