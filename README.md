# observable-store

零依赖 TypeScript 可观察状态库。

## 语义

- **同步提交，异步通知**：`set`/`update` 同步提交状态并递增版本号，观察者通知始终在微任务中异步派发。
- **观察者异常隔离**：观察者抛错或 reject 不会回滚已提交状态，也不影响其他观察者；错误路由到 `onObserverError`。
- **慢观察者合并**：回调仍在执行时，只保留最新版本；下一次通知携带 `skipped: { from, to }` 标记被跳过的版本区间。
- **退订等待**：`unsubscribe()` 返回的 promise 在当前回调结束后才 resolve，之后不再通知。
- **关闭语义**：`close()` 等待在途回调完成、丢弃未派发通知，resolve 后保证无任何通知；此后 `set`/`update`/`subscribe` 抛错。
- **重入安全**：观察者在回调中调用 `update` 会被序列化为后续通知，不会嵌套派发。

## 用法

```ts
import { ObservableStore } from "./src/observable-store.js";

const store = new ObservableStore(0, {
  onObserverError: (err) => console.error(err),
});

const sub = store.subscribe(({ value, version, skipped }) => {
  if (skipped) console.log(`skipped versions ${skipped.from}..${skipped.to}`);
});

store.update((n) => n + 1); // 同步提交，异步通知
await sub.unsubscribe();    // 等待在途回调结束
await store.close();        // 关闭后无通知
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

测试使用受控 promise（手动 resolve 的 `deferred`）验证慢观察者合并、退订等待、重入更新序列化及关闭后无通知。

> 环境无网络，无法安装 `@types/node`；`types/node-shims.d.ts` 提供所需 Node API 的最小类型声明。
