# snapshot-diff

快照测试库：按公开路径规则忽略易变字段，输出最小差异路径及双方原值。
仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无任何 npm 依赖。

## 语义

- **公开路径规则**：`$.a.b[0].c`、`$.items[*].id`、`$.items.*.id`、`$["weird key"]`，`$` 表示根。
- **数组顺序默认保留**：按索引逐一比较；`ignoreArrayOrder: true` 可显式关闭。
- **忽略规则不抹掉结构错误**：键缺失、数组长度变化、JSON 类型标签变化一律作为
  `structural` 差异上报，即使路径被规则忽略；忽略容器时仍校验其结构（键集合、
  数组长度、类型标签），仅抑制其内部的值差异。
- **最小差异路径**：在检测到差异的最浅节点停止下钻，每条差异携带 `path`、
  `kind`（`value` / `structural`）以及双方原值 `expected` / `actual`（缺失侧为 `undefined`）。
- **规范化幂等**：`normalize(normalize(x))` 与 `normalize(x)` 深度相等；被忽略的叶子
  替换为带类型的标记 `__snapshot_ignored__:<tag>`，结构保留。
  保留前缀 `__snapshot_ignored__:` 为标记专用，不应出现在快照数据中。

## API

```ts
import { diff, normalize, assertSnapshotsEqual, parsePath, formatPath } from "./src/snapshot.js";

diff(expected, actual, { ignore: ["$.meta.timestamp"], ignoreArrayOrder: false });
// => DiffEntry[]: { path, kind, expected, actual }，空数组表示匹配

normalize(value, ["$.meta.timestamp"]);           // 幂等规范化
assertSnapshotsEqual(expected, actual, options);  // 不匹配时抛出含全部差异路径的错误
```

## 测试

```
npm test    # tsc 编译后运行 node --test（单元测试 + 随机 JSON 属性测试）
```

属性测试使用带种子的随机 JSON 生成器（每轮 500 组样本）与**独立编写的递归比较器**
交叉核对：

1. `diff` 为空 ⟺ 独立递归比较相等
2. 每条上报路径都是真实差异，且携带双方原值
3. 规范化幂等（随机 JSON + 随机规则）
4. `normalize` 与 `diff` 一致（被忽略的值消失、结构差异保留）
5. 忽略规则绝不掩盖结构差异（加规则前后 structural 条目集合相同）
6. 忽略全部 value 路径后只剩 structural 条目
7. `ignoreArrayOrder` 与顺序无关规范化一致

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

ok 1 - dist/test/property.test.js    (7 个属性测试)
ok 2 - dist/test/snapshot.test.js    (14 个单元测试)
# tests 2
# pass 2
# fail 0
# duration_ms 2442.589183
```

共 21 个测试（14 单元 + 7 属性，属性测试每个 500 组随机样本），全部通过，0 失败。
