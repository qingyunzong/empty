# Protobuf 演进判定

可导入的 TypeScript protobuf schema 演进判定库。直接接受 `.proto` 文本、`FileDescriptorProto`/`FileDescriptorSet` JSON，或普通的 message 定义对象，不依赖 protobuf runtime。

```ts
import {
  compareSchemas,
  analyzeSchemaEvolution,
  parseProto,
  normalizeSchema,
  isBackwardCompatible,
  isForwardCompatible,
  isFullyCompatible,
} from "./index.ts";

const oldSchema = `
  syntax = "proto3";
  package contract;
  message Order { string old_name = 1; reserved 7; }
`;

const newSchema = `
  syntax = "proto3";
  package contract;
  message Order { string new_name = 1; string reused = 7; }
`;

const report = compareSchemas(oldSchema, newSchema);
report.compatible;            // false：字段 7 被删除后再次使用
report.minimalBreakingPath;   // "contract.Order.reused"
report.breakingChanges;       // 结构化破坏列表
```

## 输入

```ts
compareSchemas(oldInput, newInput, "backward" | "forward" | "full" | options?)
```

- `.proto` 字符串：支持 `syntax`、`package`、嵌套 `message`/`enum`、`oneof`、`map<...>`、`reserved`、字段选项和注释。
- Descriptor JSON：支持单个 `FileDescriptorProto`、`FileDescriptorSet`，以及 map entry 的合成 message。
- 普通对象：`{ messages: [{ name, fields: [...] }] }`，`messages`/`fields` 也可使用以名称为 key 的对象形式。
- 历史信息：可通过 `options.history` 或 message 内的 `deletedFields`/`removedFields` 提供，用于识别在旧快照之前就已删除的字段号。

## 输出

`compareSchemas` 返回 `EvolutionReport`：

- `backwardCompatible`：新 schema 能否读取旧 writer 的数据。
- `forwardCompatible`：旧 schema 能否读取新 writer 的数据。
- `bidirectionalCompatible` / `fullyCompatible`：两者是否同时成立。
- `compatible`：按请求的方向判断，默认 `full`。
- `compatibility`：`full`、`backward`、`forward` 或 `none`。
- `breakingChanges`：所有破坏项，每项含 `code`、`path`、`directions`、`oldValue`、`newValue`。
- `minimalBreakingPath` / `breakingPath`：最短破坏路径；同时提供按方向划分的路径。
- `minimalBreakingPaths`：全部独立破坏路径。
- `warnings`：不破坏二进制 wire 兼容、但影响 JSON/API 或未来演进安全的变化。

常用别名：`analyzeSchemaEvolution`、`analyzeCompatibility`、`checkCompatibility`、`compareProtobufSchemas`、`isCompatible`。布尔辅助函数：`isBackwardCompatible`、`isForwardCompatible`、`isFullyCompatible`。

## 判定规则

| 变化 | 结论 |
| --- | --- |
| 同字段号、同 wire type，改名 | 双向兼容，产生 `FIELD_RENAMED_SAME_NUMBER` 警告 |
| 使用旧 schema 已 reserved/删除的字段号或名称 | 双向破坏，产生 `FIELD_NUMBER_REUSED_AFTER_DELETE` 等 |
| 字段号变化 | 双向破坏 |
| wire type 变化 | 双向破坏 |
| 同 wire type 的标量变化，如 `int32 -> int64`、`string -> bytes` | wire 兼容，产生警告 |
| `int32 -> sint32` 等同 wire type 但编码族变化 | 双向破坏 |
| `optional <-> repeated` | 按数据丢失方向产生单向破坏 |
| `required` 增删/切换 | 按旧数据是否缺字段产生单向破坏 |
| 字段进入/离开 oneof | 进入破坏 backward，离开破坏 forward；仅 oneof 改名不破坏 |
| map 与普通 repeated 字段互换 | 双向破坏 |
| map key/value 的 wire type 变化 | 双向破坏 |
| open enum 增加值 | 兼容 |
| closed enum 增加值 | 破坏 forward |
| open -> closed enum | 破坏 backward |
| closed -> open enum | 破坏 forward |

## 测试

```bash
npm test
```
