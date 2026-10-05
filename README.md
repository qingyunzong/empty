# sourcemap-compose

两级稀疏 source map 组合工具库。TypeScript 编写，运行时仅依赖 Node.js 内置模块
（`node:test` / `node:assert`，仅测试使用），零第三方依赖。

## 语义

- **查询取同行最近左段**：`originalPositionFor(map, line, col)` 在 `line` 行内做
  二分查找，取 `genCol <= col` 的最右段（greatest lower bound）。
- **缺失段保持无来源**：行内无段、首段之前的列、以及 generated-only 段
  （unmapped 标记段）之后的区间都返回 `null`；组合时若中间位置在下一级 map 中
  无映射，输出一个 generated-only 段，阻断 GLB 继续向左借位。
- **不能跨行借位置**：查询严格限定在目标行；空行、超出末行、负行号一律无来源。
- **原名按最末非空传播**：组合链 generated → outer → inner → original 上，
  结果名取 inner（更靠近原始侧）段的非空名，缺省再回退 outer 段的名。
- **输出压缩映射**：组合结果序列化为标准 base64 VLQ 相对增量编码的
  `mappings` 字符串，`sources`/`names` 去重重建。

## API

```ts
import {
  composeSourceMaps,      // (outer, inner) => 组合后的 SourceMapData
  parseSourceMap,         // SourceMapData => ParsedSourceMap（稀疏行段结构）
  originalPositionFor,    // (parsed, line, col) => { source, line, column, name } | null
  parseMappings,          // VLQ mappings => Segment[][]
  serializeMappings,      // Segment[][] => 压缩 VLQ mappings
  encodeVlq, decodeVlqAll,
} from './src/index.js';
```

`outer` 为后一级（生成代码 → 中间代码），`inner` 为前一级（中间代码 → 原始代码），
`composeSourceMaps(outer, inner)` 得到 生成代码 → 原始代码 的映射。

## 验证方法

测试中的参考模型（`test/helpers.ts`）独立于组合实现：对每个生成位置直接做
「outer 查询 → inner 查询」两步查找。穷举测试将组合输出的压缩映射重新解码后
**逐列展开**（每行从列 0 到末段列 +3，并额外覆盖末行之后 2 行），与参考模型
逐点比对，同时校验段列严格递增、sources/names 下标越界等良构性。覆盖：

- 手算夹具（精确断言组合后的 VLQ 字符串）；
- 边界夹具：空 mappings、空行、generated-only 段、跨行指向空行/越界行；
- 200 组种子化随机 map 对（mulberry32，确定性复现）的逐列等价性；
- 组合输出再序列化的幂等性（压缩形式规范）。

## 运行

```sh
npm test     # tsc 编译到 dist/ 后用 node:test 跑全部测试
npm run typecheck
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc），Linux x86_64。

```
$ npm test
ok 1 - dist/test/compose.test.js      # 7 个测试：手算组合、名称传播、缺失段、空输入
ok 2 - dist/test/exhaustive.test.js   # 5 个测试：逐列穷举核对（200 组随机对 + 边界夹具）
ok 3 - dist/test/mappings.test.js     # 3 个测试：解析/序列化往返、跨行相对增量
ok 4 - dist/test/query.test.js        # 5 个测试：GLB、行内阻断、禁止跨行借位
ok 5 - dist/test/vlq.test.js          # 3 个测试：已知向量、±2^30 大值往返
# tests 5  # pass 5  # fail 0         # 共 23 个断言测试，全部通过
```
