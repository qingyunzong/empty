# symbol-impact-review

审查库：按符号引用图把改动映射到公开入口，并为每个入口返回最短影响链。

## 语义

- 边 `from -> to` 表示符号 `from` 引用（依赖）符号 `to`；影响沿**反向**传播：
  `to` 变更时，所有（传递）引用它的符号都受影响。
- 变更集 = 新增符号 ∪ 删除符号 ∪ 出边集合发生变化的符号（`diffGraphs`）。
- 分析在**旧图与新图的并集**上进行（`unionGraph`）：被删除的符号及其旧引用边
  仍然保留，因此删除符号依旧产生旧图影响。
- 对每个公开入口，用 BFS（反向边）求所有变更符号到该入口的最短“被引用”链，
  取最短者作为该入口的影响链（`analyzeImpact`）。
- 输入图为纯 JSON / 内存对象，仅经 `node:fs` 读本地文件，**不访问网络**。

## 结构

- `src/graph.ts` — 图类型、并集、差异分类（added / removed / modified）
- `src/impact.ts` — 影响分析：每入口最短影响链（BFS）
- `src/evidence.ts` — 小图简单路径全枚举，供测试独立核对最短性
- `src/io.ts` — 本地 JSON 图文件加载与校验（仅 `node:fs/promises`）
- `src/cli.ts` — 命令行报告（`node:util` parseArgs）
- `test/impact.test.ts` — 单元测试 + 200 组随机小图的全路径枚举核对

## 使用

```sh
npm test          # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck # 严格类型检查
node dist/src/cli.js --old examples/old-graph.json --new examples/new-graph.json
```

环境说明：本环境 Node v22.22.1 未内建 TypeScript 支持，且无网络，
故测试流程为全局 `tsc`（TypeScript 7.0.2）编译后运行 `node --test`；
`types/node.d.ts` 提供所用 Node 内置模块的最小类型声明。

## 实际测试结果（2026-10-05，Node v22.22.1）

```
$ npm test
ok 1 - maps a change to its entry via the shortest chain
ok 2 - deleted symbols keep their old-graph impact (union semantics)
ok 3 - deleted-only symbol with no direct entry change still impacts entry
ok 4 - diffGraphs classifies added / removed / modified
ok 5 - identical graphs produce no impact
ok 6 - parseGraph validates input and reads no network
ok 7 - reported chains match exhaustive path enumeration on small graphs
# tests 7
# pass 7
# fail 0
```

`npm run typecheck`：通过，无错误。

CLI 示例输出（`examples/` 中旧图删除 `util/cache` 引用、新图新增 `db/pool`）：

```
changed symbols: db/client, db/pool, svc/user, util/cache
entry api/orders: db/client -> repo/order -> svc/order -> api/orders
entry api/users: svc/user -> api/users
```
