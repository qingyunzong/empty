# batch-genealogy

离线单机批次谱系追踪库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

工厂以投入产出发送批次：一个产出批次可由多个投入批次生成（转换事件）。
批次可被 `hold` / `release` / `ship`。在谱系图中增量插入（append）、
更正（correct）或撤销（undo）转换事件时，库会维护每个批次的阻断状态，
并输出下游可达差异（版本 diff）。

## 状态语义

- 任一批次被 `hold` 后，其所有未发货后代自动进入 `held`（阻断原因为祖先持有）。
- 已发货批次状态保持 `shipped`，但其证书（certificate）须列出从质量源头
  （被 hold 的批次）到该批次的完整风险路径。
- 无阻断来源的批次为 `released`。

## 错误

| 代码 | 含义 |
| --- | --- |
| `UNKNOWN_BATCH` | 未知批次（含未知父批次） |
| `UNKNOWN_EVENT` | 未知事件 id |
| `DUPLICATE_OUTPUT` | 重复产出批次定义 |
| `DUPLICATE_EVENT` | 重复事件 id |
| `CYCLE` | 谱系环路 |
| `OUTPUT_REFERENCED` | 撤销/重命名的批次仍被其他事件引用 |
| `INVALID_EVENT` / `INVALID_OP` / `UNKNOWN_OP` | 事件或操作非法 |

## CLI

```sh
node src/cli.js trace events.json -o result.json
```

- `events.json`：操作数组或 `{ "ops": [...] }`，支持
  `append` / `correct` / `undo` / `hold` / `release` / `ship` / `query`。
- 退出码：`0` 全部成功；`1` 某个操作失败（result.json 含 `error`
  与已应用操作的部分结果）；`2` 用法或文件读取错误。
- 输出为规范化 JSON（键排序、无时间戳），同一操作序列产生逐字节一致的结果，
  证书带 SHA-256 哈希。

示例见 `examples/events.json`：

```sh
node src/cli.js trace examples/events.json -o result.json
```

## 库 API

```js
const { Genealogy } = require('./src/genealogy');
const g = new Genealogy();
g.appendEvent({ id: 'e1', output: 'A', inputs: [] });
g.appendEvent({ id: 'e2', output: 'B', inputs: ['A'] });
g.hold('A');
g.query('B');        // 状态、阻断原因、确定性证书
g.certificate('B');  // { batch, version, status, riskSources, paths, hash }
```

每个变更操作返回 `{ op, version, diff }`，`diff` 含边增删与状态变化
（`from`/`to` 快照）。

## 测试与验收

```sh
node --test          # 单元 + CLI + 随机化 DFS 参考交叉验证
scripts/run-acceptance.sh   # 运行 node --test 并把真实 stdout/stderr/退出码写入 test-results.txt
```

`src/reference.js` 是独立的暴力 DFS 参考实现（枚举所有路径），
`test/reference.test.js` 用多个随机种子的小图操作序列逐项比对库输出。
