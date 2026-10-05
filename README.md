# sparse-sourcemap-compose

两级稀疏来源映射（source map）组合工具库。给定外层映射（生成代码 → 中间代码）
与内层映射（中间代码 → 原始源码），组合出生成代码 → 原始源码的映射，并以
source map v3 的压缩 VLQ `mappings` 字符串输出。仅使用 TypeScript 与
Node.js 内置库，无运行时依赖。

## 语义定义

- **稀疏段**：每条生成行持有若干段；段可以无来源（unmapped），映射中允许空行。
- **同行最近左段**：查询 `(line, column)` 时只在同一生成行内取 `genCol <= column`
  的最右段（greatest lower bound）；行首之前无段则结果为无来源。
- **不能跨行借位置**：空行或行首之前绝不借用其他行的段。
- **缺失段保持无来源**：最近左段为无来源段时查询结果就是无来源，不会继续向左
  回退到有来源的段；组合时内层查不到来源的外层段同样保持无来源。
- **原名按最末非空传播**：组合时名称沿组合链（外层 → 内层）取最末的非空值，
  即内层（原始）名称优先，缺失或为空串时回退到外层名称；查询报告被命中段
  自身的名称，空串视为无名称。

## API

```ts
import {
  compose, indexMap, originalPositionFor,
  parseMappings, serializeMappings,
} from 'sparse-sourcemap-compose';

const composed = compose(outerMap, innerMap);   // SourceMapData -> SourceMapData
const mappings = serializeMappings(composed);   // 压缩 VLQ 字符串
const hit = originalPositionFor(indexMap(composed), 0, 12); // 同行最近左段查询
```

- `parseMappings(mappings, sources, names)`：解码 v3 `mappings` 为稀疏段。
- `serializeMappings(map)`：把稀疏段编码为压缩 VLQ `mappings`（含无来源段与空行）。
- `indexMap(map)` / `originalPositionFor(indexed, line, column)`：按行索引 + 二分查询。
- `compose(outer, inner)`：两级组合，来源/名称数组重新去重编号。

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node:test 运行 dist/test/*.test.js
```

验证方式：固定边界用例（行首之前、空行、无来源段遮蔽、精确段边界、行尾之后、
名称链回退、压缩串往返）+ 随机模糊测试。模糊测试用种子化随机稀疏映射，
组合结果经压缩 VLQ 往返后，对每条生成行逐列展开，与独立实现的朴素参考模型
（线性扫描、直接按语义展开两级映射）逐列比对。

## 实际测试结果

在本环境（Node.js v22.22.1，tsc 7.0.2）执行 `npm test` 的实际输出：

```
# tests 3
# pass 3
# fail 0
```

逐列展开核对的诊断计数（全部一致，无偏差）：

```
ok - composed map matches the column-by-column reference model (sparse)
# seeds=400 columns compared=33700 mapped=2788 unmapped=30912
ok - composed map matches the column-by-column reference model (dense)
# seeds=400 columns compared=22196 mapped=4969 unmapped=17227
ok - reference model agrees with library queries on single maps
# seeds=200 columns compared=16815
```
