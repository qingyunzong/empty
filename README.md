# upgrade-planner — 差量包升级路径规划 CLI

在峰值暂存空间限制下，从至多 **18 个差量包**（有向版本边，带字节下载代价）中选出
**总下载量最小** 的升级路径；总下载量并列时选 **包 ID 序列字典序最小** 者。
途中允许删除已消费的包，CLI 输出 **逐步空间证书**，并可用 `--enumerate`
对小图做暴力枚举对照。仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 模型

- 每个差量包是有向边 `from -> to`，下载代价 `bytes`（正整数）。
- 调度方式：即时调度 `下载 -> 应用(消费) -> 删除已消费包`。
  因此一条路径的最小峰值暂存 = 路径上**最大包的字节数**；
  超过 `spaceLimitBytes` 的包永远无法暂存，规划前直接排除。
- 证书逐步记录每个动作后的暂存量与峰值，并校验：峰值 ≤ 上限、
  版本链连续、结束到达目标版本、结束暂存为 0。

## 算法

1. 在合法包集合上做正向 / 反向 Dijkstra，得 `d1[v]`（source 到 v 最小代价）
   与 `d2[v]`（v 到 target 最小代价），总最优 `T = d1[target]`。
2. 字典序最小序列用**贪心**重建：维护不变量 `d1[current] == spent`，
   每步在满足 `spent + bytes + d2[to] == T` 的包中选最小 `id`。
   正确性依据：所有最优路径共享当前前缀，首个不同位置决定字典序；
   且字节数为正 ⇒ 最优路径均为简单路径，不存在一条最优序列是另一条的
   真前缀（否则后一条含零代价环，矛盾），故逐位贪心最优。
   （注意：直接对 (代价, 序列) 跑 Dijkstra 在"前缀更小"规则下是**错误**的，
   测试 `并列时选包 ID 序列字典序最小（含前缀陷阱回归）` 即为该回归用例。）
3. `--enumerate` 枚举所有简单路径（默认状态上限 2,000,000，超出报截断），
   与规划器结果对照。

## 输入格式

```json
{
  "source": "v1.0",
  "target": "v2.0",
  "spaceLimitBytes": 512,
  "packages": [
    { "id": "delta-ac", "from": "v1.0", "to": "v1.5", "bytes": 200 }
  ]
}
```

校验：`packages` ≤ 18 个；`id` 非空唯一；`from != to`；`bytes` 正整数；
`spaceLimitBytes` 非负整数。

## 用法

```bash
npm test                              # 编译 + 运行全部测试
npm run plan -- examples/sample.json  # 规划示例（文本证书）
npm run plan -- examples/sample.json --enumerate   # 附带小图枚举对照
npm run plan -- examples/sample.json --json        # 结构化输出
node dist/src/main.js plan - < input.json          # 从标准输入读取
```

退出码：`0` 成功；`2` 输入/用法错误；`3` 空间限制下无可行方案；`4` 枚举被截断。

## 环境说明

本环境 Node v22.22.1 未内建 TypeScript 类型剥离，故用全局 `tsc`（7.0.2）
预编译到 `dist/` 后运行；`src/node-shims.d.ts` 提供所用 Node 内置模块的
极简类型声明，无需 `@types/node`。

## 项目结构

- `src/model.ts` — 输入模型与校验（≤18 包、唯一 id、正整数字节等）
- `src/planner.ts` — Dijkstra 代价场 + 字典序贪心规划器
- `src/enumerate.ts` — 简单路径暴力枚举（对照用，带状态上限）
- `src/schedule.ts` — 即时调度模拟与逐步空间证书
- `src/cli.ts` / `src/main.ts` — 参数解析、渲染、退出码 / 进程入口
- `test/` — `node:test` 测试（含 500 个随机小图的规划器↔枚举对照）
- `examples/sample.json` — 示例输入

## 测试结果实录（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 摘要：

```
# tests 3
# pass 3
# fail 0
# duration_ms 1929.841788
```

逐用例（`node dist/test/<file>.test.js`，共 17 个，全部通过）：

```
planner.test.js
ok 1 - 选择总下载量最小的路径
ok 2 - 并列时选包 ID 序列字典序最小（含前缀陷阱回归）
ok 3 - 同费用平行边选字典序更小的包 ID
ok 4 - 超过空间上限的包被排除；全部排除后无可行方案
ok 5 - 起点即终点时为空方案
ok 6 - compareIdSeq 字典序与前缀规则
ok 7 - 随机小图：规划器与枚举对照一致，且空间证书有效   # 500 个随机图
schedule.test.js
ok 1 - 证书逐步记录下载/应用/删除，峰值等于路径最大包
ok 2 - 手工构造超限方案时证书判定失败
ok 3 - 包序列断裂时证书判定失败
cli.test.js
ok 1 - CLI 对示例输出逐步空间证书
ok 2 - CLI --json 输出可解析的结构化结果
ok 3 - CLI --enumerate 小图枚举对照一致
ok 4 - CLI 从标准输入读取（-）
ok 5 - CLI 输入非法时退出码 2
ok 6 - CLI 无可行方案时退出码 3
ok 7 - CLI --help 输出用法且退出码 0
```

示例运行 `npm run plan -- examples/sample.json --enumerate` 实际输出：

```
升级规划: v1.0 -> v2.0
总下载量: 450 B    峰值暂存: 250 B    上限: 512 B    包数: 2
包 ID 序列: delta-ac, delta-cd

逐步空间证书:
step  action    package   version  stored(B)  peak(B)  note
----  --------  --------  -------  ---------  -------  --------------------
1     download  delta-ac  v1.0     200        200      +200 B 暂存
2     apply     delta-ac  v1.5     200        200      应用 v1.0 -> v1.5，包已消费
3     delete    delta-ac  v1.5     0          200      删除已消费包，释放 200 B
4     download  delta-cd  v1.5     250        250      +250 B 暂存
5     apply     delta-cd  v2.0     250        250      应用 v1.5 -> v2.0，包已消费
6     delete    delta-cd  v2.0     250        250      删除已消费包，释放 250 B

空间证书: OK — 峰值 250 B <= 上限 512 B；结束暂存 0 B；到达目标版本 v2.0

枚举对照: 一致（枚举 3 条简单路径，最优 450 B / delta-ac, delta-cd）
```
