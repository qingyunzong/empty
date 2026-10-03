# settlement-graph

机构结算有向图：append-only 审计日志 + 原子 checkpoint + 哈希链校验。
Node.js 22，仅标准库与 node:test，无第三方依赖。

## 文件

- `append-audit.log` — 每行一条 JSON 事件，含 `seq`、`prevHash`、`hash`（SHA-256 哈希链）
- `checkpoint.json` — 快照（状态、`lastSeq`、`lastHash`、`stateRoot`），先写 `.tmp` 再 rename 原子替换

## 命令

```sh
node src/cli.js add-edge A B [--dir D] [--crash=before-checkpoint|after-checkpoint]
node src/cli.js delete-edge A B [--dir D]
node src/cli.js query-scc [--dir D]
node src/cli.js verify-history [--dir D]
```

commit 协议：先把事件及 prevHash 追加到日志并 fsync，再写 checkpoint。
`--crash=before-checkpoint` 在追加后、写 checkpoint 前退出（exit 3）；
`--crash=after-checkpoint` 在临时 checkpoint 替换正式文件后退出（exit 3）。
重启恢复只重放 checkpoint 之后的日志记录，已入 checkpoint 的事件不会重复执行
（`appliedCount` 与日志长度严格一致，verify-history 会校验）。

`verify-history` 校验：哈希链完整性、checkpoint 与日志前缀的 stateRoot 一致性、
当前状态根，以及 n<=7 时 Tarjan 与独立 Kosaraju 算法的 SCC 对照。

## 库用法

```js
import { commit, recover, verify, tarjanScc, kosarajuScc } from './index.js';
```

## 测试

```sh
node --test
```
