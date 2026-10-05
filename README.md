# snapshot-diff

快照测试辅助库：按公开路径规则忽略易变字段，输出最小差异路径及双方原值。
TypeScript 编写，仅依赖 Node.js 内置模块（`node:test` / `node:assert`），零 npm 依赖。

## 语义

- **路径规则忽略**：规则如 `"meta.updatedAt"`、`"items[*].id"`、`"users[0].token"`，
  `*` / `[*]` 为单段通配符。命中规则的路径其值免于比较（两侧该路径都必须存在）。
- **数组顺序默认保留**：数组按下标逐一比较，交换元素即产生差异。
- **结构错误不可被忽略规则抹掉**：缺键、多键、数组长度不一致、容器类型不一致
  永远会上报，即使该路径命中忽略规则。
- **最小差异路径**：差异定位到最深的精确路径（如 `$.user.name`），
  每条差异携带双方**原始值**（未规范化的值）；缺失侧以 `MISSING` 哨兵表示。
- **规范化幂等**：`normalize(normalize(v, rules), rules)` 与 `normalize(v, rules)`
  深度相等（命中路径被替换为常量占位符，匹配只依赖路径不依赖值）。
- **未命中规则上报**：`unusedRules` 列出从未匹配任何路径的规则，便于发现配置笔误。

## API

```ts
import { diff, normalize, formatDiffs, MISSING } from "./src/index.js";

const result = diff(expected, actual, ["ts", "items[*].id"]);
result.equal;        // boolean
result.diffs;        // [{ path, reason, expected, actual }, ...] 最小差异路径 + 双方原值
result.unusedRules;  // 未命中的规则
formatDiffs(result); // 可读报告

normalize(value, ["ts"]); // 深拷贝并将命中路径替换为 "__SNAPSHOT_IGNORED__"，不改原值
```

## 测试

```
npm test   # tsc 编译 + node --test
```

测试包含属性化核对：500 组种子随机 JSON 上，
1. `normalize` 幂等性（与独立递归深比较验证）；
2. `diff()` 的相等判定与「先 normalize 再用独立递归比较器 `deepEqualIndependent`」
   的结果完全一致；
3. 规则命中情况在两条代码路径间一致。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - path rules: parse and format
ok 2 - ignore rules exempt volatile values, arrays keep order
ok 3 - array order is significant by default
ok 4 - ignore rules never mask structural errors
ok 5 - minimal diff paths carry both original values
ok 6 - type mismatch is reported at the exact path
ok 7 - unused rules are surfaced
ok 8 - normalize replaces ignored subtrees and never mutates input
ok 9 - normalize is idempotent
ok 10 - property: normalization idempotent + comparator agrees with independent recursion
ok 11 - property: identical values are always equal under any rules
# tests 11
# pass 11
# fail 0
```

## 结构

- `src/paths.ts` — 公开路径规则解析 / 格式化 / 匹配
- `src/normalize.ts` — 幂等规范化（忽略路径 → 占位符）
- `src/compare.ts` — 结构比较，产出最小差异路径与双方原值
- `tests/helpers.ts` — 种子随机 JSON 生成器、变异器、独立递归比较器
- `tests/snapshot.test.ts` — 单元测试 + 属性化交叉核对
- `types/node-shim.d.ts` — Node 内置模块的最小类型声明（沙箱无网络，无法安装 @types/node）
