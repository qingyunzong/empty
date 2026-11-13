# DOM 增量快照应用

结构化网页采集器要可直接接入 TypeScript DOM 增量快照组件，应用 node insert/remove、attribute、text 与 shadow root 事件。操作引用不存在节点时缓存到有界等待区，删除父树使后续旧事件失效；每个版本可生成确定哈希，并与同版本完整快照对照。

## 用法

```ts
import { DomSnapshotApplier } from "./index.ts";

const applier = new DomSnapshotApplier({
  maxPendingEvents: 1024,   // 有界等待区容量，超出丢弃最旧事件
  maxTombstones: 4096,      // 已删除节点 id 墓碑上限，用于判定失效事件
  maxVersionHistory: 4096,  // 保留的 版本→哈希 记录数
});

applier.loadFullSnapshot({ id: 1, tag: "#document" }); // 版本 0

applier.apply({ type: "insert", parentId: 1, node: { id: 2, tag: "div" } });
applier.apply({ type: "attribute", nodeId: 2, name: "class", value: "card" });
applier.apply({ type: "text", nodeId: 2, text: "hello" });
applier.apply({ type: "shadowRoot", hostId: 2, root: { id: 3, tag: "#shadow-root" } });
applier.apply({ type: "remove", nodeId: 2 });
```

## 语义

- `apply(event)` 返回 `applied` / `deferred` / `stale`：
  - 目标节点不存在时事件进入有界等待区（FIFO），每次成功应用变更后按序重放；
  - 删除子树会为其中所有节点 id 记录墓碑，之后到达或仍在排队、引用这些 id 的事件一律判为 `stale` 丢弃；id 被重新插入后自动复活。
- 每次实际应用的变更使版本号 +1，并记录该版本的确定哈希（FNV-1a 64，属性排序、子节点按文档序、含 shadow root 的规范化序列化）。
- `verifyAgainstSnapshot(fullSnapshot, version?)` 将完整快照负载以同一规范化算法哈希，与指定（默认当前）版本对照。
- `stats()` 返回版本、节点数、等待区长度、丢弃/失效事件计数等观测指标。

## 脚本

- `npm test` — 运行测试（需要支持 type stripping 的 Node ≥ 22.6）。
- `npm run typecheck` — `tsc` 严格类型检查。
