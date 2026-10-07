# async-merge-round-robin

合并 K 个异步迭代器（`AsyncIterable` 或 `AsyncIterator`）为一个异步可迭代对象。

## 语义

- **单条预取**：每个源同一时刻最多一个未完成的 `next()`（缓冲上限为 1 项）。
- **源轮转**：已就绪的项按源的下标轮转交付，与到达先后无关。
- **return 与 next 竞争**：`return()` 调用时，已交付（已预取完成）的项优先照常产出；
  其余仍在途的预取被释放——对应源的 `return()` 被调用，迟到的结果安全丢弃，
  且关闭不会等待卡住的源，避免死锁。
- **源抛错**：只关闭出错的那一个源（等待其 `return()`），通过 `onSourceError`
  回调报告 `{ index, error }`，其余源继续产出。
- **关闭幂等**：无论 `return()` 被调用多少次（包括并发），每个源的 `return()`
  恰好执行一次；自然耗尽不会强制关闭源。

## 用法

```ts
import { mergeRoundRobin } from "./src/merge.js";

const merged = mergeRoundRobin([sourceA, sourceB, sourceC], {
  onSourceError: ({ index, error }) => console.error(`source ${index} failed`, error),
});

for await (const item of merged) {
  // ...
  if (done) break; // 提前退出会恰好关闭所有源一次
}
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test/*.test.js
```

测试使用受控 promise（`ControlledSource`）精确驱动每个源，验证：轮转顺序、
单条预取上限、`return()` 优先交付已取项、在途预取释放、并发重复 `return()`
下每源仅关闭一次（资源计数）、单源抛错隔离与上报、`for await` 提前退出清理。
