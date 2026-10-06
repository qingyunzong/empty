# tier-allocator

为 ≤16 个用户各分配一个质量档（或“不服务”），在两资源预算（≤100）内最大化总收益。
支持用户间组合收益、“必须同档 / 必须分离档”约束、逐条证书输出，以及可保存/恢复的搜索。

## 问题定义

- 每个用户取一个档 `0..T-1`（下标越大档越高）或 `UNSERVED = -1`（不服务，零消耗零收益）。
- 每个档消耗两类资源 `r1, r2` 并产生收益 `benefit`；总用量不超过 `budget1, budget2`。
- `pairBonuses`: 用户 `i` 取档 `a`、用户 `j` 取档 `b`（归一化为 `i<j`）时额外获得 `bonus`（可为负）。
- `constraints`:
  - `same(i,j)`：两人都被服务时必须同档；
  - `diff(i,j)`：两人都被服务时必须不同档；
  - 任一方未被服务时约束自动满足（vacuously satisfied）。

## 目标与平局裁决

1. 总收益（档收益 + 组合收益）最大；
2. 从最高档向下逐档比较在档人数，高档人数多者优；
3. 分配向量字典序小者优（`UNSERVED = -1` 最小）。

## 求解器

`src/solver.ts`：显式栈的迭代分支定界 DFS。
上界 = 当前收益 + 剩余用户最大档收益后缀和 + 剩余组合收益正上界后缀和，
上界严格小于当前最优收益时剪枝（等于时继续，保证平局裁决正确）。
搜索完全确定：同一问题多次运行节点数与结果均相同。

## 断点保存 / 恢复

`Solver#run(maxNodes)` 限制本次扩展的节点数，达到上限即暂停；
`saveToFile` / `Solver.loadFromFile` 把完整搜索状态（栈、选择、当前最优、节点数）
序列化为 JSON。断点文件含问题的规范序列化指纹，恢复时校验，问题不匹配则抛错。
暂停-恢复任意多次后的最终结果与节点数同不停顿运行完全一致（有测试保证）。

## 证书

`verifySolution(problem, assignment)` 输出逐条证书：
两类资源用量各一条、每条用户间约束各一条，并给出总收益与用量。
求解器/CLI 输出的解附带全部证书且均满足；篡改解会被对应证书精确指出。

## 使用

```bash
npm test          # 编译并运行全部测试（node:test，零依赖）
npm run build     # 仅编译到 dist/

# CLI：不间断求解
node dist/src/cli.js examples/problem.json

# CLI：每次最多扩展 500 个节点，暂停保存断点，重复调用即恢复续跑
node dist/src/cli.js examples/problem.json --checkpoint cp.json --max-nodes 500
```

CLI 输出 JSON：`assignment`（分配向量）、`benefit`、`usage`（两类资源用量）、
`certificates`（逐条证书）、`nodes`（扩展节点数）、`done`。

## 测试

- `test/solver.test.ts`：60 个随机小例与暴力枚举（`src/brute.ts`）逐一核对
  收益、分配向量、用量；平局裁决、不服务、约束、组合收益的构造用例。
- `test/checkpoint.test.ts`：暂停/保存/恢复（文件与内存两种）与不停顿运行
  结果及节点数一致；断点文件结构校验；问题不匹配拒绝恢复。
- `test/certificate.test.ts`：证书数量与内容、篡改解/超预算被精确检出、
  未服务用户使约束自动满足。
