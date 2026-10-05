# versioned-mode-query

可持久化查询的可变整数数组库：范围众数查询 + 原子块更新 + 历史版本保留。
仅使用 TypeScript 与 Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 语义

- **版本持久化**：初始数组为版本 0；每次成功的块更新产生一个不可变新版本，
  旧版本永久保留、可随时查询（`version(id)` / `rangeMode(id, from, to)`）。
- **原子块更新** `applyBlock(replacements)`：先整体校验、后一次性提交。
  任一替换非法（非安全整数、下标越界、块内下标重复）→ 抛错，整个块不生效，
  不产生新版本，已有版本不受污染。空块为无操作。
- **范围众数** `rangeMode(versionId, from, to)`（闭区间）：频次最高者胜出，
  频次并列时取数值较小者；空范围（`from > to`）返回 `null`；越界抛 `RangeError`。
- **频次证据**：查询返回 `{ value, frequency, positions, from, to, versionId }`，
  其中 `positions` 为众数在范围内的全部下标（升序），`positions.length === frequency`。

## 结构

- `src/versioned-array.ts` — 库实现（Map 扫描计数）
- `src/model.ts` — 参照模型：排序计数法 `sortedCountingMode` + 独立计数器 `countOccurrences`
- `src/random.ts` — mulberry32 确定性随机数（测试可复现）
- `test/versioned-array.test.ts` — 单元测试 + 随机对照测试
- `types/node-shims.d.ts` — `node:test` / `node:assert` 最小类型声明（环境无 @types/node）

## 运行

```sh
npm test   # tsc 编译后执行 node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

  [随机核对] 非空范围对照 1074 次，空范围 366 次，全部一致
    ok 1 - 返回众数值与频次证据
    ok 2 - 频次并列时取数值较小者
    ok 3 - 子范围查询只统计区间内元素
    ok 4 - 空范围（from > to）返回 null
    ok 5 - 越界范围与不存在的版本抛 RangeError
ok 1 - rangeMode 基本语义
    ok 1 - 合法块更新产生新版本，旧版本仍可查询
    ok 2 - 非法块整体拒绝：越界下标
    ok 3 - 非法块整体拒绝：非整数值与块内重复下标
    ok 4 - 空块为无操作，不产生新版本
ok 2 - 块更新原子性与版本持久化
    ok 1 - 随机替换 + 随机范围（含空范围）全量对照
ok 3 - 随机核对：排序计数模型 vs 库实现
# tests 10
# pass 10
# fail 0
```

随机核对方式：3 个固定种子 × 40 轮，随机数组（值域 [-4, 4]，并列频发）、
随机块更新序列、随机范围（约 1/4 为空范围，版本号随机含旧版本），
库实现与排序计数模型逐一比对 `value`/`frequency`，并核验证据
（`frequency` 等于独立计数、`positions` 与快照逐一吻合）。
