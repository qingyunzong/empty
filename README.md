# observable-store

一个可观察状态库：状态同步提交、观察者异步通知，支持慢观察者合并、
优雅退订与关闭。

## 语义

- **同步提交，异步通知**：`setState` 立即提交并返回新版本号，观察者回调
  总是在微任务中异步触发。
- **异常隔离**：观察者抛出异常（同步或 Promise 拒绝）不会回滚已提交状态，
  也不影响其他观察者；错误通过 `subscribe` 的 `onError` 选项上报。
- **慢观察者合并**：回调仍在执行时产生的新版本不会排队逐条推送，只保留
  最新版本；下一次通知通过 `meta.skipped = { from, to }` 标明被跳过的
  版本区间（闭区间）。
- **退订等待**：`unsubscribe()` 返回 Promise，在当前进行中的回调结束后
  才兑现；此后不再收到通知。
- **关闭**：`close()` 丢弃未发送的通知、等待所有进行中的回调结束；关闭后
  `setState` / `subscribe` 抛错，不会再有任何通知。
- **重入安全**：观察者可在回调中再次 `setState`，新版本会在当前回调结束
  后按提交顺序继续投递，不会死锁或重入回调。

## 用法

```ts
import { ObservableStore } from './src/store.js';

const store = new ObservableStore({ count: 0 });

const sub = store.subscribe(
  (state, meta) => {
    console.log(state.count, meta.version, meta.skipped);
  },
  { onError: (err) => console.error('observer failed', err) },
);

store.setState((s) => ({ count: s.count + 1 }));

await sub.unsubscribe(); // 等待当前回调结束
await store.close();
```

## 脚本

- `npm test`：编译 TypeScript 并运行 `node:test` 测试（含受控 Promise
  验证慢观察者合并、重入更新与关闭语义）。
- `npm run typecheck`：`tsc --noEmit` 严格类型检查。
