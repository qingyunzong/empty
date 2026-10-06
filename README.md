# async-round-robin-merge

将 K 个异步迭代器合并为一个 `AsyncIterableIterator` 的流处理库（零依赖，TypeScript）。

## 语义

- **每源最多一项预取**：任意时刻每个源最多只有一个在途的 `next()`；交付一项后立即为该源补一次预取。
- **按源轮转**：结果严格按源下标轮转交付，跳过已耗尽 / 已出错 / 已关闭的源，与各项就绪顺序无关。
- **return 与 next 竞争**：`return()` 与在途 `next()` 竞争时，已交付（预取已落定）的项优先交付给消费者；其余未落定的预取被释放，其源被关闭。
- **源抛错**：只关闭出错的源（等待其 `return()`），通过 `onSourceError(error, index)` 报告，其余源继续轮转。
- **幂等关闭**：重复调用 `return()` 不会重复关闭任何源；自然耗尽的源不再调用 `return()`。

## 用法

```ts
import { mergeRoundRobin } from "./src/merge";

const merged = mergeRoundRobin([sourceA, sourceB, sourceC], (error, index) => {
  console.error(`source ${index} failed`, error);
});

for await (const item of merged) {
  // 按 A、B、C 轮转交付
}
```

## 测试

```sh
npm test   # tsc 编译后用 node:test 运行 dist/test/*.test.js
```

测试使用受控 promise（`ControlledSource`）精确驱动每个源的 `next()` 落定时机，
并验证：轮转顺序、每源单预取上限、return/next 竞争语义、重复关闭幂等性与资源计数。
*** Add File: .gitignore
dist/
node_modules/
