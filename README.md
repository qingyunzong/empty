# 组合树角色/名称定位器

浏览器 RPA 用的可导入 TypeScript 组件。输入是调用方提供的文档树、开放的影子根、slot 显式分配和节点可访问名称；组件只在**组合树**上按 `role + accessible name` 定位，不依赖真实 DOM。

## 组合规则

- 有开放影子根时，影子根子节点替代宿主的普通（light DOM）子节点。
- `slot` 是透明占位节点，自身不会成为定位结果。存在分配节点时只展开分配节点；分配为空时才展开 slot 自己的后备子节点。
- 关闭的影子根不可穿透，宿主本身可见，但影子内容与 light DOM 子节点都不可见。
- 每个节点在一个版本中至多出现一次。重复结构节点、重复 slot 分配或分配形成的环会让**整个版本**构建失败。
- slot 分配可以嵌套：被分配节点本身可以是有开放影子根和 slot 的宿主。

核心输入既支持对象树，也支持按 id 引用的可序列化快照。

```ts
import {
  buildComposedTree,
  locateByRoleAndName,
  MockBrowserAdapter,
  SnapshotValidationError,
} from "dlks-q196";
```

```ts
const save = { id: "save", role: "button", name: "Save" };
const tree = {
  id: "doc",
  role: "document",
  children: [{
    id: "card",
    role: "group",
    name: "Card",
    children: [save],
    shadowRoot: {
      mode: "open",
      children: [{
        id: "card-slot",
        kind: "slot",
        role: "presentation",
        slot: { name: "body", assignedNodes: [save] },
      }],
    },
  }],
};

const version = buildComposedTree(tree);
const result = locateByRoleAndName(version, "button", "Save");

if (result.status === "found") {
  console.log(result.node.id, result.path.nodeIds);
} else if (result.status === "ambiguous") {
  console.log(result.candidates.map((node) => node.id));
} else {
  console.log("not found");
}
```

`locateByRoleAndName` 也接受 `{ role, name }`。名称精确匹配；省略 `name` 表示该角色匹配任意名称，`name: ""` 只匹配空名称。返回值是判别联合：

- `found`：唯一匹配，带 `node` 与 `path`。
- `ambiguous`：多个匹配，`candidates` 是完整的明确集合，按组合树顺序排列，不会静默取第一个。
- `not-found`：零匹配，`candidates` 为空数组。

## 路径稳定性

`path.nodeIds` 与 `path.steps` 使用稳定节点 id 和关系类型，不含兄弟序号。插入/删除兄弟节点不会改变已记录路径；`resolvePath(oldPath)` 按目标节点 id 在新版本中重新解析，因此宿主重挂后旧路径仍能解析回同一目标。目标被删除时返回 `undefined`。

```ts
if (result.status !== "found") throw new Error("expected one match");
const adapter = new MockBrowserAdapter(tree);
const recorded = result.node.path;

adapter.batch((tx) => {
  tx.insertBefore("doc", { id: "spacer", role: "generic", name: "Spacer" }, "save");
});

const restored = adapter.resolvePath(recorded); // 仍是同一个 save 节点
```

## 模拟浏览器适配器

`MockBrowserAdapter` 持有可变树，提供 `batch` 或声明式 `applyBatch` 做**原子批次更新**：

```ts
const adapter = new MockBrowserAdapter(tree);

adapter.applyBatch([
  {
    type: "appendChild",
    parentId: "doc",
    child: { id: "other-section", role: "region", name: "Other" },
  },
  { type: "reparent", nodeId: "card", parentId: "other-section" },
  { type: "setName", nodeId: "save", name: "Save changes" },
]);
```

事务内可用 `createNode`、`addRoot`、`appendChild`、`insertBefore`、`reparent`、`removeNode`、`attachShadow`、`setSlotAssignments`、`setSlotName`、`clearSlot` 等操作。批次完成后才发布新版本；如果事务抛错或产生重复分配/环，旧版本、旧路径和旧 revision 全部保留。

```ts
adapter.batch((tx) => {
  tx.setSlotAssignments("card-slot", ["save"]);
  tx.setAccessibleName("save", "Save changes");
});
```

## 校验错误

构建失败统一抛出 `SnapshotValidationError`，`code` 为：

- `DUPLICATE_NODE`：节点出现在多个结构位置、重复 id 或重复根。
- `DUPLICATE_ASSIGNMENT`：同一节点被一个或多个 slot 重复分配。
- `CYCLE`：结构边或 slot 分配边形成环。
- `UNKNOWN_NODE`：引用了不存在的节点 id。
- `INVALID_SNAPSHOT`：输入结构或字段非法。

整个校验先于版本发布完成；调用方不会拿到部分构建的树。

## 开发

```bash
npm run build
npm test
```

测试覆盖嵌套 slot、后备内容、关闭影子根、重复分配、环、同名歧义、宿主重挂，以及一次批次更新后的路径稳定性。
