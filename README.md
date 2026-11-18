# 自定义资源版本转换组件

可嵌入的 TypeScript hub-spoke 转换器，用于在多个 CRD `apiVersion` 之间做确定性转换。核心代码不依赖 Node.js API，可直接用于接口服务、webhook 或其它 TypeScript 运行时。

## 快速开始

```ts
import { ResourceConverter } from "./index.ts";

const converter = new ResourceConverter({
  hubVersion: "example.io/v1",
  retention: { annotationKey: "example.io/retained-fields" },
  versions: [
    {
      version: "example.io/v1",
      fields: ["spec.replicas", "spec.image", "spec.debug"],
      defaults: [{ path: "spec.replicas", value: 1 }],
    },
    {
      version: "example.io/v1alpha1",
      fields: ["spec.replicaCount", "spec.image", "spec.debug"],
      toHub: [{ from: "spec.replicaCount", to: "spec.replicas" }],
      defaults: [{ path: "spec.replicaCount", value: 3 }],
    },
    {
      version: "example.io/v1beta1",
      fields: ["spec.replicas", "spec.imageName"],
      toHub: [{ from: "spec.imageName", to: "spec.image" }],
    },
  ],
});

const converted = converter.convert(
  {
    apiVersion: "example.io/v1alpha1",
    kind: "Widget",
    metadata: { name: "demo" },
    spec: { replicaCount: 0, image: "" },
  },
  "example.io/v1beta1",
);

// spec.replicas / spec.imageName 按 beta 版本输出；
// spec.debug 无法在 beta 表示，写入保留项；
// replicaCount = 0 与 image = "" 是显式值，不会被默认值覆盖。
```

## 转换语义

### Hub-spoke 路由

每次转换固定执行：

```text
source version -> hub version -> target version
```

即使源版本与目标版本相同，也经过 hub。字段重命名由每个版本的 `toHub` 表描述；未声明的字段默认与 hub 同路径。

### 默认值

- 默认值只在目标版本的最终输出中注入。
- 只有键缺失时才注入。
- `0`、`false`、`""`、`null` 都是显式值，不会触发默认值。
- 中间 hub 阶段不注入 hub 默认值，避免 hub 默认值抢先覆盖目标版本默认值。
- 每次注入都会深拷贝默认值，调用方修改结果不会污染转换表。

### 降级保留项

目标版本无法表示的 hub 字段会写入受控 annotation，默认键为
`conversion.example.io/retained-fields`，可通过 `retention.annotationKey` 修改。

annotation 的值是规范 JSON 字符串，例如：

```json
{"spec.debug":false,"spec.mode":"manual","spec.storage.size":0}
```

- 每次降级都会根据当前 hub 值重建保留项，不累积旧字段。
- 再次升级时逐值还原到 hub 的对应路径。
- 若升级源里已经有显式值，则以显式值为准，同时消费掉对应保留项，避免重复。
- 保留项为空时 annotation 被移除；保留项恢复完后不会留下空 annotation 对象。
- 保留项中的路径必须是当前 hub 已声明字段；否则抛出 `ConversionError`，避免通过 annotation 注入未声明字段。
- 非法 JSON、非对象保留项、重叠路径都会抛出 `ConversionError`，不会静默丢数据。

### 确定性与字节相等

- 输出对象的键按 UTF-16 code unit 递归排序。
- 保留项 JSON 同样使用规范键序。
- 对语义相同的资源，`canonicalStringify` / `canonicalBytes` 产生逐字节相同的结果。
- 对完整（无字段缺失）的无损往返，`source -> target -> source` 的规范字节完全相等；降级丢失的字段也能经保留项恢复后达到字节相等。

### 热替换与并发隔离

`replaceTable` 会先完整编译、验证并冻结新表，然后只做一次引用赋值来发布：

```ts
converter.replaceTable(nextTable);
```

转换开始时捕获当前快照，后续所有阶段只读该快照。因此：

- 编译失败时旧表继续生效。
- 并发请求在热替换前后分别看到完整旧表或完整新表，不会看到半更新状态。
- `convertAsync` 在第一个 `await` 前捕获快照；即使 `betweenStages` 钩子中再次替换表，进行中的转换仍使用原快照。
- 调用方在发布后修改自己的表对象，不会影响已经编译的快照。

## API

### `new ResourceConverter(table)`

编译并发布初始表。构造时若表非法会抛出 `ConversionError`。

### `converter.convert(resource, targetVersion)`

同步转换，返回规范化后的新资源对象，不修改输入。

### `converter.convertAsync(resource, targetVersion, hooks?)`

异步转换。可选钩子：

```ts
await converter.convertAsync(resource, target, {
  betweenStages: async ({ snapshotId, hub, sourceVersion, targetVersion }) => {
    // hub 为 hub 阶段资源的规范副本，可安全观察或记录
  },
});
```

### `converter.replaceTable(table)` / `converter.swapTable(table)`

原子发布新表，返回新的 `snapshotId`。`swapTable` 是别名。

### 其它

- `converter.snapshotId`：当前已发布快照编号。
- `converter.versions`：当前表声明的版本列表。
- `converter.hubVersion`、`converter.retentionAnnotationKey`：当前快照配置。
- `convertResource(table, resource, targetVersion)`：一次性转换便捷函数。
- `canonicalStringify`、`canonicalBytes`、`canonicalEquals`、`canonicalize`：确定性 JSON 工具。

## 转换表约束

- `fields` 必须完整列出该版本的叶子字段空间，路径使用点分隔，例如 `spec.storage.size`。
- 不支持数组下标路径；字段值本身可以是数组或对象。
- 同一版本内不允许重复字段，也不允许祖先/后代路径同时声明（如 `spec.a` 与 `spec.a.b`）。
- `apiVersion`、`kind`、`metadata` 是结构字段，不能出现在 `fields` 中；`metadata` 会原样保留（保留项 annotation 除外）。
- `toHub` 省略时按同路径映射。每个源字段最终都必须落到已声明的 hub 字段。
- 多个源字段不能映射到同一个 hub 字段。
- `defaults[].path` 必须是该版本已声明的字段。
- 表应完整声明字段空间；未声明的资源内容不属于转换契约。

## 测试

```bash
npm test        # 编译测试并运行
npm run typecheck
```

测试覆盖：

- 3 个版本、字段重命名、默认值、显式零值、降级保留和再升级恢复。
- 小字段空间穷举（每字段含缺失、`0`、`false`、`""`、`null`、对象、数组等），逐例与独立的朴素逐字段映射实现对照。
- 完整资源的全版本两两往返，按规范字节比较。
- 保留项逐值完整性、无重复、无遗漏、旧值不累积。
- 热替换期间的异步请求交错、阶段间替换、失败回滚和调用方表对象变更多种场景。
- 原型污染键、非法路径、非法表、非法保留项等边界。
