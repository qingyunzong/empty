配置客户端需要可嵌入的TypeScript观察组件，把全量快照与增量通知按修订号合并，断线后从已确认水位恢复。压缩修订触发全量重建，旧连接迟到事件不能覆盖新值。用双连接交错和修订缺口验证订阅者看到单调一致的配置序列。

## 用法

`ConfigWatcher`（见 `src/config-watcher.ts`）是与传输层无关的嵌入式观察组件，
通过注入 `connect` 工厂接入任意连接实现（WebSocket、SSE、IPC 等）：

```ts
import { ConfigWatcher } from "./index.js";

const watcher = new ConfigWatcher({
  connect: (sink) => {
    const socket = openSocket({
      onMessage: (msg) => sink.onMessage(msg),
      onClose: () => sink.onClose(),
    });
    return {
      send: (req) => socket.send(req), // { fromRevision: number | null }
      close: () => socket.close(),
    };
  },
});

watcher.subscribe(({ revision, entries }) => render(entries));
watcher.start();
```

行为约定：

- 快照与增量按修订号合并；缺口增量先缓冲，补齐后按序应用。
- 断线重连携带已确认水位 `fromRevision` 续传；`fromRevision: null` 表示全量重建。
- 服务端回复 `compacted` 时清空本地状态并重新全量订阅。
- 被替换的旧连接上迟到的事件按连接身份丢弃，不会覆盖新值。
- 订阅者看到的修订号严格单调递增。

## 脚本

- `npm run build`：编译到 `build/`。
- `npm test`：编译并运行 `test/` 下的测试（双连接交错、修订缺口、压缩重建等）。
