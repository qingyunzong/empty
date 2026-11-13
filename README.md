# 可访问树差分快照

RPA 定位服务需要可导入的 TypeScript accessibility tree 差分库，以 backend node id、role、name 和关系边维护版本图。节点 ignored 状态变化可重挂子树，id 在文档切换后不可复用；查询绑定版本，增量应用结果与完整树重建保持一致。

## 用法

```ts
import { AXTreeStore } from "./index.ts";

const store = new AXTreeStore();

// 全量加载文档，产生版本 1
const v1 = store.loadDocument("doc-1", [
  { backendNodeId: 1, role: "RootWebArea", name: "doc", childIds: [2, 3] },
  { backendNodeId: 2, role: "button", name: "Save" },
  { backendNodeId: 3, role: "generic", ignored: true, childIds: [4] },
  { backendNodeId: 4, role: "textbox", name: "Email" },
]);

// 查询绑定到具体版本的不可变快照
v1.effectiveChildren(1); // ignored 节点被折叠，子树重挂到最近非 ignored 祖先

// 增量应用（部分字段缺省时沿用上一版本的值），返回新版本与差分
const { snapshot: v2, diff } = store.applyUpdates([
  { backendNodeId: 3, ignored: false },
]);
diff.reparented; // 子树有效父节点变化
diff.added / diff.removed / diff.changed;

// 任意版本对差分
store.diff(1, 2);

// 文档切换后旧 id 全部退役，复用会抛错
store.loadDocument("doc-2", [{ backendNodeId: 100, role: "RootWebArea" }]);
```

## 设计要点

- **版本图**：每次 `loadDocument` / `applyUpdates` 提交一个不可变 `AXSnapshot`，查询（`getNode` / `find` / `effectiveChildren` / `subtreeIds`）均绑定快照版本。
- **关系边**：`childIds` 为权威边，`parentId` 由边推导；加载时校验单根、无环、无悬挂节点。
- **ignored 重挂**：`effectiveChildren` / `effectiveParentId` 动态跳过 ignored 节点，ignored 翻转时子树自动重挂，差分以 `reparented` 上报。
- **id 不复用**：文档切换时旧 id 进入退役集，后续加载或增量更新复用即抛错。
- **增量一致**：增量路径与全量加载共用同一 `buildTree` 构建管线，增量结果与合并后全量重建结构等价（有测试保证）。

## 脚本

- `npm run typecheck`：严格类型检查（noEmit）。
- `npm run build`：编译到 `build/`（含声明文件）。
- `npm test`：构建并运行 `test/` 下的 node:test 用例。
