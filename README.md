# map-limit

限制并发的异步映射库：按输入序输出结果，任一元素失败后不再启动更晚元素，
已启动元素仍收尾；最终错误取最小失败下标，并保留其之前的成功前缀。
调用者可通过 `AbortSignal` 退出，取消所有未启动元素。

仅使用 TypeScript 与 Node.js 内置模块（`node:test` / `node:assert`），无运行时依赖。

## API

```ts
mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,                                  // 正整数，否则抛 RangeError
  mapper: (item: T, index: number, signal: AbortSignal) => R | Promise<R>,
  options?: { signal?: AbortSignal },
): Promise<R[]>
```

- **并发上限**：同时在途的 mapper 调用不超过 `concurrency`，元素按下标顺序启动。
- **按输入序输出**：`results[i]` 对应 `items[i]`，与完成顺序无关。
- **失败语义**：任一元素失败（含 mapper 同步抛错）后，更晚下标的元素不再启动；
  已启动元素继续运行至收尾。全部在途元素结束后，Promise 以 `MapLimitError` 拒绝：
  - `index`：最小的失败下标（乱序失败时按下标而非时间取舍）；
  - `cause`：该下标元素的原始失败原因；
  - `partialResults`：该下标之前的成功前缀 `results.slice(0, index)`。
- **调用者退出**：`options.signal` 中止后立即以 `AbortError` 拒绝，未启动元素
  永不启动；已启动元素仍在后台收尾（结果被丢弃，不会产生未处理拒绝）。
  mapper 会收到一个联动的 `AbortSignal`，可协作式取消。

## 使用

```ts
import { mapLimit, MapLimitError } from 'map-limit';

try {
  const results = await mapLimit(urls, 4, async (url, index, signal) => {
    const res = await fetch(url, { signal });
    return res.text();
  });
} catch (err) {
  if (err instanceof MapLimitError) {
    console.error(err.index, err.cause, err.partialResults);
  }
}
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

测试用可控 deferred Promise 精确编排完成顺序，覆盖：并发上限与按序输出、
失败后停启更晚项且已启动项收尾、乱序失败取最小下标并保留成功前缀、
中止取消未启动项、预中止、同步抛错、空输入与非法并发数。

## 实际结果

环境：Node.js v22.22.1，tsc 7.0.2。

`npm test` 输出：

```text
> map-limit@1.0.0 test
> tsc -p tsconfig.json && node --test "dist/test/**/*.test.js"

TAP version 13
# Subtest: dist/test/map-limit.test.js
ok 1 - dist/test/map-limit.test.js
1..1
# tests 1
# pass 1
# fail 0
```

逐条用例明细（`node dist/test/map-limit.test.js`）：

```text
ok 1 - limits concurrency and resolves results in input order
ok 2 - failure stops launching later items, started items still settle, smallest failed index wins with success prefix
ok 3 - out-of-order failures: later index rejects first, final error uses smallest failed index
ok 4 - caller abort cancels unstarted items while started items still settle
ok 5 - pre-aborted signal rejects before any item starts
ok 6 - mapper receives item, index and an AbortSignal
ok 7 - synchronous mapper throw is treated as item failure
ok 8 - edge cases: empty input resolves, invalid concurrency rejected
1..8
# tests 8
# pass 8
# fail 0
```
