# 云资源三方合并器

零依赖、可嵌入的 TypeScript 三方合并组件。输入上次应用配置 `base`、当前线上对象 `current` 和新期望值 `desired`，输出：

- `merged`：本组件持有字段的所有权、并保留其他管理者改动后的合并结果；
- `patch`：把 `current` 变成 `merged` 的可序列化补丁；
- `conflicts`：双方同时修改同一字段时的字段级所有权冲突。

```ts
import {
  applyPatch,
  threeWayMerge,
  type ThreeWayMergeOptions,
} from "dlks-formal-2570";

const base = {
  spec: {
    image: "v1",
    replicas: 2,
    containers: [{ name: "api", image: "api:v1" }],
    tags: ["cn"],
  },
};

const current = {
  spec: {
    image: "v1",
    replicas: 3, // 其他管理者已扩容
    containers: [
      { name: "api", image: "api:v1" },
      { name: "sidecar", image: "proxy:1" },
    ],
    tags: ["cn", "live"],
    unknownRuntimeField: "keep-me",
  },
};

const desired = {
  spec: {
    image: "v2",
    replicas: 2,
    containers: [{ name: "api", image: "api:v2" }],
    tags: ["cn", "desired"],
  },
};

const options: ThreeWayMergeOptions = {
  lists: {
    "spec.containers": { strategy: "keyed", key: "name" },
    "spec.tags": "set",
  },
};

const result = threeWayMerge(base, current, desired, options);

// replicas 保留 3，image 使用 v2；sidecar、unknownRuntimeField 均保留。
// result.conflicts 为空。
const applied = applyPatch(current, result.patch);
// applied 与 result.merged 深相等
// applyPatch(applied, result.patch) 仍与 applied 深相等（幂等）
```

## 合并语义

对象字段按三方规则逐层合并：

| 情况 | 结果 |
| --- | --- |
| `current === base` | 采用 `desired` |
| `desired === base` | 保留 `current` |
| `current === desired` | 采用该值 |
| 双方都改成不同值 | 记录冲突，默认保留 `current` |
| `base` 有、双方都删除 | 删除 |
| `base` 有、`current` 删除、`desired` 未改 | 接受删除 |
| `current` 独有 | 保留（未知字段 / 并发新增） |
| `desired` 独有 | 新增 |

字段值可以是对象、数组、标量或 `null`。`null` 是普通值，不会被当作删除标记。

对象的未知字段始终保留：`current` 中不在 `base`、也不在 `desired` 的字段不会进入补丁，也不会在合并结果中丢失。

## 列表策略

通过 `lists`、`listRules`、`listStrategies` 或 `mergeKeys` 声明；路径支持点路径、JSON Pointer、`*` / `**` 通配符。匹配到多条规则时，越具体的规则优先。

### `atomic`（默认）

整个数组视为一个值，只支持整体替换。双方都修改且结果不同，会在列表路径（例如 `/spec/args`）产生一个冲突。

### `set`

无序集合，默认用深度结构相等作为元素身份，也可传入 `identity(item)` 或按键提取身份。

- 双方并发新增的不同元素取并集；
- `base` 中已被任一方删除的元素不再出现；
- 一方删除、另一方未修改时接受删除；
- `desired` 不知道的 `current` 并发新增元素会保留；
- 重复且相等的元素自动去重。

### `keyed`

按键合并数组项，默认键为 `name`，推荐显式声明：

```ts
lists: {
  "spec.containers": { strategy: "keyed", key: "name" },
  "spec.ports": { strategy: "keyed", keys: ["containerPort", "protocol"] },
}
```

也可以用简写 `mergeKeys: { "spec.containers": "name" }` 声明按键列表。

- 同一个键的数组项递归执行对象三方可合并；
- 双方新增同键对象时，不同字段会合并；
- 键相同的项内字段冲突，路径精确到字段，例如 `/spec/containers/[name=web]/image`；
- `desired` 删除一个未变化的项会成功；
- `desired` 删除一个已被 `current` 修改的项会产生 `modify-delete` 冲突，默认保留线上项；
- 列表顺序为 `base` 项、`current` 新增项、`desired` 新增项。

`key` 也支持函数：`(item, index, path) => string | number`。重复键或缺少键会抛出 `MergeError`。

## 冲突

```ts
interface MergeConflict {
  path: string;                 // /spec/containers/[name=web]/image
  pathSegments: readonly string[];
  kind: "modify" | "add" | "delete-modify" | "modify-delete";
  base: { present: boolean; value?: unknown };
  current: { present: boolean; value?: unknown };
  desired: { present: boolean; value?: unknown };
  resolved: { present: boolean; value?: unknown };
  winner: "current" | "desired";
}
```

- 默认 `conflictResolution: "current"`，避免覆盖其他管理者的线上修改；
- 可设置 `conflictResolution: "desired"` 显式让期望值获胜；
- 冲突按 `path` 稳定排序；
- 对象键和按键列表项路径不受输入对象键顺序、数组顺序影响；
- 路径片段按 JSON Pointer 转义（`~` → `~0`，`/` → `~1`）。

## 补丁

补丁是可序列化、无 `null` 歧义的树形结构：

```ts
type MergePatch =
  | { op: "replace"; value: unknown }
  | { op: "remove" }
  | { op: "merge"; fields: Record<string, MergePatch> };
```

合并后的列表在补丁中整体替换，避免集合增删或按键项移动导致重复应用。`applyPatch` 不修改输入，删除不存在的键是空操作，因此：

```ts
const once = applyPatch(current, patch);
const twice = applyPatch(once, patch);
// once === twice === merged
```

## API

- `threeWayMerge(base, current, desired, options?)`：返回 `{ merged, patch, conflicts, hasConflicts }`；
- `merge3` / `merge` / `computeMerge`：`threeWayMerge` 的别名；
- `ThreeWayMerger` / `createMerger(options)`：绑定选项的可复用实例；
- `applyPatch(document, patch)` / `applyMergePatch`：应用补丁；
- `createPatch(current, target)`：生成 `current → target` 补丁；
- `computePatch(base, current, desired, options?)`：只返回合并补丁；
- `MergeError`、`deepEqual`、`stableStringify`：辅助导出。

## 开发

```bash
npm test        # 构建后运行 node:test
npm run typecheck
npm run build   # 输出 dist/
```

测试覆盖并发管理者交错更新、未知字段保留、原子/集合/按键列表、冲突路径稳定性、补丁应用与二次应用幂等。
