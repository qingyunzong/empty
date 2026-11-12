# 采集记录的有损字段投影防护

归档转换服务调用TypeScript记录投影包，把嵌套对象按已编译路径提取为平面行。路径由字段名步骤和数组展开步骤[*]组成，多个目标路径若共享同一个数组节点则按元素位置对齐，不同数组节点作笛卡尔积；数组为空或字段缺失时保留一行并填独立的missing标记，显式null保留为null，不能混淆。遇到期望数组却为标量、或字段步骤作用于非对象时拒绝该记录。输出列名唯一，数组路径相同前缀只展开一次，缺省路径产生的占位也参与对齐。调用方限制一条记录最多生成的行数，超过上限不得交付部分行。返回每格原始JSON路径，输入不得改动。测试共享数组的相关字段、独立数组、嵌套空数组和恰好达到行数上限，用显式枚举参考实现比较。

## 用法

```ts
import { compileProjection, projectRecord, MISSING } from "./index.ts";

const compiled = compileProjection([
  { name: "id", path: "items[*].id" },
  { name: "qty", path: "items[*].qty" },
]);

const rows = projectRecord(compiled, { items: [{ id: 1, qty: 10 }] }, { maxRows: 1000 });
// rows[0].id  === { value: 1, path: "items[0].id" }
// rows[0].qty === { value: 10, path: "items[0].qty" }
```

## 语义约定

- **路径**：字段名步骤（`a.b`）与数组展开步骤 `[*]`（可写作 `a[*]`、`a.[*]`、根部 `[*]`）。
- **对齐与笛卡尔积**：共享同一数组节点的列按元素位置对齐（相同前缀只展开一次）；不同数组节点之间作笛卡尔积；嵌套数组按外层元素分组展平为行流。
- **missing 与 null**：数组为空或字段缺失时保留一行，相关单元格填独立的 `MISSING` 标记（`unique symbol`，永不为 `null`），占位路径中的数组步骤渲染为 `[*]`；显式 `null` 终端值原样保留为 `null`。占位与共享前缀的兄弟列按位置对齐。
- **拒绝记录**：期望数组却遇到非标量数组以外的值、或字段步骤作用于非对象（含 `null`）时，抛出 `ProjectionError`（`code: "TYPE_MISMATCH"`），不交付任何行。
- **行数上限**：`maxRows` 限制单条记录生成的行数，超限时抛出 `ROW_LIMIT_EXCEEDED`，不交付部分行；恰好达到上限时正常交付。
- **列名唯一**：重复列名在编译期抛出 `DUPLICATE_COLUMN`；非法路径抛出 `INVALID_PATH`。
- **单元格路径**：每格返回原始 JSON 路径（如 `items[0].id`），占位分支为 `items[*].id` 形式。
- **输入不可变**：投影不改动输入记录。

## 测试

```sh
npm test        # 编译到 dist/ 并运行 node:test 套件
npm run typecheck
```

`test/projection.test.ts` 覆盖共享数组对齐、独立数组笛卡尔积、嵌套空数组、行数上限边界等命名场景；`test/reference.ts` 是显式枚举所有数组节点下标组合的参考实现，`test/fuzz.test.ts` 用确定性随机生成（可用 `FUZZ_ITERATIONS` / `FUZZ_SEED_A` / `FUZZ_SEED_B` 环境变量调节）将主实现与参考实现逐格比对。
