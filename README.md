# qcl — 装配厂质量闭环离线管理

Node.js 22、仅标准库、单机离线。管理缺陷(open)、返工(rework)、复检/闭环(close)、
复检更正(correct)、撤销(undo)、报废(墓碑)。状态 = JSON 快照 + WAL + 派生索引,
崩溃后可证明恢复。

## CLI

```sh
node src/cli.js [--dir=DIR] <command>

open <defectId> [--desc=...]        开缺陷(报废墓碑阻断重开)
rework <orderId> <defectId...>      将 open 缺陷合并进返工单
close <orderId> --result=pass|fail|scrap   复检闭环;pass 闭环 / fail 重回 open / scrap 墓碑
correct <orderId> --result=...      复检更正,只扩散到受影响序列(输出 impactSet)
undo <nodeId> [--reason=...]        仅未闭环节点可撤销,留审计;闭环后撤销 exit 21
crash-recover                       崩溃恢复(重放 WAL / 忽略半快照 / 重建索引)
verify                              校验 WAL 校验和 + 哈希链 + 索引
state                               打印当前状态
```

环境变量:`QCL_DIR`(状态目录,默认 `.qcl`)、`QCL_CRASH_AT`(故障注入)、
`QCL_OUT`/`QCL_ERR`(把 stdout/stderr 镜像到文件,供无法管道捕获的沙箱测试用)。

## 故障点与恢复定义

| 故障点 (`QCL_CRASH_AT`) | 位置 | 恢复结果 |
|---|---|---|
| `wal-append` | WAL 追加后未 fsync | 截断撕裂尾部,重放 WAL |
| `snapshot-rename` | 快照 rename 前 | 忽略(删除)半快照 `snapshot.json.tmp` |
| `index-update` | 索引更新后 | 从状态重建派生索引,不得双计 |

## 退出码

- `21` 闭环后撤销
- `22` WAL 校验和失败(非尾部记录)
- `23` 恢复前后状态哈希不一致(哈希链断裂)
- `99` 模拟崩溃(故障注入)
- `1` 一般业务错误(如报废后返工被墓碑阻断)

## 可证明恢复

每条 WAL 记录携带 `{seq, op, hash, crc}`:`crc` 是记录体的 crc32,
`hash` 是应用该操作后全量状态的 sha256(规范 JSON)。恢复时逐条重放并重算哈希链,
再与快照+尾部重放交叉验证;索引纯派生,重建幂等,不会双计。

## 测试

```sh
node --test     # 全量
```

- `test/machine.test.js` — ≤12 操作与参考状态机枚举对照(深度≤3 全枚举 + 300 条长度 12 的定种子随机游走)、报废墓碑、更正影响集、撤销规则
- `test/recovery.test.js` — 三故障点注入、exit 21/22/23
- `test/cli.test.js` — CLI 端到端
