# upgrade-plan — 差量包升级路径规划 CLI

在磁盘空间限制下，从有向版本边（差量包）图中选择**总下载量最小**的升级路径；
总下载量并列时取**包 ID 序列字典序最小**者。输出**逐步空间证书**，并对小图做
**枚举对照**验证。纯 TypeScript + Node.js 内置库，零运行时依赖。

## 输入

JSON 文件（或 `-` 表示标准输入），至多 18 个差量包：

```json
{
  "start": "v1",
  "target": "v4",
  "spaceLimit": 300,
  "packages": [
    { "id": "p1", "from": "v1", "to": "v2", "bytes": 100, "peak": 120 }
  ]
}
```

- `start` / `target`：起始 / 目标版本节点（非空字符串）。
- `spaceLimit`：磁盘空间上限（字节，非负整数）。
- `packages[].id`：包 ID，全局唯一；字典序按 UTF-16 码元比较。
- `packages[].from` / `to`：有向版本边的两端。
- `packages[].bytes`：下载字节费（正整数）。
- `packages[].peak`：应用期间除包文件本身外的峰值暂存字节（非负整数）。

## 空间模型

调度策略为**即需即下载、应用后立即删除已消费包**：

1. 下载包 `p`：占用 `+= p.bytes`，不得超过上限；
2. 应用包 `p`：再 `+= p.peak` 暂存，达到本步峰值，不得超过上限；
3. 清理：删除已消费包 `p` 并释放暂存，占用回落。

提前下载只会增加同时占用，因此该调度对任意固定包序列都是峰值最优的；
一条路径可行 ⟺ 每条边都满足 `bytes + peak ≤ spaceLimit`。
由于 `bytes ≥ 1`，含环路径必可去环严格降低费用，最优路径必为简单路径。

## 算法

- **求解**：在可行边上做 Dijkstra，标号为 `(总下载量, 包ID序列)` 二元组，
  按先费用后字典序的全序比较；正费用保证最优子结构（同节点不会出现
  “一序列为另一序列前缀”的并列），首弹出即最优。
- **枚举对照**：DFS 枚举所有 `start → target` 简单路径（默认上限 200 万条，
  `--cap` 可调），独立求最优并与求解器比对，输出 `MATCH` / `MISMATCH`。

## 用法

```sh
npm run build                          # 编译到 dist/
node dist/src/cli.js examples/chain.json
node dist/src/cli.js - --json < input.json
node dist/src/cli.js input.json --no-enumerate --cap 5000000
```

退出码：`0` 成功；`1` 输入/用法错误；`2` 无可行方案；`3` 枚举对照不一致。

## 测试

```sh
npm test    # tsc 编译 + node --test
```

测试覆盖：字典序比较、空间可行性、最小下载量选择、并列打破、证书逐步核算、
输入校验、CLI 退出码，以及 300 例随机小图上求解器与枚举的交叉验证。
实际运行记录见 [TEST_RESULTS.md](TEST_RESULTS.md)。

## 目录结构

- `src/types.ts` — 问题 / 结果 / 证书类型
- `src/parse.ts` — 输入校验（含 18 个包上限）
- `src/solver.ts` — 字典序比较、Dijkstra 求解、空间证书生成
- `src/enumerate.ts` — 简单路径枚举对照
- `src/report.ts` — 文本报告（含证书表格）
- `src/main.ts` / `src/cli.ts` — CLI 主逻辑与入口
- `test/` — node:test 测试；`examples/` — 示例输入
